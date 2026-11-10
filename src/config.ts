import { realpathSync, statSync } from 'node:fs';
import { isIPv4, isIPv6 } from 'node:net';

import { isMediaType } from './attachments.js';
import { MAILBOX_CONTROL_CHARS, MAX_LIMIT } from './schema.js';

/** How the IMAP connection is encrypted. */
export type TlsMode = 'implicit' | 'starttls' | 'none';

export interface ImapConfig {
  host: string | undefined;
  port: number;
  user: string | undefined;
  password: string | undefined;
  tls: TlsMode;
  insecureTls: boolean;
  /** Mailbox the message tools default to. */
  mailbox: string;
  /**
   * Custom IMAP keyword marking messages already handed to the model. Empty
   * means the feature is off and `list_new_messages` is not registered.
   */
  seenKeyword: string;
  /** Overrides the folder auto-detected from the \Drafts special-use flag. */
  draftsMailbox: string | undefined;
  /**
   * The authserv-id this account's own provider stamps into
   * Authentication-Results. Only a header carrying it is treated as
   * non-forgeable; unset, every SPF/DKIM/DMARC verdict is reported as forgeable,
   * because a sender can write that header too and nothing in the message
   * distinguishes theirs from the provider's.
   */
  trustedAuthservId: string | undefined;
  maxMessages: number;
  maxAttachmentBytes: number;
  allowedAttachmentTypes: string[];
  /**
   * Where attachments may be written. Unset means this server never touches the
   * filesystem — setting it is the opt-in, and it is the only source of the
   * target directory. A caller cannot choose where bytes from a stranger land.
   *
   * Stored as the resolved real path of a directory that existed at startup.
   * The value is printed by `get_server_info` and by every attachment listing,
   * and `IMAP_DOWNLOAD_DIR` sits a few lines below `IMAP_PASSWORD` in every
   * compose file — so a value that is not a directory is refused before it can
   * be printed anywhere, and the refusal describes it by length, never by
   * content.
   */
  downloadDir: string | undefined;
  maxDownloadBytes: number;
  /**
   * Ceiling on the bytes handed to the text-extraction worker.
   *
   * A third limit because it answers a third question. `maxAttachmentBytes`
   * bounds what may enter the model's context — extraction does not, since only
   * the extracted text comes back and `max_chars` bounds that. `maxDownloadBytes`
   * bounds what may be written to the filesystem. This one bounds how much
   * hostile input a parser is asked to chew on inside a thread that can be
   * terminated, which is a memory question and neither of the other two.
   */
  maxExtractBytes: number;
  /** How long one IMAP command may take before the call is abandoned. */
  commandTimeoutMs: number;
  /**
   * Ceiling on one attachment of a draft (`save_draft` with `attachments`),
   * whether its bytes arrive in the call or are copied from a message in the
   * mailbox. A separate limit from `maxAttachmentBytes`, which bounds what is
   * *read* into the model's context: this one bounds what is *written* into
   * a message a person will later send.
   */
  draftAttachmentMaxBytes: number;
  /** Ceiling on all attachments of one draft together. */
  draftMaxBytes: number;
}

export interface Config {
  imap: ImapConfig;
  /**
   * When true — the default — the mailbox write tools are not registered.
   *
   * Note the default, which is the opposite of every other server in this
   * family. This variable replaced `IMAP_ALLOW_WRITE`, and that one was opt-in:
   * setting nothing meant no write access to a mailbox. Renaming it without
   * keeping that default would have handed write access to every installation
   * that upgraded without reading the changelog. The name is now shared with
   * the rest of the family; the default deliberately is not.
   */
  readOnly: boolean;
  /**
   * Whether a client that *can* show a dialog is asked before a guarded tool
   * acts. `ELICITATION=false` turns the dialog off — the guard stays and falls
   * back to the two-call token, so there is no setting in which a guarded call
   * goes unannounced.
   */
  elicitation: boolean;

  /**
   * Raw value of `IMAP_ALLOW_TOOLS` — comma-separated tool names, `list_*`
   * prefixes, or `essential`. Kept unparsed on purpose: this file is a mirror
   * of the environment, and the names can only be checked against the tool
   * catalogue, which `buildToolFilter` does.
   */
  allowTools: string | undefined;
  /** Raw value of `IMAP_DENY_TOOLS`, same shape, subtracted from the above. */
  denyTools: string | undefined;
}

export const DEFAULT_ATTACHMENT_TYPES = [
  'application/pdf',
  'application/json',
  'application/xml',
  'application/zip',
  'application/rtf',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
  'text/html',
  'text/calendar',
];

const DEFAULT_MAX_MESSAGES = 100;
/** Inline cap: this one protects the model's context window. */
const DEFAULT_MAX_ATTACHMENT_BYTES = 1024 * 1024;
/** Disk cap: this one protects the filesystem, which is a different concern. */
const DEFAULT_MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
/** Extraction cap: how much hostile input one parser is asked to chew on. */
const DEFAULT_MAX_EXTRACT_BYTES = 10 * 1024 * 1024;
/**
 * Hard ceiling on `IMAP_MAX_EXTRACT_BYTES`.
 *
 * The other two size variables have no maximum because their cost is linear and
 * paid somewhere visible — a big result, a big file. This one buys a buffer
 * inside a parser working on bytes a stranger chose, so a typo of "104857600000"
 * would not produce a big answer, it would produce an operator who believes
 * there is a limit. 64 MiB is past any document that arrives by mail.
 */
const MAX_MAX_EXTRACT_BYTES = 64 * 1024 * 1024;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 30;
/** Per draft attachment. Two megabytes is a photo or a scanned page. */
const DEFAULT_DRAFT_ATTACHMENT_MAX_BYTES = 2 * 1024 * 1024;
/** All attachments of one draft together. */
const DEFAULT_DRAFT_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Hard ceiling on both draft limits. The whole draft is built in memory before
 * the APPEND, and most providers refuse a message above 25 to 50 MB anyway.
 */
const MAX_DRAFT_BYTES = 64 * 1024 * 1024;
/** Refused above, not clamped: a value typed in milliseconds must not become hours. */
const MAX_COMMAND_TIMEOUT_SECONDS = 600;
const DEFAULT_SEEN_KEYWORD = 'AiSeen';
/** A hostname is at most 253 characters; an IPv6 literal far fewer. */
const MAX_HOST_LENGTH = 253;
/** IMAP allows 255 bytes of mailbox name; the tool parameter says the same. */
const MAX_MAILBOX_LENGTH = 255;
/** Matches the `keyword` tool parameter, which is the other place one is typed. */
const MAX_KEYWORD_LENGTH = 64;
const MAX_ATTACHMENT_TYPES = 64;

/**
 * The rule the `mailbox` tool parameter applies, imported rather than spelled
 * again: a second copy of a control-character class is how two of them drift.
 */
const CONTROL_CHARS = MAILBOX_CONTROL_CHARS;

/** Shown when the configuration is incomplete — at startup and on every call. */
export function missingConfigMessage(missing: string[]): string {
  return (
    `missing required environment variable(s): ${missing.join(', ')}\n` +
    'Required: IMAP_HOST (e.g. imap.example.net), IMAP_USER, IMAP_PASSWORD\n' +
    'Optional: IMAP_PORT, IMAP_TLS (implicit|starttls|none), IMAP_MAILBOX, ' +
    'IMAP_SEEN_KEYWORD, IMAP_READ_ONLY=false to expose the mailbox write ' +
    'tools (it defaults to true), IMAP_ALLOW_TOOLS / IMAP_DENY_TOOLS to narrow ' +
    'the tool list, IMAP_DOWNLOAD_DIR to allow saving attachments to disk, ' +
    'IMAP_INSECURE_TLS=true to accept self-signed certificates'
  );
}

/** Names of the required environment variables that are unset in `config`. */
export function missingConfigKeys(config: Config): string[] {
  return [
    !config.imap.host && 'IMAP_HOST',
    !config.imap.user && 'IMAP_USER',
    !config.imap.password && 'IMAP_PASSWORD',
  ].filter((v): v is string => Boolean(v));
}

/**
 * Reads the configuration from environment variables.
 *
 * Missing credentials are only a warning, not a fatal error: the server must be
 * able to complete the MCP handshake and answer `tools/list` without them, so
 * registries and sandbox inspectors can introspect it. Malformed values still
 * exit — a host with a newline in it could smuggle a second command into the
 * IMAP session, and a bad port would connect somewhere unintended.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Empty counts as unset, as it does for every other variable: compose files
  // write `${VAR:-}`, and an empty host used to end the process where a
  // missing one only warns.
  const rawHost = env.IMAP_HOST || undefined;
  const user = env.IMAP_USER;
  const password = env.IMAP_PASSWORD;

  // Removed here, before any branch below can return or exit, so that child
  // processes do not inherit it. This does not reach /proc/<pid>/environ:
  // the kernel serves that from the block the process started with, and a
  // process of the same user can still read it there.
  delete env.IMAP_PASSWORD;

  const tls = parseTlsMode(env.IMAP_TLS);
  // After the password delete, deliberately: this one can exit the process, and
  // an exit above the delete would leave the password in the environment for
  // whatever runs next.
  const elicitation = parseElicitation(env.ELICITATION);

  const host =
    rawHost === undefined ? undefined : normalizeHost(rawHost, 'IMAP_HOST');
  // A user name is written into a LOGIN command and into the From header of
  // every draft. Neither tolerates a line break, and neither is a place for a
  // value that was meant for the line above it.
  if (user !== undefined) assertSingleLine(user, 'IMAP_USER');
  const mailbox = env.IMAP_MAILBOX || 'INBOX';
  assertMailboxName(mailbox, 'IMAP_MAILBOX');
  const draftsMailbox = env.IMAP_DRAFTS_MAILBOX?.trim() || undefined;
  if (draftsMailbox !== undefined) {
    assertMailboxName(draftsMailbox, 'IMAP_DRAFTS_MAILBOX');
  }
  const trustedAuthservId = env.IMAP_TRUSTED_AUTHSERV_ID?.trim() || undefined;
  if (trustedAuthservId !== undefined && !isSafeHost(trustedAuthservId)) {
    // Not even its length: CodeQL reads any trace of this value as a credential.
    console.error(
      'imap-mcp: IMAP_TRUSTED_AUTHSERV_ID must be a plain hostname or IP ' +
        'address without scheme, port, credentials or whitespace'
    );
    process.exit(1);
  }

  const config: Config = {
    imap: {
      host,
      port: parsePort(
        env.IMAP_PORT,
        tls === 'implicit' ? 993 : 143,
        'IMAP_PORT'
      ),
      user,
      password,
      tls,
      insecureTls: env.IMAP_INSECURE_TLS === 'true',
      mailbox,
      seenKeyword: parseKeyword(env.IMAP_SEEN_KEYWORD),
      draftsMailbox,
      trustedAuthservId,
      // The same ceiling as the `limit` parameter: the default page must not
      // be the one way past the documented hard cap.
      maxMessages: parseCount(
        env.IMAP_MAX_MESSAGES,
        DEFAULT_MAX_MESSAGES,
        'IMAP_MAX_MESSAGES',
        MAX_LIMIT
      ),
      maxAttachmentBytes: parseCount(
        env.IMAP_MAX_ATTACHMENT_BYTES,
        DEFAULT_MAX_ATTACHMENT_BYTES,
        'IMAP_MAX_ATTACHMENT_BYTES'
      ),
      allowedAttachmentTypes: parseTypes(env.IMAP_ATTACHMENT_TYPES),
      downloadDir: parseDownloadDir(env.IMAP_DOWNLOAD_DIR),
      maxDownloadBytes: parseCount(
        env.IMAP_MAX_DOWNLOAD_BYTES,
        DEFAULT_MAX_DOWNLOAD_BYTES,
        'IMAP_MAX_DOWNLOAD_BYTES'
      ),
      maxExtractBytes: parseCount(
        env.IMAP_MAX_EXTRACT_BYTES,
        DEFAULT_MAX_EXTRACT_BYTES,
        'IMAP_MAX_EXTRACT_BYTES',
        MAX_MAX_EXTRACT_BYTES
      ),
      commandTimeoutMs:
        parseCount(
          env.IMAP_COMMAND_TIMEOUT_SECONDS,
          DEFAULT_COMMAND_TIMEOUT_SECONDS,
          'IMAP_COMMAND_TIMEOUT_SECONDS',
          MAX_COMMAND_TIMEOUT_SECONDS
        ) * 1000,
      draftAttachmentMaxBytes: parseCount(
        env.IMAP_ATTACHMENT_MAX_BYTES,
        DEFAULT_DRAFT_ATTACHMENT_MAX_BYTES,
        'IMAP_ATTACHMENT_MAX_BYTES',
        MAX_DRAFT_BYTES
      ),
      draftMaxBytes: parseCount(
        env.IMAP_DRAFT_MAX_BYTES,
        DEFAULT_DRAFT_MAX_BYTES,
        'IMAP_DRAFT_MAX_BYTES',
        MAX_DRAFT_BYTES
      ),
    },
    // Defaults to true, unlike the rest of the family — see the field comment.
    readOnly: env.IMAP_READ_ONLY !== 'false',
    elicitation,
    allowTools: env.IMAP_ALLOW_TOOLS,
    denyTools: env.IMAP_DENY_TOOLS,
  };

  // Silently ignoring a removed security variable is the worst of the options:
  // whoever set it once believes it is still in force. IMAP_ALLOW_WRITE=true
  // used to be the only way to reach the write tools, so an installation that
  // still sets it is one that wants them — and would otherwise get a read-only
  // server without being told why.
  if (env.IMAP_ALLOW_WRITE !== undefined) {
    console.error(
      'imap-mcp: IMAP_ALLOW_WRITE has been replaced by IMAP_READ_ONLY. Set ' +
        'IMAP_READ_ONLY=false for the write tools, or unset IMAP_ALLOW_WRITE ' +
        'to keep the read-only default.'
    );
    process.exit(1);
  }

  const missing = missingConfigKeys(config);
  if (missing.length > 0) {
    console.error(`imap-mcp: ${missingConfigMessage(missing)}`);
  }
  if (config.imap.tls === 'none' && !isLoopbackHost(host)) {
    console.error(
      'imap-mcp: WARNING: IMAP_TLS=none against a non-local host — the password ' +
        'and every message will cross the network unencrypted.'
    );
  }

  return config;
}

function parseTlsMode(raw: string | undefined): TlsMode {
  if (raw === undefined || raw === '') return 'implicit';
  if (raw === 'implicit' || raw === 'starttls' || raw === 'none') return raw;
  console.error('imap-mcp: IMAP_TLS must be one of implicit, starttls or none');
  process.exit(1);
}

/**
 * Reads `ELICITATION` — deliberately unprefixed, and deliberately fatal on
 * anything it does not recognise.
 *
 * Unprefixed: environment variables are process-wide, so this is one switch for
 * every server in the same environment. That is also its risk, which is why a
 * server started with it off says so on its startup line.
 *
 * Fatal, like `parseTlsMode` above and unlike `IMAP_READ_ONLY`: this is the
 * first variable of the family that defaults to *on*, so a typo that fell back
 * to the default would leave the dialog running while the operator believes it
 * is off — and an operator who believes that has no way to find out.
 */
export function parseElicitation(raw: string | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '' || value === 'true') return true;
  if (value === 'false') return false;
  // Described, not quoted. The variable is unprefixed and sits in the same
  // block as IMAP_PASSWORD in every compose file; what lands in it by mistake
  // is exactly the value that must not be printed into the client's log.
  console.error(
    `imap-mcp: ELICITATION must be "true" or "false" — got ${describeValue(raw ?? '')}. ` +
      'Refusing to start rather than guess.'
  );
  process.exit(1);
}

/**
 * A configuration value for an error message: its length and nothing else.
 *
 * Every variable this file reads has a neighbour that is a secret, and the
 * value that fails a shape check is the one most likely to be that neighbour.
 */
/**
 * A plain decimal integer, or undefined. `Number()` also takes `0x3e1`,
 * `1e3`, `+5` and `993.0`, and reads past the integers it can represent.
 */
function decimal(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!/^[0-9]{1,15}$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
}

function describeValue(raw: string): string {
  return `a ${raw.length}-character value`;
}

function parsePort(
  raw: string | undefined,
  fallback: number,
  name: string
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = decimal(raw);
  if (value === undefined || value < 1 || value > 65535) {
    // The value itself is not echoed: config errors end up in logs.
    console.error(`imap-mcp: ${name} must be an integer between 1 and 65535`);
    process.exit(1);
  }
  return value;
}

function parseCount(
  raw: string | undefined,
  fallback: number,
  name: string,
  max?: number
): number {
  if (raw === undefined || raw === '') return fallback;
  const value = decimal(raw);
  if (value === undefined || value < 1) {
    console.error(`imap-mcp: ${name} must be a positive integer`);
    process.exit(1);
  }
  if (max !== undefined && value > max) {
    // The limit is named rather than clamped to: an operator who asked for more
    // than the server will do should learn that here, not from a refusal later
    // that looks like the document was the problem.
    console.error(`imap-mcp: ${name} must not exceed ${max}`);
    process.exit(1);
  }
  return value;
}

/**
 * An IMAP keyword is an atom: no spaces and none of the characters that would
 * end it early or open a literal. Empty turns the new-mail tracking off.
 */
function parseKeyword(raw: string | undefined): string {
  if (raw === undefined) return DEFAULT_SEEN_KEYWORD;
  if (raw === '') return '';
  // Bounded like the `keyword` tool parameter. The value is written into a
  // tool description and into every `get_server_info` answer, so a length has
  // to be a length and not whatever was pasted.
  if (raw.length > MAX_KEYWORD_LENGTH || !/^[A-Za-z0-9$_.-]+$/.test(raw)) {
    console.error(
      'imap-mcp: IMAP_SEEN_KEYWORD must consist of letters, digits, $, _, . or -, ' +
        `at most ${MAX_KEYWORD_LENGTH} of them (got ${describeValue(raw)})`
    );
    process.exit(1);
  }
  return raw;
}

/**
 * The attachment allowlist, one media type per entry.
 *
 * Every entry is answered back by `get_server_info` as `allowed_attachment_types`
 * and compared against what messages declare. An entry that is not shaped like
 * a media type can never match an attachment, so it is either a typo or a value
 * meant for another variable — and in both cases the operator should hear
 * about it at startup rather than read it in a tool result.
 */
function parseTypes(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_ATTACHMENT_TYPES;
  const entries = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t !== '');
  // "," is as empty as "": an allowlist of nothing would block every
  // attachment in a way nobody asked for.
  if (entries.length === 0) return DEFAULT_ATTACHMENT_TYPES;
  if (entries.length > MAX_ATTACHMENT_TYPES) {
    console.error(
      `imap-mcp: IMAP_ATTACHMENT_TYPES lists ${entries.length} entries; at most ${MAX_ATTACHMENT_TYPES} are accepted`
    );
    process.exit(1);
  }
  const bad = entries.findIndex((entry) => !isMediaType(entry));
  if (bad >= 0) {
    console.error(
      `imap-mcp: IMAP_ATTACHMENT_TYPES entry ${bad + 1} is not a media type ` +
        `such as application/pdf (got ${describeValue(entries[bad] as string)})`
    );
    process.exit(1);
  }
  return entries;
}

/**
 * The download directory, resolved and checked before anything can print it.
 *
 * The path is answered by `get_server_info` and by every attachment listing,
 * so it has to be a path — an existing directory, resolved through symlinks so
 * that the containment check in `download.ts` compares against the place files
 * really land. A value that is not a directory ends the process, and the
 * message says how long it was, not what it said.
 */
function parseDownloadDir(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  let resolved: string;
  try {
    resolved = realpathSync(trimmed);
    if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
  } catch {
    console.error(
      'imap-mcp: IMAP_DOWNLOAD_DIR must name an existing directory ' +
        `(got ${describeValue(trimmed)} that does not resolve to one). ` +
        'Create it first, or unset the variable to keep this server off the filesystem.'
    );
    process.exit(1);
  }
  return resolved;
}

/**
 * Rejects anything that could break out of the line it is written on. IMAP is a
 * line protocol; a CR or LF in a hostname is a command-smuggling primitive, not
 * a typo.
 */
/**
 * The host as the socket wants it: an IPv6 literal without its brackets, which
 * `net.connect` does not accept — `[::1]` used to pass the check here and then
 * fail every connection with ENOTFOUND.
 */
function normalizeHost(value: string, name: string): string {
  const unbracketed = /^\[([^\]]*)\]$/.exec(value)?.[1];
  if (unbracketed !== undefined) {
    if (!isIPv6(unbracketed)) failHost(value, name);
    return unbracketed;
  }
  if (!isSafeHost(value)) failHost(value, name);
  return value;
}

function failHost(value: string, name: string): never {
  console.error(
    `imap-mcp: ${name} must be a plain hostname or IP address without ` +
      `scheme, port, credentials or whitespace (got ${describeValue(value)})`
  );
  process.exit(1);
}

function isSafeHost(value: string): boolean {
  // A hostname or IPv4 address — or an IPv6 address, which is the only place
  // a colon is legal. Allowing ":" everywhere would silently accept
  // "imap.example.net:993", which the error message promises to reject.
  // The length is checked first: nothing below walks a value longer than a
  // hostname can be.
  if (value.length > MAX_HOST_LENGTH) return false;
  return /^[A-Za-z0-9._-]+$/.test(value) || isIPv6(value);
}

/** Spaces are fine in a mailbox name; a line break would end the command. */
function assertSingleLine(value: string, name: string): void {
  if (/[\r\n]/.test(value)) {
    console.error(`imap-mcp: ${name} must not contain line breaks`);
    process.exit(1);
  }
}

/**
 * The rule the `mailbox` tool parameter enforces, for a name that arrives
 * through the environment instead: bounded, no control characters, no LIST
 * wildcards. The value is answered by every listing tool and printed on the
 * startup line, so it has to look like a folder before it is printed anywhere.
 */
function assertMailboxName(value: string, name: string): void {
  if (
    value.length > MAX_MAILBOX_LENGTH ||
    CONTROL_CHARS.test(value) ||
    /[%*]/.test(value)
  ) {
    console.error(
      `imap-mcp: ${name} must be a mailbox name of at most ${MAX_MAILBOX_LENGTH} ` +
        'characters without control characters or the wildcards % and * ' +
        `(got ${describeValue(value)})`
    );
    process.exit(1);
  }
}

function isLoopbackHost(hostname: string | undefined): boolean {
  // URL.hostname keeps the brackets around an IPv6 literal, may carry a %zone
  // suffix, and 'localhost.' with its root label is the same name as
  // 'localhost'. The comparison this replaced saw none of them — which is why
  // its bare '::1' branch could never match a hostname taken from a URL.
  if (hostname === undefined) return false;
  let host = hostname
    .toLowerCase()
    .replace(/^\[|]$/g, '')
    .replace(/%.*$/, '');
  // Trailing root labels, walked from the end rather than matched with `\.+$`:
  // that pattern is tried from every position of a run of dots and consumes
  // the run each time, which is quadratic. The host is bounded to 253
  // characters above, so this is a habit rather than a measured risk here —
  // the same pattern on an unbounded value is the measured one.
  let end = host.length;
  while (end > 0 && host[end - 1] === '.') end -= 1;
  host = host.slice(0, end);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    // An address, not a name: "127.mail.example.net" is a remote host.
    (isIPv4(host) && host.startsWith('127.')) ||
    host === '::1' ||
    // Every dual-stack client dials ::ffff:127.0.0.1 as plain 127.0.0.1, and
    // URL normalises the mapped form to hex (::ffff:7f00:1).
    /^::ffff:(?:7f[0-9a-f]{0,2}:|127\.)/.test(host)
  );
}
