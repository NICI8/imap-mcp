import { readdir } from 'node:fs/promises';
import { createConnection, createServer, type AddressInfo } from 'node:net';

import {
  expectEveryToolDeclaresOutputSchema,
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  tokenOf,
  type LiveHarness,
} from 'mcp-integration-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ALL_TOOLS } from '../../src/tools/catalogue.js';
import { bootstrap, SUBJECTS, type Sandbox } from './bootstrap.js';

/**
 * Every tool in the catalogue, against a real IMAP server in Docker.
 *
 * The unit tests drive an in-memory fake, so what they establish is that this
 * server handles the IMAP responses its author expected. Here the messages
 * were delivered over a real SMTP dialogue into a real store, so what the read
 * tools parse is an actual RFC 5322 message with actual MIME parts — and the
 * write tools talk to a server that has its own opinions about flags,
 * expunging and mailbox names.
 *
 * Order matters and state is shared: messages seeded once at the top are
 * flagged, moved and finally deleted further down.
 */

let sandbox: Sandbox;
/** Declares elicitation, so guarded tools go through the real dialog. */
let asking: LiveHarness;
/** Declares none, so the same tools fall back to the two-call token. */
let plain: LiveHarness;

function parse<T>(text: string): T {
  const start = text.indexOf('{');
  if (start === -1) throw new Error(`no JSON in result: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}

interface Listing {
  messages: { uid: number; subject: string; flags?: string[] }[];
}

/** The uid of a seeded message, by subject. */
async function uidOf(subject: string, mailbox = 'INBOX'): Promise<number> {
  const listed = parse<Listing>(
    await asking.call('list_messages', { mailbox, limit: 50 })
  );
  const found = listed.messages.find((m) => m.subject === subject);
  if (found === undefined) {
    throw new Error(
      `no message titled "${subject}" in ${mailbox}; saw ` +
        listed.messages.map((m) => m.subject).join(', ')
    );
  }
  return found.uid;
}

beforeAll(async () => {
  sandbox = await bootstrap();
  asking = await startServer({ env: sandbox.env, elicit: 'accept' });
  plain = await startServer({ env: sandbox.env });
}, 600_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

describe('the server and its mailboxes', () => {
  it('reports what this IMAP server can do', async () => {
    const info = await asking.call('get_server_info');
    expect(info).toContain('IMAP4rev1');
    // GreenMail advertises MOVE and UIDPLUS, which is what makes the move and
    // expunge paths take their fast branches rather than the fallbacks.
    expect(info).toContain('MOVE');
    expect(info).toContain('"write_tools_enabled": true');
    expect(info).toContain('"command_timeout_seconds": 60');
    // The password must not come back out.
    expect(info).not.toContain('integration-not-a-secret');
  });

  it('lists the mailboxes the account has', async () => {
    expect(await asking.call('list_mailboxes')).toContain('INBOX');
  });
});

describe('reading what was delivered', () => {
  it('lists the seeded messages', async () => {
    const listed = await asking.call('list_messages', { limit: 50 });
    for (const subject of sandbox.subjects) {
      expect(listed).toContain(subject);
    }
  });

  it('reads one in full, as it came off the wire', async () => {
    const uid = await uidOf(SUBJECTS.first);
    const message = await asking.call('get_message', { uid });
    expect(message).toContain(SUBJECTS.first);
    expect(message).toContain('sender@example.org');
    expect(message).toContain(`Body of "${SUBJECTS.first}"`);
  });

  it('frames the mailbox as untrusted, on every read', async () => {
    // Not decoration: anybody in the world can put a message in this mailbox,
    // so the preamble is what stops a subject line reading as an instruction.
    // It has to be on the real content, not only on the fixture.
    expect(await asking.call('list_messages', { limit: 5 })).toMatch(
      /^The following comes from the mailbox/
    );
  });

  it('answers what is new, and stops saying so once it has been read', async () => {
    const first = parse<Listing>(await asking.call('list_new_messages'));
    expect(first.messages.length).toBeGreaterThan(0);
    // The keyword this server sets is its own, not \Seen — reading a message
    // through a tool must not mark it read in somebody's mail client.
    const again = parse<Listing>(await asking.call('list_new_messages'));
    expect(again.messages).toHaveLength(0);
  });

  it('lists the parts of a real multipart message without fetching any', async () => {
    // Two calls by design: without a `part_id` the tool lists, so a model can
    // see the filenames and sizes before deciding to pull megabytes through
    // its own context. Nothing is fetched and nothing is written.
    const uid = await uidOf(SUBJECTS.attachment);
    const listed = parse<{
      attachments: { part_id: string; filename: string }[];
    }>(await asking.call('get_attachments', { uid }));
    expect(listed.attachments).toHaveLength(1);
    expect(listed.attachments[0]!.filename).toBe('report.txt');
    expect(await readdir(sandbox.downloadDir)).toHaveLength(0);
  });

  it('reads a small one inline, and writes it to disk when asked', async () => {
    const uid = await uidOf(SUBJECTS.attachment);
    const listed = parse<{ attachments: { part_id: string }[] }>(
      await asking.call('get_attachments', { uid })
    );
    const partId = listed.attachments[0]!.part_id;

    // "auto" reads small text inline: the bytes come back and nothing is
    // written, which is what makes the default safe for a shared machine.
    const inline = await asking.call('get_attachments', {
      uid,
      part_id: partId,
    });
    expect(inline).toContain('integration attachment');
    expect(await readdir(sandbox.downloadDir)).toHaveLength(0);

    // "file" is the half a fake cannot check: real bytes in the directory the
    // operator named, and nowhere else.
    await asking.call('get_attachments', {
      uid,
      part_id: partId,
      mode: 'file',
    });
    const files = await readdir(sandbox.downloadDir);
    expect(files.some((name) => name.includes('report'))).toBe(true);
  });

  it('reads a real PDF and a real .docx as text', async () => {
    // The only place the parsers see bytes that went through a real SMTP
    // dialogue, real base64 line wrapping and real IMAP decoding rather than a
    // Buffer handed to them in the same process.
    const uid = await uidOf(SUBJECTS.documents);
    const listed = parse<{
      attachments: {
        part_id: string;
        filename: string;
        extractable: boolean;
      }[];
    }>(await asking.call('get_attachments', { uid }));

    const documents = listed.attachments.filter((entry) => entry.extractable);
    expect(documents).toHaveLength(2);

    for (const [filename, expected] of [
      ['rechnung.pdf', 'Rechnung 1200,00 EUR'],
      ['vertrag.docx', 'Vertragsbeginn ist der 1. Oktober'],
    ]) {
      const part = documents.find((entry) => entry.filename === filename);
      expect(part, filename).toBeDefined();
      const text = await asking.call('get_attachments', {
        uid,
        part_id: part!.part_id,
        mode: 'text',
      });
      expect(text, filename).toContain(expected!);
      expect(text, filename).toContain('BEGIN UNTRUSTED EMAIL CONTENT');
    }

    // Reading a document is not a write, whatever the download directory says.
    const before = await readdir(sandbox.downloadDir);
    expect(before.some((name) => name.includes('rechnung'))).toBe(false);
  });
});

describe('flags, mailboxes and moving', () => {
  it('sets and clears a flag', async () => {
    const uid = await uidOf(SUBJECTS.first);
    await asking.call('set_message_flags', {
      uids: [uid],
      add: ['\\Flagged'],
    });
    const listed = parse<Listing>(
      await asking.call('list_messages', { limit: 50 })
    );
    expect(listed.messages.find((m) => m.uid === uid)?.flags).toContain(
      '\\Flagged'
    );

    await asking.call('set_message_flags', {
      uids: [uid],
      remove: ['\\Flagged'],
    });
    const after = parse<Listing>(
      await asking.call('list_messages', { limit: 50 })
    );
    expect(
      after.messages.find((m) => m.uid === uid)?.flags ?? []
    ).not.toContain('\\Flagged');
  });

  it('creates a mailbox, moves a message into it, and removes it again', async () => {
    await asking.call('manage_mailbox', {
      action: 'create',
      mailbox: 'Integration',
    });
    expect(await asking.call('list_mailboxes')).toContain('Integration');

    const uid = await uidOf(SUBJECTS.toMove);
    await asking.call('move_messages', {
      uids: [uid],
      destination: 'Integration',
    });

    // Gone from INBOX, present in the destination: a move is two operations
    // against a real server and only one of them is easy to get right.
    const inbox = parse<Listing>(
      await asking.call('list_messages', { limit: 50 })
    );
    expect(inbox.messages.map((m) => m.subject)).not.toContain(SUBJECTS.toMove);
    const moved = parse<Listing>(
      await asking.call('list_messages', {
        mailbox: 'Integration',
        limit: 50,
      })
    );
    expect(moved.messages.map((m) => m.subject)).toContain(SUBJECTS.toMove);

    await asking.call('manage_mailbox', {
      action: 'delete',
      mailbox: 'Integration',
    });
    expect(await asking.call('list_mailboxes')).not.toContain('Integration');
  });

  it('saves a draft into the drafts mailbox', async () => {
    await asking.call('manage_mailbox', {
      action: 'create',
      mailbox: 'Drafts',
    });
    await asking.call('save_draft', {
      to: ['someone@example.net'],
      subject: 'Integration draft',
      body: 'Written by the integration suite.',
    });
    const drafts = await asking.call('list_messages', {
      mailbox: 'Drafts',
      limit: 10,
    });
    expect(drafts).toContain('Integration draft');
  });

  it('saves a draft with an attachment from the call and one copied from a message', async () => {
    // A 1x1 PNG in the call, and the PDF of the documents message copied by
    // the server itself. Read back through get_attachments from the Drafts
    // folder, so what is checked is what GreenMail stored and parsed.
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    const source = await uidOf(SUBJECTS.documents);
    const listed = parse<{
      attachments: { part_id: string; filename: string }[];
    }>(await asking.call('get_attachments', { uid: source }));
    const pdf = listed.attachments.find((a) => a.filename === 'rechnung.pdf');
    expect(pdf).toBeDefined();

    const subject = 'Integration draft with attachments';
    const saved = parse<{
      attachments: { filename: string; source: string }[];
    }>(
      await asking.call('save_draft', {
        to: ['someone@example.net'],
        subject,
        body: 'Zwei Anhänge.',
        attachments: [
          {
            filename: 'pixel.png',
            content_type: 'image/png',
            data_base64: png,
          },
          { source_uid: source, part_id: pdf!.part_id },
        ],
      })
    );
    expect(saved.attachments.map((a) => a.source)).toEqual(['call', 'mailbox']);

    const draft = await uidOf(subject, 'Drafts');
    const stored = parse<{
      attachments: {
        part_id: string;
        filename: string;
        content_type: string;
      }[];
    }>(await asking.call('get_attachments', { uid: draft, mailbox: 'Drafts' }));
    expect(stored.attachments.map((a) => [a.filename, a.content_type])).toEqual(
      [
        ['pixel.png', 'image/png'],
        ['rechnung.pdf', 'application/pdf'],
      ]
    );

    // An image comes back as an image block, not as text.
    const picture = await asking.client.callTool({
      name: 'get_attachments',
      arguments: {
        uid: draft,
        mailbox: 'Drafts',
        part_id: stored.attachments[0]!.part_id,
        mode: 'inline',
      },
    });
    const image = (
      picture.content as Array<{ type: string; data?: string }>
    ).find((block) => block.type === 'image');
    expect(image?.data).toBe(png);

    const text = await asking.call('get_attachments', {
      uid: draft,
      mailbox: 'Drafts',
      part_id: stored.attachments[1]!.part_id,
      mode: 'text',
    });
    expect(text).toContain('Rechnung 1200,00 EUR');

    const listing = parse<Listing>(
      await asking.call('list_messages', { mailbox: 'Drafts', limit: 50 })
    );
    const entry = listing.messages.find((m) => m.subject === subject);
    expect(entry?.flags).toContain('\\Draft');
  });
});

describe('the fallback path for a client with no dialog', () => {
  it('expunges only after the token comes back', async () => {
    const listed = parse<Listing>(
      await plain.call('list_messages', { limit: 50 })
    );
    const target = listed.messages.find((m) => m.subject === SUBJECTS.toDelete);
    expect(target).toBeDefined();

    const refusal = await plain.call(
      'delete_messages',
      { uids: [target!.uid] },
      { expectError: /confirm_token=/ }
    );
    expect(refusal).toContain('confirm_token');
    expect(plain.prompts).toHaveLength(0);
    // Still there: the first call is a question.
    const before = parse<Listing>(
      await plain.call('list_messages', { limit: 50 })
    );
    expect(before.messages.map((m) => m.subject)).toContain(SUBJECTS.toDelete);

    await plain.call('delete_messages', {
      uids: [target!.uid],
      confirm_token: tokenOf(refusal),
    });
    const after = parse<Listing>(
      await plain.call('list_messages', { limit: 50 })
    );
    expect(after.messages.map((m) => m.subject)).not.toContain(
      SUBJECTS.toDelete
    );
  });

  it('asked a person on one harness and nobody on the other', () => {
    expect(asking.prompts.length).toBeGreaterThan(0);
    expect(plain.prompts).toHaveLength(0);
  });
});

describe('the refusals, against a server that would have obeyed', () => {
  it('will not mark a message \\Deleted through the flag tool', async () => {
    // set_message_flags has no confirmation, on the grounds that a flag comes
    // back off. \Deleted does not: the next client to close the mailbox, or any
    // server with autoexpunge, turns it into a removal. GreenMail is a real
    // server with a real EXPUNGE, so this is the refusal measured where it
    // matters. The reason is asserted, not just the failure — a renamed
    // argument would fail at the schema and look identical.
    const uid = await uidOf(SUBJECTS.second);
    await asking.call(
      'set_message_flags',
      { uids: [uid], add: ['\\Deleted'] },
      { expectError: 'Use delete_messages, which asks for confirmation' }
    );
    // Still there, and still not marked.
    const listed = parse<Listing>(
      await asking.call('list_messages', { limit: 50 })
    );
    const target = listed.messages.find((m) => m.uid === uid);
    expect(target?.flags ?? []).not.toContain('\\Deleted');
  });

  it('will not spend a confirmation token on a longer list than it was issued for', async () => {
    // The attack the resource key exists for: confirm deleting one message,
    // then call again with two. Bare `expectError: true` would pass here on a
    // schema error as readily as on the binding, so the sentence is the test.
    const listed = parse<Listing>(
      await plain.call('list_messages', { limit: 50 })
    );
    const [first, second] = listed.messages;
    // An error result: nothing was deleted, which is what `isError` says —
    // and a tool that declares an `outputSchema` may not answer without
    // `structuredContent` unless the result is an error.
    const refusal = await plain.call(
      'delete_messages',
      { uids: [first!.uid] },
      { expectError: /confirm_token=/ }
    );
    await plain.call(
      'delete_messages',
      { uids: [first!.uid, second!.uid], confirm_token: tokenOf(refusal) },
      { expectError: 'invalid, expired, or was issued for different arguments' }
    );
    // Nothing went: the whole point is that the widened set is not executed.
    const after = parse<Listing>(
      await plain.call('list_messages', { limit: 50 })
    );
    expect(after.messages.map((m) => m.uid)).toContain(first!.uid);
    expect(after.messages.map((m) => m.uid)).toContain(second!.uid);
  });

  it('refuses an executable extension the content type vouches for', async () => {
    // `application/xml` is in the allowlist and a ClickOnce manifest really is
    // XML, so the declaration check passes and the magic-byte check passes.
    // The extension is the only gate left — and it was reading `''` for
    // `appref-ms`, which makes checkPolicy skip the executable check rather
    // than fail it. With IMAP_DOWNLOAD_DIR set, that put the file on disk under
    // its own name and reported nothing unusual about it.
    const uid = await uidOf(SUBJECTS.executable);
    const listed = parse<{
      attachments: {
        part_id: string;
        filename: string;
        allowed: boolean;
        notes: string[];
      }[];
    }>(await asking.call('get_attachments', { uid }));
    const part = listed.attachments[0]!;
    expect(part.filename).toBe('Rechnung-2026.appref-ms');
    expect(part.allowed).toBe(false);
    expect(part.notes.join(' ')).toContain(
      '.appref-ms is an executable file type'
    );

    // The refusal is an error result: the tool was asked to fetch something
    // and did not. The reason is named rather than passing a bare `true`,
    // which a schema rejection would satisfy just as well.
    const fetched = await asking.call(
      'get_attachments',
      { uid, part_id: part.part_id },
      { expectError: 'is an executable file type' }
    );
    expect(fetched).toContain('Refused to fetch part');
    // And nothing reached the directory the operator named.
    const files = await readdir(sandbox.downloadDir);
    expect(files.some((name) => name.includes('Rechnung'))).toBe(false);
  });
});

/**
 * Sits between a server and GreenMail and holds back the first server answer
 * that matches `answer` once armed — the command has run, its reply has not
 * arrived — so a second call can be made while it is on the wire.
 */
async function holdingProxy(answer: RegExp, ms: number) {
  let armed = false;
  let caught!: () => void;
  const holding = new Promise<void>((resolve) => {
    caught = resolve;
  });
  const proxy = createServer((down) => {
    const up = createConnection({
      host: '127.0.0.1',
      port: Number(sandbox.env.IMAP_PORT),
    });
    let waiting = false;
    const queued: Buffer[] = [];
    down.on('data', (chunk) => up.write(chunk));
    up.on('data', (chunk: Buffer) => {
      if (!waiting && armed && answer.test(chunk.toString('latin1'))) {
        armed = false;
        waiting = true;
        queued.push(chunk);
        caught();
        setTimeout(() => {
          waiting = false;
          for (const held of queued.splice(0)) {
            if (!down.destroyed) down.write(held);
          }
        }, ms);
        return;
      }
      if (waiting) queued.push(chunk);
      else if (!down.destroyed) down.write(chunk);
    });
    const end = () => {
      down.destroy();
      up.destroy();
    };
    for (const socket of [down, up]) {
      socket.on('error', end);
      socket.on('close', end);
    }
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return {
    port: (proxy.address() as AddressInfo).port,
    arm: () => {
      armed = true;
    },
    holding,
    close: () => proxy.close(),
  };
}

describe('a call the client cancels, against a real imapflow', () => {
  // imapflow keeps one command on the wire and queues the others behind it. A
  // cancelled list_mailboxes whose LIST waited behind a save_draft's APPEND
  // used to close the shared connection; imapflow rejected the APPEND, which
  // had already been stored, and it was sent a second time.
  it('leaves exactly one draft when a listing queued behind it is cancelled', async () => {
    const proxy = await holdingProxy(/^\S+ OK[^\r\n]*APPEND/im, 2_000);
    const held = await startServer({
      env: { ...sandbox.env, IMAP_PORT: String(proxy.port) },
    });
    try {
      await held.call('list_mailboxes');
      const subject = `Cancelled listing ${Date.now()}`;
      proxy.arm();
      const draft = held.call('save_draft', {
        to: ['someone@example.net'],
        subject,
        body: 'Stored once.',
      });
      await proxy.holding;
      const controller = new AbortController();
      const listing = held.client
        .callTool(
          { name: 'list_mailboxes', arguments: {} },
          { signal: controller.signal }
        )
        .catch(() => 'cancelled');
      await new Promise((resolve) => setTimeout(resolve, 200));
      controller.abort();
      await Promise.all([draft, listing]);
      const drafts = parse<Listing>(
        await plain.call('list_messages', { mailbox: 'Drafts', limit: 50 })
      );
      expect(drafts.messages.filter((m) => m.subject === subject)).toHaveLength(
        1
      );
    } finally {
      await held.close();
      proxy.close();
    }
  });
});

it('declares an output schema on every tool', async () => {
  // The unit suite checks the same thing against a stub. Here it is checked
  // against the server that has just answered every one of these tools against
  // a real IMAP server — and each of those answers went through the SDK's
  // validation against the schema below it.
  const { tools } = await asking.client.listTools();
  expectEveryToolDeclaresOutputSchema(tools);
});

it('exercises every tool in the catalogue', () => {
  const called = new Set([...asking.called, ...plain.called]);
  const report = toolCoverage({ called }, ALL_TOOLS, {});
  console.log(
    `imap-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real IMAP server`
  );
  expectEveryToolExercised({ called }, ALL_TOOLS, {});
});
