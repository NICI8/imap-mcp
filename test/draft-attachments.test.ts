import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';

import {
  buildDraftWithAttachments,
  draftFilename,
  inlineAttachment,
} from '../src/draft-attachments.js';
import { ToolInputError } from '../src/errors.js';

import {
  call,
  connect,
  defaultMailboxes,
  jsonOf,
  testConfig,
  textOf,
} from './harness.js';
import { message } from './fake-imap.js';

/** A 1x1 transparent PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);
const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(40, 0x20)]);
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);

const base = {
  from: 'me@example.net',
  to: ['anna@example.net'],
  subject: 'Fotos zum Ticket Grösse',
  body: 'Grüezi\nAnbei die Fotos.',
  date: new Date('2026-11-10T10:00:00Z'),
};

/** Header block of each MIME part, split on the boundary, for raw checks. */
function partHeaders(raw: string): string[] {
  const boundary = /boundary="([^"]+)"/.exec(raw)?.[1];
  if (boundary === undefined) throw new Error('no boundary');
  return raw
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => part.split('\r\n\r\n')[0] ?? '');
}

describe('buildDraftWithAttachments', () => {
  it('builds multipart/mixed with the text first and every file as an attachment', async () => {
    const raw = await buildDraftWithAttachments(base, [
      { filename: 'foto.png', contentType: 'image/png', content: PNG },
      {
        filename: 'Rechnung März.pdf',
        contentType: 'application/pdf',
        content: PDF,
      },
    ]);
    const parsed = await simpleParser(raw);
    expect(parsed.headers.get('content-type')).toMatchObject({
      value: 'multipart/mixed',
    });
    expect(parsed.subject).toBe(base.subject);
    expect(parsed.text?.replace(/\r\n/g, '\n').trim()).toBe(
      'Grüezi\nAnbei die Fotos.'
    );
    expect(parsed.attachments.map((a) => a.filename)).toEqual([
      'foto.png',
      'Rechnung März.pdf',
    ]);
    expect(parsed.attachments.map((a) => a.contentType)).toEqual([
      'image/png',
      'application/pdf',
    ]);
    expect(parsed.attachments.map((a) => a.contentDisposition)).toEqual([
      'attachment',
      'attachment',
    ]);
    expect(parsed.attachments[0]?.content.equals(PNG)).toBe(true);
    expect(parsed.attachments[1]?.content.equals(PDF)).toBe(true);
  });

  it('writes every part base64-encoded and the attachments with Content-Disposition attachment', async () => {
    const raw = (
      await buildDraftWithAttachments(base, [
        {
          filename: 'notiz.txt',
          contentType: 'text/plain',
          content: Buffer.from('plain ascii'),
        },
        { filename: 'foto.png', contentType: 'image/png', content: PNG },
      ])
    ).toString('utf-8');
    const parts = partHeaders(raw);
    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatch(/Content-Type: text\/plain; charset=utf-8/i);
    for (const part of parts) {
      expect(part).toMatch(/Content-Transfer-Encoding: base64/i);
    }
    for (const part of parts.slice(1)) {
      expect(part).toMatch(/Content-Disposition: attachment/i);
    }
  });

  it('keeps every line inside the 998-octet limit', async () => {
    const raw = await buildDraftWithAttachments(
      { ...base, body: 'x'.repeat(5000) },
      [
        {
          filename: 'gross.pdf',
          contentType: 'application/pdf',
          content: Buffer.alloc(100_000, 7),
        },
      ]
    );
    for (const line of raw.toString('utf-8').split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998);
    }
  });

  it('keeps Bcc in the draft and threads a reply', async () => {
    const raw = await buildDraftWithAttachments(
      {
        ...base,
        cc: ['c@example.net'],
        bcc: ['d@example.net'],
        thread: {
          messageId: '<parent@example.net>',
          references: ['<root@example.net>', '<parent@example.net>'],
        },
      },
      [{ filename: 'foto.png', contentType: 'image/png', content: PNG }]
    );
    const parsed = await simpleParser(raw);
    expect(parsed.bcc).toMatchObject({ text: 'd@example.net' });
    expect(parsed.cc).toMatchObject({ text: 'c@example.net' });
    expect(parsed.inReplyTo).toBe('<parent@example.net>');
    expect(parsed.references).toEqual([
      '<root@example.net>',
      '<parent@example.net>',
    ]);
    expect(parsed.messageId).toMatch(/@imap-mcp\.invalid>$/);
  });

  it('leaves out From when the login is not an address', async () => {
    const raw = await buildDraftWithAttachments({ ...base, from: 'nicolas' }, [
      { filename: 'foto.png', contentType: 'image/png', content: PNG },
    ]);
    const parsed = await simpleParser(raw);
    expect(parsed.from).toBeUndefined();
  });

  it('refuses to build without a sender', async () => {
    await expect(
      buildDraftWithAttachments({ ...base, from: undefined }, [])
    ).rejects.toThrow(ToolInputError);
  });
});

describe('inlineAttachment', () => {
  const config = testConfig();
  const ok = {
    filename: 'foto.png',
    content_type: 'image/png',
    data_base64: PNG.toString('base64'),
  };

  it('decodes the bytes unchanged', () => {
    const attachment = inlineAttachment(ok, config, 0);
    expect(attachment.content.equals(PNG)).toBe(true);
    expect(attachment.contentType).toBe('image/png');
  });

  it('accepts base64 broken into lines and an upper-case media type', () => {
    const wrapped = (PNG.toString('base64').match(/.{1,20}/g) ?? []).join(
      '\r\n'
    );
    const attachment = inlineAttachment(
      { ...ok, content_type: 'Image/PNG', data_base64: wrapped },
      config,
      0
    );
    expect(attachment.content.equals(PNG)).toBe(true);
    expect(attachment.contentType).toBe('image/png');
  });

  it.each([
    ['../../etc/passwd.txt', 'passwd.txt'],
    ['C:\\Users\\nicolas\\foto.png', 'foto.png'],
    ['bad\u0000name\u001f.png', 'badname.png'],
    ['a:b|c?.pdf', 'a_b_c_.pdf'],
    ['\u202Egnp.exe', 'gnp.exe'],
  ])('cleans the filename %j to %j', (raw, expected) => {
    expect(draftFilename(raw)).toBe(expected);
  });

  it('refuses a filename with nothing visible left', () => {
    expect(() => draftFilename('../\u200B')).toThrow(/filename/);
  });

  it('refuses a type outside IMAP_ATTACHMENT_TYPES', () => {
    expect(() =>
      inlineAttachment({ ...ok, content_type: 'application/x-sh' }, config, 0)
    ).toThrow(/allowlist/);
  });

  it('refuses something that is not a media type', () => {
    expect(() =>
      inlineAttachment({ ...ok, content_type: 'png' }, config, 0)
    ).toThrow(/media type/);
  });

  it.each(['data:image/png;base64,AAAA', 'AAA', 'AA*A', '===='])(
    'refuses malformed base64 %j',
    (data) => {
      expect(() =>
        inlineAttachment({ ...ok, data_base64: data }, config, 0)
      ).toThrow(/base64/);
    }
  );

  it('refuses a file over IMAP_ATTACHMENT_MAX_BYTES', () => {
    const small = testConfig({
      imap: { ...testConfig().imap, draftAttachmentMaxBytes: 10 },
    });
    expect(() => inlineAttachment(ok, small, 2)).toThrow(
      /attachment 3: .*IMAP_ATTACHMENT_MAX_BYTES \(10\)/
    );
  });

  it('refuses an executable by name and by content', () => {
    expect(() =>
      inlineAttachment({ ...ok, filename: 'setup.exe' }, config, 0)
    ).toThrow(/executable/);
    expect(() =>
      inlineAttachment(
        {
          ...ok,
          content_type: 'application/pdf',
          filename: 'x.pdf',
          data_base64: ELF.toString('base64'),
        },
        config,
        0
      )
    ).toThrow(/executable|ELF|bytes are/);
  });
});

function mailboxes() {
  const boxes = defaultMailboxes();
  boxes[0]?.messages.push(
    message(7, {
      subject: 'Rechnung',
      attachments: [
        {
          partId: '2',
          filename: 'rechnung.pdf',
          contentType: 'application/pdf',
          content: PDF,
        },
        {
          partId: '3',
          filename: 'setup.exe',
          contentType: 'application/x-msdownload',
          content: ELF,
        },
        {
          partId: '4',
          filename: 'tarn.pdf',
          contentType: 'application/pdf',
          content: ELF,
        },
      ],
    })
  );
  boxes[1]?.messages.push(
    message(20, {
      subject: 'Archiviert',
      attachments: [
        {
          partId: '2',
          filename: 'alt.pdf',
          contentType: 'application/pdf',
          content: PDF,
        },
      ],
    })
  );
  return boxes;
}

describe('save_draft with attachments', () => {
  const writeConfig = { readOnly: false };

  it('attaches a file from the call and one copied from the mailbox', async () => {
    const harness = await connect({
      config: writeConfig,
      mailboxes: mailboxes(),
    });
    const result = await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'Mit Anhang',
      body: 'Siehe Anhang.',
      attachments: [
        {
          filename: 'foto.png',
          content_type: 'image/png',
          data_base64: PNG.toString('base64'),
        },
        { source_uid: 7, part_id: '2' },
        { source_uid: 20, part_id: '2', mailbox: 'Archive' },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(jsonOf(result)).toMatchObject({
      action: 'draft_saved',
      mailbox: 'Drafts',
      attachments: [
        { filename: 'foto.png', source: 'call', bytes: PNG.length },
        {
          filename: 'rechnung.pdf',
          source: 'mailbox',
          source_uid: 7,
          part_id: '2',
          mailbox: 'INBOX',
        },
        {
          filename: 'alt.pdf',
          source: 'mailbox',
          source_uid: 20,
          mailbox: 'Archive',
        },
      ],
    });
    const appended = harness.imap.appended[0];
    expect(appended?.path).toBe('Drafts');
    expect(appended?.flags).toEqual(['\\Draft', '\\Seen']);
    const parsed = await simpleParser(appended!.content);
    expect(parsed.attachments.map((a) => a.filename)).toEqual([
      'foto.png',
      'rechnung.pdf',
      'alt.pdf',
    ]);
    expect(parsed.attachments[1]?.content.equals(PDF)).toBe(true);
    await harness.close();
  });

  it('stays a plain-text draft without attachments', async () => {
    const harness = await connect({ config: writeConfig });
    await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'Ohne',
      body: 'Text.',
      attachments: [],
    });
    expect(harness.imap.appended[0]?.content.toString('utf-8')).toContain(
      'Content-Type: text/plain; charset=utf-8'
    );
    await harness.close();
  });

  it.each([
    [{ source_uid: 7, part_id: '1' }, /no attachment with part id 1/],
    [{ source_uid: 7, part_id: '9' }, /no attachment with part id 9/],
    [{ source_uid: 7, part_id: '3' }, /executable|allowlist/],
    [{ source_uid: 7, part_id: '4' }, /bytes are/],
    [{ source_uid: 99, part_id: '2' }, /no message with UID 99/],
  ])('refuses %j and saves nothing', async (attachment, error) => {
    const harness = await connect({
      config: writeConfig,
      mailboxes: mailboxes(),
    });
    const result = await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'X',
      body: 'Y',
      attachments: [attachment],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(error);
    expect(harness.imap.appended).toHaveLength(0);
    await harness.close();
  });

  it('refuses a mix of both shapes in one entry', async () => {
    const harness = await connect({
      config: writeConfig,
      mailboxes: mailboxes(),
    });
    const result = await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'X',
      body: 'Y',
      attachments: [
        {
          source_uid: 7,
          part_id: '2',
          filename: 'x.png',
          content_type: 'image/png',
          data_base64: 'AAAA',
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(harness.imap.appended).toHaveLength(0);
    await harness.close();
  });

  it('holds the whole draft to IMAP_DRAFT_MAX_BYTES, mailbox parts included', async () => {
    const harness = await connect({
      config: {
        ...writeConfig,
        imap: { ...testConfig().imap, draftMaxBytes: PNG.length + 10 },
      },
      mailboxes: mailboxes(),
    });
    const result = await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'X',
      body: 'Y',
      attachments: [
        {
          filename: 'foto.png',
          content_type: 'image/png',
          data_base64: PNG.toString('base64'),
        },
        { source_uid: 7, part_id: '2' },
      ],
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/IMAP_DRAFT_MAX_BYTES|exceeds/);
    expect(harness.imap.appended).toHaveLength(0);

    const inlineOnly = await call(harness.client, 'save_draft', {
      to: ['anna@example.net'],
      subject: 'X',
      body: 'Y',
      attachments: [
        {
          filename: 'a.png',
          content_type: 'image/png',
          data_base64: PNG.toString('base64'),
        },
        {
          filename: 'b.png',
          content_type: 'image/png',
          data_base64: PNG.toString('base64'),
        },
      ],
    });
    expect(textOf(inlineOnly)).toMatch(/IMAP_DRAFT_MAX_BYTES/);
    expect(harness.imap.appended).toHaveLength(0);
    await harness.close();
  });

  it('reports the draft limits in get_server_info', async () => {
    const harness = await connect({ config: writeConfig });
    const info = jsonOf(await call(harness.client, 'get_server_info')) as {
      limits: Record<string, unknown>;
    };
    expect(info.limits).toMatchObject({
      draft_attachment_max_bytes: 2 * 1024 * 1024,
      draft_max_bytes: 8 * 1024 * 1024,
      draft_max_attachments: 20,
    });
    await harness.close();
  });
});
