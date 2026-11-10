import { randomUUID } from 'node:crypto';

import MailComposer from 'nodemailer/lib/mail-composer';

import {
  checkPolicy,
  collectAttachments,
  describeExecutable,
  EXECUTABLE_EXTENSIONS,
  extensionOf,
  isMediaType,
  sanitizeFilename,
  sniffContent,
} from './attachments.js';
import type { Config } from './config.js';
import { fromIsAddress, type DraftInput } from './draft.js';
import { ToolInputError } from './errors.js';
import type { ImapConnection } from './imap.js';
import { downloadCapped } from './stream.js';

/** The most attachments one draft may carry. */
export const MAX_DRAFT_ATTACHMENTS = 20;

/** An attachment whose bytes arrive in the tool call. */
export interface InlineAttachmentInput {
  filename: string;
  content_type: string;
  data_base64: string;
}

/** An attachment copied from a message already in the mailbox. */
export interface MailboxAttachmentInput {
  source_uid: number;
  part_id: string;
  mailbox?: string | undefined;
}

export type DraftAttachmentInput =
  InlineAttachmentInput | MailboxAttachmentInput;

/** A resolved attachment, ready for the MIME builder. */
export interface DraftAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

/** What the result reports about each attachment. */
export interface AttachmentSummary {
  filename: string;
  content_type: string;
  bytes: number;
  source: 'call' | 'mailbox';
  source_uid?: number;
  part_id?: string;
  mailbox?: string;
}

export function isMailboxAttachment(
  input: DraftAttachmentInput
): input is MailboxAttachmentInput {
  return 'source_uid' in input;
}

/**
 * Makes a caller-supplied filename safe to put in Content-Disposition.
 *
 * Any directory part is dropped first — `../../etc/passwd` and
 * `C:\\Users\\x\\a.pdf` become `passwd` and `a.pdf` — and the rest goes through
 * the same sanitiser that every attachment name read from a message goes
 * through: control and invisible characters removed, characters that mean
 * something to a file system replaced, the length capped with the extension
 * kept.
 */
export function draftFilename(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? '';
  const cleaned = sanitizeFilename(base);
  if (cleaned === '(unnamed)') {
    throw new ToolInputError(
      'imap-mcp: an attachment needs a filename with at least one visible character.'
    );
  }
  return cleaned;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Decodes and checks an attachment whose bytes came with the call.
 *
 * Everything here is refused rather than repaired: the result is a file in a
 * message a person will send under their own name, and a silently changed
 * file is worse than an error the caller can act on.
 */
export function inlineAttachment(
  input: InlineAttachmentInput,
  config: Config,
  index: number
): DraftAttachment {
  const where = `attachment ${index + 1}`;
  const filename = draftFilename(input.filename);
  const extension = extensionOf(filename);
  if (extension !== '' && EXECUTABLE_EXTENSIONS.has(extension)) {
    throw new ToolInputError(
      `imap-mcp: ${where}: .${extension} is an executable file type and is not attached.`
    );
  }

  const contentType = input.content_type.trim().toLowerCase();
  if (!isMediaType(contentType)) {
    throw new ToolInputError(
      `imap-mcp: ${where}: content_type must be a media type such as image/png.`
    );
  }
  if (!config.imap.allowedAttachmentTypes.includes(contentType)) {
    throw new ToolInputError(
      `imap-mcp: ${where}: content type ${contentType} is not in the allowlist (IMAP_ATTACHMENT_TYPES).`
    );
  }

  const data = input.data_base64.replace(/\s+/g, '');
  if (data.length === 0 || data.length % 4 !== 0 || !BASE64.test(data)) {
    throw new ToolInputError(
      `imap-mcp: ${where}: data_base64 is not valid base64 (standard alphabet, padded, no data: prefix).`
    );
  }
  const content = Buffer.from(data, 'base64');
  if (content.length > config.imap.draftAttachmentMaxBytes) {
    throw new ToolInputError(
      `imap-mcp: ${where}: ${content.length} bytes exceeds IMAP_ATTACHMENT_MAX_BYTES (${config.imap.draftAttachmentMaxBytes}).`
    );
  }
  refuseExecutableBytes(content, where);
  return { filename, contentType, content };
}

/**
 * Fetches one attachment of a message in the mailbox, to copy it into a draft.
 *
 * The part has to be one that `get_attachments` lists for that message, and it
 * has to pass the same declaration policy: an arbitrary part id would let a
 * caller lift the text body, or a part the policy refuses, into a draft. The
 * bytes stay on this server; they never pass through the tool call.
 */
export async function mailboxAttachment(
  connection: ImapConnection,
  input: MailboxAttachmentInput,
  config: Config,
  maxBytes: number,
  limitName: string,
  fetchStructure: (
    connection: ImapConnection,
    uid: number
  ) => Promise<Parameters<typeof collectAttachments>[0]>
): Promise<DraftAttachment> {
  const uid = input.source_uid;
  const what = `part ${input.part_id} of message ${uid}`;
  const structure = await fetchStructure(connection, uid);
  const candidate = collectAttachments(structure)
    .map((found) =>
      checkPolicy(found, {
        allowedTypes: config.imap.allowedAttachmentTypes,
        maxBytes,
        maxBytesName: limitName,
      })
    )
    .find((found) => found.partId === input.part_id);
  if (candidate === undefined) {
    throw new ToolInputError(
      `imap-mcp: message ${uid} has no attachment with part id ${input.part_id}. ` +
        'Call get_attachments without part_id to see the available parts.'
    );
  }
  if (!candidate.allowed) {
    throw new ToolInputError(
      `imap-mcp: ${what} is not attached:\n- ${candidate.notes.join('\n- ')}`
    );
  }
  const { buffer } = await downloadCapped(
    connection,
    uid,
    candidate.partId,
    maxBytes,
    config.imap.commandTimeoutMs
  );
  if (buffer === undefined) {
    throw new ToolInputError(
      `imap-mcp: ${what} exceeds ${limitName} (${maxBytes}). The declared size was ${candidate.size ?? 'not stated'}.`
    );
  }
  refuseExecutableBytes(buffer, what);
  return {
    filename: candidate.filename,
    contentType: candidate.contentType,
    content: buffer,
  };
}

function refuseExecutableBytes(content: Buffer, where: string): void {
  const verdict = sniffContent(content);
  if (verdict.executable) {
    throw new ToolInputError(
      `imap-mcp: ${where}: the bytes are ${describeExecutable(verdict)}, whatever the declared type. Not attached.`
    );
  }
}

/**
 * Builds a multipart/mixed draft: the text part first, then every attachment
 * with `Content-Disposition: attachment` and base64 transfer encoding.
 *
 * The MIME structure is nodemailer's MailComposer, not hand-written: boundaries,
 * RFC 2231 filenames and header encoding are exactly where a home-made builder
 * goes wrong in one mail client and not another. File and URL access are off,
 * so an attachment can only ever be the bytes handed in. Bcc is kept, because
 * a draft is not a sent message: the person sending it has to see who is on it.
 */
export async function buildDraftWithAttachments(
  input: DraftInput,
  attachments: DraftAttachment[]
): Promise<Buffer> {
  const from = input.from;
  if (from === undefined || from === '') {
    throw new ToolInputError(
      'imap-mcp: no sender address available — IMAP_USER is not set.'
    );
  }
  const composer = new MailComposer({
    ...(fromIsAddress(from) ? { from } : {}),
    to: input.to,
    ...(input.cc !== undefined && input.cc.length > 0 ? { cc: input.cc } : {}),
    ...(input.bcc !== undefined && input.bcc.length > 0
      ? { bcc: input.bcc }
      : {}),
    subject: input.subject,
    date: input.date ?? new Date(),
    messageId: `<${randomUUID()}@imap-mcp.invalid>`,
    ...(input.thread?.messageId !== undefined
      ? { inReplyTo: input.thread.messageId }
      : {}),
    ...(input.thread !== undefined && input.thread.references.length > 0
      ? { references: input.thread.references }
      : {}),
    // base64 for the body, as in the plain-text draft: it survives any
    // charset and cannot hold a line that looks like a MIME boundary.
    text: {
      content: input.body.replace(/\r\n|\r|\n/g, '\r\n'),
      contentTransferEncoding: 'base64',
    },
    // Encoded-words in base64 for a non-ASCII subject or name.
    textEncoding: 'B',
    disableFileAccess: true,
    disableUrlAccess: true,
    attachments: attachments.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
      contentDisposition: 'attachment' as const,
      contentTransferEncoding: 'base64' as const,
    })),
  });
  const node = composer.compile();
  node.keepBcc = true;
  return node.build();
}
