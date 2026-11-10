import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { confirmationPrompt, setResourceKey } from 'mcp-approval';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import {
  addressListParam,
  confirmTokenParam,
  flagListParam,
  mailboxParam,
  optionalMailboxParam,
  uidListParam,
  uidParam,
} from '../schema.js';

import { escapeInvisible, sanitizeText, stripInvisible } from '../analyze.js';
import { audit, auditedWrite } from '../audit.js';
import type { Config } from '../config.js';
import { ToolInputError } from '../errors.js';
import {
  canStoreFlag,
  ImapClient,
  requireOk,
  withTimeout,
  type ImapConnection,
} from '../imap.js';
import { buildDraft, fromIsAddress } from '../draft.js';
import {
  buildDraftWithAttachments,
  inlineAttachment,
  isMailboxAttachment,
  mailboxAttachment,
  MAX_DRAFT_ATTACHMENTS,
  type AttachmentSummary,
  type DraftAttachment,
  type DraftAttachmentInput,
} from '../draft-attachments.js';
import { fetchOne } from './read.js';
import { untrustedFields } from '../output-schema.js';
import { errorResult, jsonResult, run, untrustedResult } from '../result.js';

/** The longest mailbox name `mailboxParam` lets through. */
const MAILBOX_NAME_MAX = 255;

/**
 * Whether two mailbox names are the same mailbox. INBOX is the one name IMAP
 * defines as case-insensitive (RFC 3501); every other name is compared as is.
 */
function sameMailbox(a: string, b: string): boolean {
  return withoutInboxCase(a) === withoutInboxCase(b);
}

function withoutInboxCase(name: string): string {
  return name.toUpperCase() === 'INBOX' ? 'INBOX' : name;
}

/**
 * Refuses a delete, or a move on a server without MOVE, that would take
 * messages nobody asked about with it.
 *
 * Without UIDPLUS (RFC 4315) imapflow can only send a bare EXPUNGE, which
 * removes every message in the mailbox flagged \Deleted — including those
 * another client flagged and has not expunged yet. The dialog named the
 * approved UIDs and nothing else, so the approval would cover more than it
 * said. A move on a server without MOVE is COPY, flag, EXPUNGE and has the same
 * reach. Servers with UIDPLUS (or, for a move, MOVE) address the UIDs exactly
 * and are not asked.
 */
async function refuseStrayDeleted(
  client: ImapClient,
  connection: ImapConnection,
  approved: number[],
  operation: 'delete' | 'move'
): Promise<void> {
  const capabilities = connection.capabilities;
  const exact =
    capabilities.has('UIDPLUS') ||
    (operation === 'move' && capabilities.has('MOVE'));
  if (exact) return;
  const flagged = await client.search(connection, { deleted: true }, 'throw');
  const wanted = new Set(approved);
  const stray = flagged.filter((uid) => !wanted.has(uid));
  if (stray.length === 0) return;
  throw new ToolInputError(
    `imap-mcp: this server supports neither UIDPLUS${operation === 'move' ? ' nor MOVE' : ''}, ` +
      `so ${operation === 'move' ? 'moving' : 'deleting'} these messages would also permanently ` +
      `remove ${stray.length} other message(s) in this mailbox that another mail client has ` +
      `already flagged \\Deleted (UIDs ${stray.slice(0, 20).join(', ')}${stray.length > 20 ? ', …' : ''}). ` +
      'Nothing was changed. Expunge those in your mail client first, or clear ' +
      'their \\Deleted flag with set_message_flags (remove ["\\Deleted"]) if they ' +
      'should stay, then call again.'
  );
}

/**
 * A caller-chosen value as the person deciding should see it.
 *
 * mcp-approval already keeps these off the server's own sentence and onto their
 * own labelled line, which answers a name that reads like an instruction. It
 * cannot answer a name that reads like a *different name*: `Archive` and
 * `Archive<U+200B>` occupy the same space on a screen, so a dialog that renders
 * the second one verbatim asks about the folder the person recognises and then
 * acts on the one they do not. Here the invisible characters are removed from
 * what is shown and spelled out beside it, so the answer is to the question
 * that was actually asked.
 */
function shownValue(raw: string): string {
  const visible = stripInvisible(raw);
  return visible === raw
    ? raw
    : `${visible} — as written: ${escapeInvisible(raw)}`;
}

export function registerWriteTools(
  server: McpServer,
  client: ImapClient,
  config: Config,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'set_message_flags',
    {
      title: 'Add or remove message flags',
      description:
        'Adds or removes IMAP flags and keywords on one or more messages: ' +
        '\\Seen to mark read or unread, \\Flagged to star, \\Answered, \\Draft, ' +
        'or any custom keyword the server accepts. Reversible, so no ' +
        'confirmation is required — which is why \\Deleted cannot be added ' +
        'here; use delete_messages, which asks first. Removing \\Deleted is ' +
        'allowed, since that undoes one. Removing the new-mail keyword makes ' +
        'those messages show up in list_new_messages again.',
      inputSchema: z.object({
        uids: uidListParam,
        mailbox: optionalMailboxParam,
        add: flagListParam.optional().describe('Flags or keywords to set.'),
        remove: flagListParam
          .optional()
          .describe('Flags or keywords to clear.'),
      }),
      annotations: {
        // A flag is a marker and comes back off, so this is not destructive.
        // freshrss-mcp answers the opposite for mark_articles and is right
        // to: FreshRSS keeps no record of what was unread, IMAP does.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        mailbox: z.string(),
        uids: z.array(z.number().int()),
        added: z.array(z.string()),
        removed: z.array(z.string()),
      }),
    },
    async ({ uids, mailbox, add, remove }, mcp) =>
      run(async () => {
        if (add === undefined && remove === undefined) {
          throw new ToolInputError(
            'imap-mcp: give at least one of "add" or "remove".'
          );
        }
        // \Deleted is not a flag like the others: it is half of a deletion.
        // This tool has no confirmation and is annotated destructiveHint:false
        // on the grounds that everything it does can be undone — true of \Seen
        // and \Flagged, not of a flag that the next client to close the folder,
        // or any server with autoexpunge, turns into a permanent removal. Left
        // open it is delete_messages without the dialog, reachable in one call
        // and present in the `essential` preset.
        if (add?.some((flag) => flag.toLowerCase() === '\\deleted')) {
          throw new ToolInputError(
            'imap-mcp: \\Deleted cannot be added here — it marks messages for ' +
              'permanent removal, which the next client to close the mailbox ' +
              'may carry out. Use delete_messages, which asks for confirmation. ' +
              'Moving them to a Trash folder with move_messages is usually what ' +
              'is meant instead.'
          );
        }
        return client.withMailbox(
          mailbox,
          false,
          mcp.mcpReq.signal,
          async (connection) => {
            // imapflow drops a flag the mailbox does not list in PERMANENTFLAGS
            // and still answers as if it had been set. Refuse before anything is
            // written, so the result never claims a flag that is not there.
            const permanentFlags =
              connection.mailbox === false
                ? undefined
                : connection.mailbox.permanentFlags;
            const refused = (add ?? []).filter(
              (flag) => !canStoreFlag(permanentFlags, flag)
            );
            if (refused.length > 0) {
              throw new ToolInputError(
                `imap-mcp: this mailbox does not store ${refused.join(', ')}, so ` +
                  'nothing was changed. Call get_server_info for the flags it ' +
                  'does support.'
              );
            }
            const source = mailbox ?? client.defaultMailbox;
            const details = {
              mailbox: source,
              uids,
              added: add,
              removed: remove,
            };
            await auditedWrite('set_flags', details, async () => {
              if (add !== undefined) {
                requireOk(
                  await withTimeout(
                    connection.messageFlagsAdd(uids, add, { uid: true }),
                    'STORE',
                    client.commandTimeoutMs
                  ),
                  'STORE',
                  connection
                );
              }
              if (remove !== undefined) {
                requireOk(
                  await withTimeout(
                    connection.messageFlagsRemove(uids, remove, { uid: true }),
                    'STORE',
                    client.commandTimeoutMs
                  ),
                  'STORE',
                  connection
                );
              }
            });
            audit('set_flags', {
              mailbox: source,
              uids,
              added: add,
              removed: remove,
            });
            return jsonResult({
              mailbox: source,
              uids,
              added: add ?? [],
              removed: remove ?? [],
            });
          }
        );
      })
  );

  server.registerTool(
    'move_messages',
    {
      title: 'Move or copy messages',
      description:
        'Moves messages to another mailbox, or copies them when mode is ' +
        '"copy". Both ask the user to confirm; where the client cannot show a ' +
        'prompt, they fall back to a two-call token — call once to receive it, ' +
        'then again with that token and the same UID list and destination.',
      inputSchema: z.object({
        uids: uidListParam,
        destination: mailboxParam.describe(
          'Mailbox the messages end up in, exactly as listed by list_mailboxes.'
        ),
        mailbox: optionalMailboxParam,
        mode: z
          .enum(['move', 'copy'])
          .optional()
          .describe(
            '"move" (default) removes the originals, "copy" keeps them.'
          ),
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        // Destructive: the messages keep their content but get new UIDs, so
        // every reference to the old ones stops working. Copying into a shared
        // folder is the irreversible half — it cannot be unread.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: z.object({
        action: z.enum(['moved', 'copied']),
        source: z.string(),
        destination: z.string(),
        uids: z.array(z.number().int()),
        unconfirmed_uids: z
          .array(z.number().int())
          .optional()
          .describe(
            'Present when the server confirmed new UIDs for fewer messages than were named.'
          ),
        note: z.string().optional(),
      }),
    },
    async ({ uids, destination, mailbox, mode, confirm_token }, mcp) =>
      run(async () => {
        const copying = mode === 'copy';
        const source = mailbox ?? client.defaultMailbox;
        // Before the dialog: a copy onto itself duplicates every message, and
        // a move onto itself on a server without MOVE is COPY, flag and
        // EXPUNGE, which recreates each message under a new UID.
        if (sameMailbox(source, destination)) {
          throw new ToolInputError(
            'imap-mcp: the destination is the mailbox the messages are already ' +
              'in. Nothing was changed; name another mailbox.'
          );
        }
        if (!copying) {
          await client.withMailbox(
            mailbox,
            true,
            mcp.mcpReq.signal,
            (connection) => refuseStrayDeleted(client, connection, uids, 'move')
          );
        }
        // Copying is confirmed as well. The old rule — a token for "move",
        // nothing for "copy" — reasoned about deletion, and deletion is not the
        // only thing that cannot be taken back. `destination` is a free-form
        // mailbox name, so on a shared account or a public namespace one
        // unconfirmed call hands every named message to everyone with access to
        // that folder. Disclosure is the irreversible part, and copying is the
        // mode that does it while leaving no trace in the source folder.
        //
        // Which is also why this now goes the whole way rather than only to the
        // token: the token proves the call was made twice, and a disclosure
        // that cannot be taken back is exactly the case where the model
        // agreeing with itself is not enough.
        //
        // The key covers the exact UID set and both mailboxes: a confirmation
        // for [1] must not execute [1, 2], where the model picked the second
        // list, and one for Archive must not execute against Public/Shared.
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `${copying ? 'copy' : 'move'} ${uids.length} message(s) between mailboxes`,
            consequence: copying
              ? 'Everyone with access to the destination can read the copies, and taking them back does not unsee them.'
              : 'The messages keep their content but get new UIDs, so the current ones stop working.',
            // The two names are JSON-encoded rather than joined with ':'. A
            // mailbox name may contain ':' — the parameter allows it on
            // purpose, see schema.ts — and with a bare join the pair
            // ("A:B", "C") and the pair ("A", "B:C") produced the same key, so
            // a token or sealed answer issued for one would have executed the
            // other, a pair nobody was ever asked about.
            resourceKey: setResourceKey(
              `${copying ? 'copy_messages' : 'move_messages'}:${JSON.stringify([source, destination])}`,
              uids.map(String)
            ),
            token: confirm_token,
            details: [
              { label: 'From', value: shownValue(source) },
              { label: 'To', value: shownValue(destination) },
            ],
            // The tool the fallback prompt tells the caller to call again.
            // It used to say `copy_messages` for the copy mode — a name the
            // catalogue does not have, so a client without a dialog was told
            // to call a tool that does not exist. The mode stays distinct in
            // the resource key above, which is what keeps a copy approval
            // from executing a move.
            toolName: 'move_messages',
          }
        );
        if (outcome.decision === 'rejected') {
          throw new ToolInputError(`imap-mcp: ${outcome.reason}`);
        }
        if (outcome.decision === 'declined') {
          throw new ToolInputError(
            'imap-mcp: the user declined. Nothing was moved.'
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        return client.withMailbox(
          mailbox,
          false,
          mcp.mcpReq.signal,
          async (connection) => {
            if (!copying) {
              await refuseStrayDeleted(client, connection, uids, 'move');
            }
            const result = await auditedWrite(
              copying ? 'copy' : 'move',
              { from: source, to: destination, uids },
              async () =>
                copying
                  ? requireOk(
                      await withTimeout(
                        connection.messageCopy(uids, destination, {
                          uid: true,
                        }),
                        'COPY',
                        client.commandTimeoutMs
                      ),
                      'COPY',
                      connection
                    )
                  : requireOk(
                      await withTimeout(
                        connection.messageMove(uids, destination, {
                          uid: true,
                        }),
                        'MOVE',
                        client.commandTimeoutMs
                      ),
                      'MOVE',
                      connection
                    )
            );
            // A UID map smaller than the set means the server acted on fewer
            // messages than were named: the rest were gone already. Servers
            // without UIDPLUS send no map, and then nothing can be said.
            const wanted = [...new Set(uids)];
            const unconfirmed =
              result.uidMap === undefined
                ? []
                : wanted.filter((uid) => !result.uidMap?.has(uid));
            audit(copying ? 'copy' : 'move', {
              from: source,
              to: destination,
              uids,
              ...(result.uidMap === undefined
                ? {}
                : { confirmed: result.uidMap.size }),
            });
            return jsonResult({
              action: copying ? 'copied' : 'moved',
              source,
              destination,
              uids,
              ...(unconfirmed.length === 0
                ? {}
                : {
                    unconfirmed_uids: unconfirmed,
                    note:
                      `The server confirmed ${wanted.length - unconfirmed.length} of ` +
                      `${wanted.length} message(s) as ${copying ? 'copied' : 'moved'}. The others ` +
                      'were probably already gone or moved by another client; ' +
                      'list_messages shows what is where.',
                  }),
            });
          }
        );
      })
  );

  server.registerTool(
    'delete_messages',
    {
      title: 'Delete messages',
      description:
        'Permanently deletes messages: sets \\Deleted and expunges them. On ' +
        'most servers this does not go to Trash — move them there instead if ' +
        'that is what is meant. Asks the user to confirm; where the client ' +
        'cannot show a prompt, it falls back to a two-call token.',
      inputSchema: z.object({
        uids: uidListParam,
        mailbox: optionalMailboxParam,
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        // Expunged, not moved to Trash. Idempotent by the specification's
        // wording — the second call finds nothing, and the world is the same.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        action: z.literal('deleted'),
        mailbox: z.string(),
        uids: z.array(z.number().int()),
      }),
    },
    async ({ uids, mailbox, confirm_token }, mcp) =>
      run(async () => {
        const source = mailbox ?? client.defaultMailbox;
        // Before the dialog, so nobody is asked to approve what would then be
        // refused; checked again below, where it is the last word.
        await client.withMailbox(
          mailbox,
          true,
          mcp.mcpReq.signal,
          (connection) => refuseStrayDeleted(client, connection, uids, 'delete')
        );
        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what: `Permanently delete ${uids.length} message(s) (UIDs ${uids.slice(0, 20).join(', ')}${uids.length > 20 ? ', …' : ''})`,
            consequence:
              'The messages are expunged, not moved to Trash. They cannot be recovered from here.',
            resourceKey: setResourceKey(
              `delete_messages:${source}`,
              uids.map(String)
            ),
            token: confirm_token,
            toolName: 'delete_messages',
            details: [{ label: 'Mailbox', value: shownValue(source) }],
          }
        );
        if (outcome.decision === 'rejected') {
          throw new ToolInputError(`imap-mcp: ${outcome.reason}`);
        }
        if (outcome.decision === 'declined') {
          throw new ToolInputError(
            'imap-mcp: the user declined. Nothing was changed.'
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        return client.withMailbox(
          mailbox,
          false,
          mcp.mcpReq.signal,
          async (connection) => {
            await refuseStrayDeleted(client, connection, uids, 'delete');
            await auditedWrite('delete', { mailbox: source, uids }, async () =>
              requireOk(
                await withTimeout(
                  connection.messageDelete(uids, { uid: true }),
                  'EXPUNGE',
                  client.commandTimeoutMs
                ),
                'EXPUNGE',
                connection
              )
            );
            audit('delete', { mailbox: source, uids });
            return jsonResult({ action: 'deleted', mailbox: source, uids });
          }
        );
      })
  );

  server.registerTool(
    'manage_mailbox',
    {
      title: 'Create, rename or delete a mailbox',
      description:
        'Creates a folder, renames one, or deletes one. Deleting asks the user ' +
        'to confirm and takes every message in the folder with it; renaming ' +
        'uses the two-call token because it is reversible.',
      inputSchema: z.object({
        action: z
          .enum(['create', 'rename', 'delete'])
          .describe('What to do with the mailbox.'),
        mailbox: mailboxParam.describe(
          'The mailbox to create, rename or delete.'
        ),
        new_name: mailboxParam
          .optional()
          .describe('Required for "rename": the full new path.'),
        confirm_token: confirmTokenParam,
      }),
      annotations: {
        // Destructive in its delete mode, which takes every message in the
        // folder; create and rename are the additive ones. One tool, so the
        // annotation has to describe its strongest mode.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        action: z.enum(['create', 'rename', 'delete']),
        mailbox: z.string(),
        new_name: z.string().optional(),
        already_existed: z
          .boolean()
          .optional()
          .describe(
            '"create" found the mailbox there already; nothing was made.'
          ),
        note: z.string().optional(),
      }),
    },
    async ({ action, mailbox, new_name, confirm_token }, mcp) =>
      run(async () => {
        if (action === 'rename' && new_name === undefined) {
          throw new ToolInputError(
            'imap-mcp: "rename" needs new_name — the full new mailbox path.'
          );
        }

        if (action === 'delete') {
          const outcome = await approval.requestApproval(
            server,
            mcp,
            confirmations,
            {
              what: 'Delete a mailbox',
              consequence:
                'Every message in the folder is deleted with it, and it cannot be recovered from here.',
              resourceKey: `manage_mailbox:delete:${mailbox}`,
              token: confirm_token,
              toolName: 'manage_mailbox',
              details: [{ label: 'Mailbox', value: shownValue(mailbox) }],
            }
          );
          if (outcome.decision === 'rejected') {
            throw new ToolInputError(`imap-mcp: ${outcome.reason}`);
          }
          if (outcome.decision === 'declined') {
            throw new ToolInputError(
              'imap-mcp: the user declined. Nothing was changed.'
            );
          }
          if (outcome.decision === 'pending') return outcome.result;
        } else if (action === 'rename') {
          // JSON-encoded for the same reason as the move key above: a ':' in
          // either name must not let two different renames share a token.
          const key = `manage_mailbox:rename:${JSON.stringify([mailbox, new_name ?? ''])}`;
          if (!confirmations.consume(key, confirm_token)) {
            // An error result, like `mcp-approval`'s own prompt: the rename
            // was asked for and did not happen. It is also what lets this tool
            // declare an output schema — the SDK requires `structuredContent`
            // from a tool that has one, and a prompt has none to give.
            return errorResult(
              confirmationPrompt({
                what: 'rename a mailbox',
                token: confirmations.issue(key),
                ttlMinutes: confirmations.ttlMinutes,
                consequence:
                  'Clients that cached the old path will have to resynchronise.',
                details: [
                  { label: 'Mailbox', value: shownValue(mailbox) },
                  { label: 'New name', value: shownValue(new_name ?? '') },
                ],
                toolName: 'manage_mailbox',
              })
            );
          }
        }

        const details = { mailbox, new_name };
        return client.withConnection(mcp.mcpReq.signal, async (connection) => {
          if (action === 'create') {
            const created = await auditedWrite(
              'mailbox_create',
              details,
              async () =>
                requireOk(
                  await withTimeout(
                    connection.mailboxCreate(mailbox),
                    'CREATE',
                    client.commandTimeoutMs
                  ),
                  'CREATE',
                  connection
                )
            );
            // imapflow turns ALREADYEXISTS into a normal answer. Nothing was
            // made, so there is nothing to put in the audit log either.
            if (!created.created) {
              return jsonResult({
                action,
                mailbox,
                already_existed: true,
                note: 'This mailbox already existed, so nothing was created.',
              });
            }
          } else if (action === 'rename') {
            await auditedWrite('mailbox_rename', details, () =>
              withTimeout(
                connection.mailboxRename(mailbox, new_name as string),
                'RENAME',
                client.commandTimeoutMs
              )
            );
          } else {
            await auditedWrite('mailbox_delete', details, () =>
              withTimeout(
                connection.mailboxDelete(mailbox),
                'DELETE',
                client.commandTimeoutMs
              )
            );
          }
          audit(`mailbox_${action}`, { mailbox, new_name });
          return jsonResult({
            action,
            mailbox,
            ...(new_name === undefined ? {} : { new_name }),
          });
        });
      })
  );

  server.registerTool(
    'save_draft',
    {
      title: 'Save a draft',
      description:
        'Composes a plain-text message and stores it in the Drafts folder. ' +
        'This server cannot send mail — the draft waits in the mailbox until a ' +
        'person opens it in their own mail client and sends it from there. ' +
        'That is deliberate: it keeps the composing useful while leaving the ' +
        'decision to send with a human. Optional attachments come either as ' +
        'base64 in the call ({filename, content_type, data_base64}) or are ' +
        'copied by this server from a message in the mailbox ({source_uid, ' +
        'part_id, mailbox?}, part ids as get_attachments lists them), so ' +
        'their bytes never pass through the call. Limits are in get_server_info.',
      inputSchema: z.object({
        to: addressListParam,
        cc: addressListParam.optional(),
        bcc: addressListParam.optional(),
        subject: z
          .string()
          .max(500)
          .refine((v) => !/[\r\n]/.test(v), 'must not contain line breaks')
          .describe('Subject line.'),
        body: z
          .string()
          .min(1)
          .max(100_000)
          .describe('Plain-text body of the message.'),
        reply_to_uid: uidParam
          .optional()
          .describe(
            'UID of the message being answered; threads the draft through In-Reply-To and References.'
          ),
        mailbox: optionalMailboxParam.describe(
          'Where to look for reply_to_uid. Defaults to the configured mailbox.'
        ),
        attachments: z
          .array(
            z.union([
              z
                .object({
                  filename: z
                    .string()
                    .min(1)
                    .max(255)
                    .describe(
                      'File name shown to the recipient. Any path is dropped.'
                    ),
                  content_type: z
                    .string()
                    .min(3)
                    .max(255)
                    .describe(
                      'Media type, e.g. image/png. Must be in IMAP_ATTACHMENT_TYPES.'
                    ),
                  data_base64: z
                    .string()
                    .min(4)
                    .max(base64Ceiling(config.imap.draftAttachmentMaxBytes))
                    .describe('The file, standard base64 (no data: prefix).'),
                })
                .strict(),
              z
                .object({
                  source_uid: uidParam.describe(
                    'UID of the message the attachment is copied from.'
                  ),
                  part_id: z
                    .string()
                    .min(1)
                    .max(64)
                    .regex(
                      /^[0-9]+(\.[0-9]+)*$/,
                      'must be a MIME part number such as 2 or 1.2'
                    )
                    .describe('Part id as get_attachments lists it.'),
                  mailbox: optionalMailboxParam.describe(
                    'Mailbox of source_uid. Defaults to the configured mailbox.'
                  ),
                })
                .strict(),
            ])
          )
          .max(MAX_DRAFT_ATTACHMENTS)
          .optional()
          .describe(
            'Files to attach. The draft becomes multipart/mixed; without attachments it stays plain text.'
          ),
      }),
      annotations: {
        // Additive: it appends a message to the drafts folder. Two calls
        // leave two drafts.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      outputSchema: z.object({
        ...untrustedFields,
        action: z.literal('draft_saved'),
        mailbox: z
          .string()
          .describe(
            'The Drafts folder, exactly as the server spelled it: the handle other tools take. Not sanitised; read display_name.'
          ),
        display_name: z
          .string()
          .describe(
            'The same folder name, sanitised. Read and quote this one.'
          ),
        name_warning: z
          .string()
          .optional()
          .describe('Present when mailbox and display_name differ invisibly.'),
        recipients: z.array(z.string()),
        flags: z
          .array(z.string())
          .describe('The flags the draft was stored with.'),
        attachments: z
          .array(
            z.object({
              filename: z.string(),
              content_type: z.string(),
              bytes: z.number().int(),
              source: z.enum(['call', 'mailbox']),
              source_uid: z.number().int().optional(),
              part_id: z.string().optional(),
              mailbox: z.string().optional(),
            })
          )
          .optional()
          .describe(
            "What was attached, in order. Filenames are the sender's or the caller's; sanitised."
          ),
        note: z.string(),
      }),
    },
    async (
      { to, cc, bcc, subject, body, reply_to_uid, mailbox, attachments },
      mcp
    ) =>
      run(async () => {
        const signal = mcp.mcpReq.signal;
        // Calls' own bytes are checked first: they cost nothing to refuse,
        // and a draft that cannot be built should not first fetch anything.
        const resolved = await resolveAttachments(
          client,
          config,
          attachments ?? [],
          signal
        );
        const thread =
          reply_to_uid === undefined
            ? undefined
            : await client.threadHeaders(mailbox, reply_to_uid, signal);

        const input = {
          from: client.user,
          to,
          ...(cc === undefined ? {} : { cc }),
          ...(bcc === undefined ? {} : { bcc }),
          subject,
          body,
          ...(thread === undefined ? {} : { thread }),
        };
        const draft =
          resolved.length === 0
            ? buildDraft(input)
            : await buildDraftWithAttachments(
                input,
                resolved.map((entry) => entry.attachment)
              );

        const folder = await resolveDraftsMailbox(client, config, signal);
        // Selected read-write, not just connected: imapflow keeps only the
        // flags the selected mailbox lists in PERMANENTFLAGS, and a lock
        // released after a read-only call leaves that mailbox EXAMINEd, where
        // the list is empty and \Draft and \Seen would be dropped silently.
        const flags = await client.withMailbox(
          folder,
          false,
          signal,
          async (connection) => {
            // A Drafts folder that does not store a flag still takes the
            // draft — the text is what matters — but the result says so.
            const permanentFlags =
              connection.mailbox === false
                ? undefined
                : connection.mailbox.permanentFlags;
            const kept = ['\\Draft', '\\Seen'].filter((flag) =>
              canStoreFlag(permanentFlags, flag)
            );
            const details = {
              mailbox: folder,
              recipients: to.length + (cc?.length ?? 0) + (bcc?.length ?? 0),
              in_reply_to: thread?.messageId,
              ...(resolved.length === 0
                ? {}
                : {
                    attachments: resolved.length,
                    attachment_bytes: resolved.reduce(
                      (sum, entry) => sum + entry.attachment.content.length,
                      0
                    ),
                  }),
            };
            await auditedWrite('save_draft', details, () =>
              withTimeout(
                connection.append(folder, draft, kept),
                'APPEND',
                client.commandTimeoutMs
              )
            );
            // Here, not after the call: a call cancelled now has still stored the draft.
            audit('save_draft', details);
            return kept;
          }
        );
        const dropped = ['\\Draft', '\\Seen'].filter(
          (flag) => !flags.includes(flag)
        );
        // The folder name is the server's, or a colleague's on a shared
        // account: it goes back the way list_mailboxes returns one, the exact
        // handle beside a sanitised copy, under the untrusted marker, and never
        // inside a sentence of this server's own.
        const display = sanitizeText(folder, MAILBOX_NAME_MAX);
        return untrustedResult({
          action: 'draft_saved',
          mailbox: folder,
          display_name: display,
          ...(display === folder
            ? {}
            : {
                name_warning:
                  'This folder name contains invisible, control or auto-fetching ' +
                  `characters. As written: ${escapeInvisible(folder).slice(0, MAILBOX_NAME_MAX)}`,
              }),
          recipients: [...to, ...(cc ?? []), ...(bcc ?? [])],
          flags,
          ...(resolved.length === 0
            ? {}
            : { attachments: resolved.map((entry) => entry.summary) }),
          note:
            'The draft is stored but not sent. This server has no way to send mail; open it in your mail client to send it.' +
            (dropped.length === 0
              ? ''
              : ` The Drafts folder does not store ${dropped.join(' or ')}, so the draft was saved without it; some mail clients may then not list it as a draft.`) +
            (fromIsAddress(client.user ?? '')
              ? ''
              : ' The IMAP login is not an email address, so the draft has no From header; the mail client sets the sender when it is sent.'),
        });
      })
  );
}

/** The longest base64 text that can decode to `bytes`, with room for line breaks. */
function base64Ceiling(bytes: number): number {
  const encoded = Math.ceil(bytes / 3) * 4;
  return encoded + Math.ceil(encoded / 64) * 2 + 16;
}

/**
 * Turns the `attachments` argument into checked bytes, in the order given.
 *
 * Inline attachments are decoded and checked before anything is fetched.
 * Mailbox attachments are then fetched one by one, each with a ceiling of the
 * smaller of the per-attachment limit and what is left of the per-draft limit,
 * so a draft cannot be pushed past IMAP_DRAFT_MAX_BYTES by its last part.
 */
async function resolveAttachments(
  client: ImapClient,
  config: Config,
  inputs: DraftAttachmentInput[],
  signal: AbortSignal | undefined
): Promise<Array<{ attachment: DraftAttachment; summary: AttachmentSummary }>> {
  const out: Array<
    { attachment: DraftAttachment; summary: AttachmentSummary } | undefined
  > = inputs.map(() => undefined);
  let total = 0;
  const overTotal = (bytes: number): ToolInputError =>
    new ToolInputError(
      `imap-mcp: the attachments of this draft come to more than IMAP_DRAFT_MAX_BYTES (${config.imap.draftMaxBytes}); at least ${bytes} bytes. Nothing was saved.`
    );

  inputs.forEach((input, index) => {
    if (isMailboxAttachment(input)) return;
    const attachment = inlineAttachment(input, config, index);
    total += attachment.content.length;
    if (total > config.imap.draftMaxBytes) throw overTotal(total);
    out[index] = {
      attachment,
      summary: {
        filename: attachment.filename,
        content_type: attachment.contentType,
        bytes: attachment.content.length,
        source: 'call',
      },
    };
  });

  for (const [index, input] of inputs.entries()) {
    if (!isMailboxAttachment(input)) continue;
    const remaining = config.imap.draftMaxBytes - total;
    if (remaining <= 0) throw overTotal(total + 1);
    const perFile = config.imap.draftAttachmentMaxBytes;
    const [maxBytes, limitName] =
      remaining < perFile
        ? [remaining, 'what IMAP_DRAFT_MAX_BYTES leaves for it']
        : [perFile, 'IMAP_ATTACHMENT_MAX_BYTES'];
    const path = input.mailbox ?? client.defaultMailbox;
    const attachment = await client.withMailbox(
      input.mailbox,
      true,
      signal,
      (connection) =>
        mailboxAttachment(
          connection,
          input,
          config,
          maxBytes,
          limitName,
          async (conn, uid) =>
            (
              await fetchOne(conn, uid, client.commandTimeoutMs, {
                uid: true,
                bodyStructure: true,
              })
            ).bodyStructure
        )
    );
    total += attachment.content.length;
    out[index] = {
      attachment,
      summary: {
        filename: attachment.filename,
        content_type: attachment.contentType,
        bytes: attachment.content.length,
        source: 'mailbox',
        source_uid: input.source_uid,
        part_id: input.part_id,
        mailbox: path,
      },
    };
  }
  return out.filter((entry) => entry !== undefined);
}

/**
 * Finds the Drafts folder.
 *
 * The `\\Drafts` special-use flag is the right answer where the server reports
 * it, because folder names are localised — "Entwürfe", "Brouillons" — and
 * guessing wrong creates a stray folder rather than failing loudly.
 *
 * Only a role the server itself asserted counts. imapflow also assigns roles by
 * matching folder *names*, in every namespace the account can see, so on a
 * shared account a colleague's `Public/Drafts` can be picked for the draft —
 * and a draft of the account holder's mail then sits where others read it.
 * `IMAP_DRAFTS_MAILBOX` is the answer for a server that sends no SPECIAL-USE.
 */
async function resolveDraftsMailbox(
  client: ImapClient,
  config: Config,
  signal: AbortSignal | undefined
): Promise<string> {
  if (config.imap.draftsMailbox !== undefined) {
    return config.imap.draftsMailbox;
  }
  const found = (await client.listMailboxRoles(signal)).find(
    (box) =>
      box.specialUse === '\\Drafts' &&
      box.selectable &&
      (box.specialUseSource === 'extension' || box.specialUseSource === 'user')
  );
  if (found === undefined) {
    throw new ToolInputError(
      'imap-mcp: this account does not advertise a \\Drafts folder. Call ' +
        'list_mailboxes to find the right one and set IMAP_DRAFTS_MAILBOX to it. ' +
        '(A folder that only looks like Drafts by its name is not used.)'
    );
  }
  return found.path;
}
