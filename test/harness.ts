import {
  Client,
  InMemoryTransport,
  withInputRequired,
} from '@modelcontextprotocol/client';
import { CallToolResultSchema } from '@modelcontextprotocol/core';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { CallToolResult } from '@modelcontextprotocol/client';

import type { Config } from '../src/config.js';
import { DEFAULT_ATTACHMENT_TYPES } from '../src/config.js';
import { createServer } from '../src/server.js';
import { FakeImap, message, type FakeMailbox } from './fake-imap.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    imap: {
      host: 'imap.example.net',
      port: 993,
      user: 'me@example.net',
      password: 'secret',
      tls: 'implicit',
      insecureTls: false,
      mailbox: 'INBOX',
      seenKeyword: 'AiSeen',
      draftsMailbox: undefined,
      trustedAuthservId: undefined,
      maxMessages: 100,
      maxAttachmentBytes: 1024 * 1024,
      allowedAttachmentTypes: DEFAULT_ATTACHMENT_TYPES,
      downloadDir: undefined,
      maxDownloadBytes: 25 * 1024 * 1024,
      maxExtractBytes: 10 * 1024 * 1024,
      commandTimeoutMs: 30_000,
      draftAttachmentMaxBytes: 2 * 1024 * 1024,
      draftMaxBytes: 8 * 1024 * 1024,
      ...overrides.imap,
    },
    // Mirrors the real default: read-only unless the test says otherwise.
    readOnly: overrides.readOnly ?? true,
    // Also the real default: unset means "ask".
    elicitation: overrides.elicitation ?? true,
    allowTools: overrides.allowTools,
    denyTools: overrides.denyTools,
  };
}

export function defaultMailboxes(): FakeMailbox[] {
  return [
    {
      path: 'INBOX',
      specialUse: '\\Inbox',
      messages: [
        message(1, {
          subject: 'Welcome',
          flags: new Set(['\\Seen', 'AiSeen']),
        }),
        message(2, { subject: 'Invoice 4711' }),
        message(3, {
          subject: 'Please review',
          from: { name: 'Anna', address: 'anna@example.net' },
        }),
      ],
    },
    { path: 'Archive', messages: [] },
    { path: 'Drafts', specialUse: '\\Drafts', messages: [] },
    { path: 'Trash', specialUse: '\\Trash', messages: [] },
  ];
}

/** How a client with elicitation support answers the confirmation dialog. */
export type ElicitBehaviour = 'accept' | 'decline' | 'cancel' | 'error';

export interface Harness {
  client: Client;
  imap: FakeImap;
  /** Every message the server put in front of the user, in order. */
  prompts: string[];
  close(): Promise<void>;
}

/** Boots the real server against the fake IMAP and returns a connected client. */
export async function connect(
  options: {
    config?: Partial<Config>;
    mailboxes?: FakeMailbox[];
    /** Omitted means the client does not support elicitation at all. */
    elicit?: ElicitBehaviour;
  } = {}
): Promise<Harness> {
  const imap = new FakeImap(options.mailboxes ?? defaultMailboxes());
  const config = testConfig(options.config ?? {});
  const prompts: string[] = [];

  const server = createServer(config, { imapFactory: () => imap });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: 'test', version: '0.0.0' },
    options.elicit === undefined ? {} : { capabilities: { elicitation: {} } }
  );

  if (options.elicit !== undefined) {
    const behaviour = options.elicit;
    client.setRequestHandler('elicitation/create', (request) => {
      const params = request.params as { message?: string };
      prompts.push(params.message ?? '');
      if (behaviour === 'error') throw new Error('dialog unavailable');
      if (behaviour === 'cancel') return { action: 'cancel' };
      if (behaviour === 'decline') return { action: 'decline' };
      return { action: 'accept', content: { confirm: true } };
    });
  }

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  // Listing loads every tool's outputSchema into the client, which then
  // validates `structuredContent` on every successful call. Without it the
  // client-side check never ran in any suite, and a result the server was
  // happy with could still be a protocol error to a real client.
  await client.listTools();

  return {
    client,
    imap,
    prompts,
    close: async () => {
      await client.close();
    },
  };
}

export async function toolNames(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((tool) => tool.name).toSorted();
}

export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as CallToolResult;
}

export function textOf(result: CallToolResult): string {
  return result.content
    .map((part) => (part.type === 'text' ? part.text : `[${part.type}]`))
    .join('\n');
}

/** Parses the JSON payload out of a tool result, ignoring any preamble. */
export function jsonOf(result: CallToolResult): unknown {
  const text = textOf(result);
  const start = text.indexOf('{');
  if (start < 0) throw new Error(`no JSON in result: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start));
}

/** Pulls the confirm_token out of a confirmation prompt. */
export function tokenOf(result: CallToolResult): string {
  const match = /confirm_token="([0-9a-f]+)"/.exec(textOf(result));
  if (match?.[1] === undefined) {
    throw new Error(`no confirm token in: ${textOf(result)}`);
  }
  return match[1];
}

export interface ModernHarness {
  client: Client;
  imap: FakeImap;
  /** One `delete_messages` leg, carrying whatever the previous one asked for. */
  del(
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ): Promise<InputRequiredView>;
  close(): Promise<void>;
}

/** Enough of a result to tell a question from an answer. */
export interface InputRequiredView {
  resultType?: string;
  requestState?: string;
  inputRequests?: Record<string, { params: { message: string } }>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/**
 * The server on the 2026-07-28 revision, with the round trip left to the test.
 *
 * `connect()` above wires the transport by hand, which pins the connection to
 * the 2025 era — there the SDK's legacy shim answers the question in-process
 * and a test never sees it. serveStdio owns the era decision, and
 * `autoFulfill: false` keeps the client from answering on the user's behalf, so
 * a test can hand back exactly what it wants to hand back: the right answer,
 * no state, or somebody else's.
 */
export async function connectModern(
  options: { config?: Partial<Config>; mailboxes?: FakeMailbox[] } = {}
): Promise<ModernHarness> {
  const imap = new FakeImap(options.mailboxes ?? defaultMailboxes());
  const config = testConfig(options.config ?? {});
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const handle = serveStdio(
    () => createServer(config, { imapFactory: () => imap }),
    { transport: serverTransport }
  );
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' },
      inputRequired: { autoFulfill: false },
    }
  );
  await client.connect(clientTransport);

  return {
    client,
    imap,
    del: async (args, extra = {}) =>
      (await client.request(
        {
          method: 'tools/call',
          params: { name: 'delete_messages', arguments: args, ...extra },
        },
        withInputRequired(CallToolResultSchema),
        { allowInputRequired: true }
      )) as InputRequiredView,
    close: async () => {
      await client.close();
      await handle.close();
    },
  };
}
