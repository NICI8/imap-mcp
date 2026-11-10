# Tools

Eleven tools: six read, five write. The write tools are **not registered** unless
`IMAP_READ_ONLY=false` — and it defaults to `true`, so an unconfigured server offers
the six read tools alone.

Beyond that, `IMAP_ALLOW_TOOLS` and `IMAP_DENY_TOOLS` narrow the list further, and
`IMAP_ALLOW_TOOLS=essential` selects the six marked **essential** below — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

## Read tools

Registered always.

| Tool                | Description                                                                                              |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| `list_mailboxes`    | The folder tree, with the special-use flags the server reports (`\Drafts`, `\Sent`, …). **essential**     |
| `list_new_messages` | What the assistant has not seen yet, tracked with its own IMAP keyword rather than `\Seen`. **essential** |
| `list_messages`     | Search and list a mailbox: by sender, subject, date range, flags, or a Gmail query. **essential**        |
| `get_message`       | One message, body fenced as untrusted content. **essential**                                             |
| `get_attachments`   | Attachment metadata, small ones inline, and the text of a PDF or Office file with `mode: "text"`         |
| `get_server_info`   | Capabilities, the mailbox in use, and whether the write tools are registered                             |

## Write tools

Registered only when `IMAP_READ_ONLY=false`.

| Tool                   | Description                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `set_message_flags`    | Set or clear flags and keywords — read, flagged, and the assistant's own. **essential**  |
| `move_messages` 👤     | Move or copy messages between folders. **essential**                                     |
| `delete_messages` 👤   | Delete: sets `\Deleted` and expunges. Not the same as moving to Trash                    |
| `save_draft`           | Append a draft, optionally with attachments, to the drafts folder. Never **sends**       |
| `manage_mailbox` 👤    | Create, rename and delete folders — 👤 for `delete`, 🔒 for `rename`, nothing for `create` |

👤 **asks a person** through MCP elicitation, a dialog the model cannot answer on its
behalf. 🔒 uses the two-call `confirm_token` only. Where a 👤 tool's client cannot show
a dialog it falls back to 🔒, and `ELICITATION=false` takes that fallback deliberately.
See [Asking a person](/guide/approval).

Every tool declares an `outputSchema` and answers with `structuredContent` beside
the text block, so a client can use a result without parsing prose. Every tool
that reports anything out of the mailbox carries `untrusted: true` and
`source: "imap"` as fields — only `get_server_info` and the five write tools are
without it. `get_message` and a text attachment keep the nonce fence in the text
block and state the same fields in the structured half; an image attachment
keeps its bytes in the content block rather than repeating the base64.

Every tool declares all four MCP annotations — `readOnlyHint`, `destructiveHint`,
`idempotentHint`, `openWorldHint`. `get_attachments` carries the only *computed* one in
the family: it is `readOnlyHint: true` until `IMAP_DOWNLOAD_DIR` is set, because from
then on it writes files.

## Native Gmail search

`list_messages` accepts an optional `gmail_query` for Gmail's native search
syntax, for example:

```json
{
  "gmail_query": "has:attachment filename:pdf after:2024/01/01",
  "limit": 20
}
```

The server must advertise `X-GM-EXT-1`; otherwise the tool returns an error
without running a search. The query is passed through ImapFlow as `X-GM-RAW`,
combined with the other filters using AND, and restricted to the selected
mailbox. A query such as `in:anywhere` does not expand that mailbox selection.
Queries must be nonblank, at most 256 characters, and contain no CR, LF or NUL.
The existing summary-only results and `offset`/`next_offset` pagination apply.
`get_server_info` lists the server's capabilities, so whether `X-GM-EXT-1` is there
can be checked first. To search the whole account rather than one label, pass the
folder `list_mailboxes` reports with the special-use flag `\All` as `mailbox` — it
is `[Gmail]/All Mail` in English and has a localized name in other languages, such
as `[Gmail]/Alle Nachrichten`. Gmail does not refuse a malformed query — it ignores
what it cannot parse, so `from:` or an unbalanced `(` on its own matches every
message in the folder. A query a server does refuse comes back as an error, not as
zero matches.
This exposes Gmail's search syntax; it does not add semantic search or guarantee
that a broad query will be fast.

See [Google's IMAP extensions](https://developers.google.com/workspace/gmail/imap/imap-extensions#extension_of_the_search_command_x-gm-raw).

## Conversations

`get_message` with `include_thread: true` lists the conversation the message
belongs to, newest first and at most 50; when there are more, `thread_truncated`
says how many. Only messages in the selected mailbox are listed — select the
`\All` folder on Gmail to see sent replies and archived mail as well.

On Gmail (`X-GM-EXT-1`) the conversation is Gmail's own, the one its web interface
shows, found with a single `X-GM-THRID` search. That is also the fast path: on a
large All Mail folder the header search below can take longer than a client waits,
and Gmail's header search does not always find a message that names the original
in its `References`. Everywhere else the conversation is rebuilt from the
`Message-ID`, `References` and `In-Reply-To` chain of the message. A thread id that
does not look like one, or a thread search that comes back empty, falls back to
that chain.

## Reading a document

`get_attachments` takes a `mode`. `auto` reads small text and images inline, saves to
disk where `IMAP_DOWNLOAD_DIR` is set, and otherwise extracts the text of a PDF, Word,
Excel, PowerPoint or OpenDocument file. `inline` always returns the content, `file`
always saves it, and `text` always extracts.

`mode: "text"` is the only way to read a document from a client that cannot reach this
server's filesystem — which is every remote one. It returns the text fenced as untrusted
content, with `offset` and `max_chars` to page through anything longer than one result
can hold; the answer carries `next_offset`, `total_chars` and `returned_chars`, and the
notes spell out the exact follow-up call. The listing marks each part `extractable`, so
the choice can be made before anything is fetched.

Spreadsheets come back as tab-separated values with a `== Sheet: name ==` heading per
tab; presentations get a heading per slide.

There is no OCR. A scanned PDF has no text layer, and the refusal says so and names the
two ways to get the bytes instead — rather than returning an empty string that reads
like an empty document.

## Resources

Attachments are also exposed as MCP **resources**, at
`imap://message/{uid}/part/{partId}` for the default mailbox and
`imap://message/{uid}/part/{partId}?mailbox=…` for any other. They follow
`get_attachments`: when the tool filter leaves that tool out, the resources are not
registered either. `IMAP_DOWNLOAD_DIR` and the attachment type allowlist constrain
them like the tool, and an image is labelled with the type of its bytes. Note that
resources carry the raw bytes: the text extraction above is on the tool only, because
extracted text is the sender's text and belongs inside the nonce fence, which a resource
has nowhere to put.
