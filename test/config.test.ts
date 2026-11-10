import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadConfig,
  missingConfigKeys,
  missingConfigMessage,
} from '../src/config.js';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    IMAP_HOST: 'imap.example.net',
    IMAP_USER: 'me@example.net',
    IMAP_PASSWORD: 'secret-password',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ELICITATION', () => {
  it('defaults to on, and to on for an empty value', () => {
    // The only variable of this family that defaults to *on*. An unset switch
    // has to mean "ask", or a deployment that never heard of it would quietly
    // stop asking.
    expect(loadConfig(env()).elicitation).toBe(true);
    expect(loadConfig(env({ ELICITATION: '' })).elicitation).toBe(true);
  });

  it('is switched off by "false", in any casing or padding', () => {
    for (const raw of ['false', 'FALSE', ' False ']) {
      expect(loadConfig(env({ ELICITATION: raw })).elicitation, raw).toBe(
        false
      );
    }
  });

  it('refuses to start on anything else, naming both valid values', () => {
    // Deliberately fatal rather than falling back to the default: a typo would
    // leave the dialog running while the operator believes it is off, and
    // nothing else would ever tell them.
    for (const raw of ['1', 'off', 'no']) {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('exit');
      }) as never);
      expect(() => loadConfig(env({ ELICITATION: raw }))).toThrow('exit');
      expect(exit).toHaveBeenCalledWith(1);
      const message = String(error.mock.calls[0]?.[0] ?? '');
      expect(message, raw).toContain('ELICITATION');
      expect(message, raw).toContain('"true"');
      expect(message, raw).toContain('"false"');
      vi.restoreAllMocks();
    }
  });

  it('has already wiped the credential by the time it can exit', () => {
    // parseElicitation sits *after* the delete on purpose. An exit above it
    // would leave the credential in the environment for whatever a crash
    // reporter or an inspector does next — which is exactly what that delete
    // exists to prevent, and its comment says so.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const e = env({ ELICITATION: 'nonsense' });
    expect(() => loadConfig(e)).toThrow('exit');
    expect(e.IMAP_PASSWORD).toBeUndefined();
    vi.restoreAllMocks();
  });
});

describe('loadConfig', () => {
  it('reads the defaults', () => {
    const config = loadConfig(env());
    expect(config.imap.host).toBe('imap.example.net');
    expect(config.imap.port).toBe(993);
    expect(config.imap.tls).toBe('implicit');
    expect(config.imap.mailbox).toBe('INBOX');
    expect(config.imap.seenKeyword).toBe('AiSeen');
    expect(config.imap.maxMessages).toBe(100);
    // Read-only unless explicitly turned off — the opposite default from the
    // rest of the family, and deliberately so: this reaches a mailbox.
    expect(config.readOnly).toBe(true);
    expect(config.imap.downloadDir).toBeUndefined();
    expect(config.imap.maxExtractBytes).toBe(10 * 1024 * 1024);
  });

  it('removes the password from the environment', () => {
    const environment = env();
    loadConfig(environment);
    expect(environment.IMAP_PASSWORD).toBeUndefined();
  });

  it('removes the password even when the rest of the config is missing', () => {
    // The early return for "no host" used to run before the delete in an
    // earlier project; a token then survived on exactly the failure path.
    const environment: NodeJS.ProcessEnv = { IMAP_PASSWORD: 'secret-password' };
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(environment);
    expect(environment.IMAP_PASSWORD).toBeUndefined();
    expect(errors).toHaveBeenCalled();
  });

  it('starts without credentials and only warns', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig({});
    expect(config.imap.host).toBeUndefined();
    expect(missingConfigKeys(config)).toEqual([
      'IMAP_HOST',
      'IMAP_USER',
      'IMAP_PASSWORD',
    ]);
    expect(errors).toHaveBeenCalledOnce();
  });

  it('defaults the port to 143 without implicit TLS', () => {
    expect(loadConfig(env({ IMAP_TLS: 'starttls' })).imap.port).toBe(143);
    expect(loadConfig(env({ IMAP_TLS: 'none' })).imap.port).toBe(143);
  });

  it('only the literal string false turns read-only off', () => {
    // Fails closed: anything that is not exactly "false" leaves the write
    // tools unregistered, so a typo cannot hand out mailbox writes.
    expect(loadConfig(env({ IMAP_READ_ONLY: 'false' })).readOnly).toBe(false);
    expect(loadConfig(env({ IMAP_READ_ONLY: 'False' })).readOnly).toBe(true);
    expect(loadConfig(env({ IMAP_READ_ONLY: '0' })).readOnly).toBe(true);
    expect(loadConfig(env({ IMAP_READ_ONLY: 'no' })).readOnly).toBe(true);
    expect(loadConfig(env({})).readOnly).toBe(true);
  });

  it('refuses to start when the removed IMAP_ALLOW_WRITE is still set', () => {
    // Ignoring it would be the worst option: whoever set it once believes it
    // is still in force, and would get a read-only server without being told.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() => loadConfig(env({ IMAP_ALLOW_WRITE: 'true' }))).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.mock.calls.flat().join(' ')).toContain('IMAP_READ_ONLY');
    // Even the harmless-looking value is refused: it says the same thing.
    expect(() => loadConfig(env({ IMAP_ALLOW_WRITE: 'false' }))).toThrow(
      'exit'
    );
  });

  it('warns about cleartext to a remote host but keeps going', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig(env({ IMAP_TLS: 'none' }));
    expect(config.imap.tls).toBe('none');
    expect(errors.mock.calls.flat().join(' ')).toContain('unencrypted');
  });

  it('does not warn about cleartext to loopback', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ IMAP_TLS: 'none', IMAP_HOST: '127.0.0.1' }));
    expect(errors).not.toHaveBeenCalled();
  });

  it.each([
    ['::1'],
    ['[::1]'],
    ['::ffff:127.0.0.1'],
    ['localhost.'],
    ['LOCALHOST'],
  ])('recognises %s as loopback too', (host) => {
    // IMAP_HOST is a bare hostname rather than a URL, so the bracketed form is
    // not the only spelling that reaches here — but the mapped IPv4 address,
    // the root label and the casing all did get past the old comparison.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ IMAP_TLS: 'none', IMAP_HOST: host }));
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it.each([
    ['IMAP_HOST', { IMAP_HOST: 'imap.example.net\r\nX-Evil: 1' }],
    ['IMAP_HOST with a scheme', { IMAP_HOST: 'imaps://imap.example.net' }],
    ['IMAP_HOST with credentials', { IMAP_HOST: 'user:pass@imap.example.net' }],
    ['IMAP_PORT', { IMAP_PORT: '99999' }],
    ['IMAP_PORT non-numeric', { IMAP_PORT: 'imap' }],
    ['IMAP_TLS', { IMAP_TLS: 'sometimes' }],
    ['IMAP_SEEN_KEYWORD', { IMAP_SEEN_KEYWORD: 'Ai Seen' }],
    ['IMAP_MAX_MESSAGES', { IMAP_MAX_MESSAGES: 'lots' }],
    ['IMAP_MAX_MESSAGES zero', { IMAP_MAX_MESSAGES: '0' }],
    ['IMAP_MAX_EXTRACT_BYTES', { IMAP_MAX_EXTRACT_BYTES: 'ten megabytes' }],
    ['IMAP_MAX_EXTRACT_BYTES zero', { IMAP_MAX_EXTRACT_BYTES: '0' }],
    // Named rather than clamped, and fatal rather than ignored: the other
    // two size variables buy a big answer, this one buys a buffer inside a
    // parser working on bytes a stranger chose. A typo there would leave an
    // operator believing there is a limit.
    [
      'IMAP_MAX_EXTRACT_BYTES over the ceiling',
      { IMAP_MAX_EXTRACT_BYTES: String(1024 * 1024 * 1024) },
    ],
  ])('exits on a malformed %s', (_name, overrides) => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exited');
    }) as never);
    expect(() => loadConfig(env(overrides))).toThrow('exited');
    expect(exit).toHaveBeenCalledWith(1);
    // The rejected value is never echoed: config errors end up in logs.
    expect(errors.mock.calls.flat().join(' ')).not.toContain('secret-password');
  });

  it('treats an empty keyword as new-mail tracking off', () => {
    expect(loadConfig(env({ IMAP_SEEN_KEYWORD: '' })).imap.seenKeyword).toBe(
      ''
    );
  });

  it('parses the attachment type allowlist', () => {
    const config = loadConfig(
      env({ IMAP_ATTACHMENT_TYPES: 'application/pdf, IMAGE/PNG ,' })
    );
    expect(config.imap.allowedAttachmentTypes).toEqual([
      'application/pdf',
      'image/png',
    ]);
  });
});

describe('missingConfigMessage', () => {
  it('names the variables and the optional ones', () => {
    const message = missingConfigMessage(['IMAP_HOST']);
    expect(message).toContain('IMAP_HOST');
    expect(message).toContain('IMAP_READ_ONLY');
    expect(message).toContain('IMAP_DOWNLOAD_DIR');
  });
});

describe('values that cannot be sent to the server', () => {
  // Each of these is fatal at startup rather than sanitised: a line break in
  // a mailbox name would end the IMAP command early, a port that is not a
  // port is a typo nobody would otherwise learn about, and an extraction
  // ceiling above the hard one would be a promise the child cannot keep.
  it.each([
    ['IMAP_DRAFTS_MAILBOX', 'Drafts\nNOOP', 'control characters'],
    // Trimmed first, so the break has to sit inside the value to count.
    ['IMAP_TRUSTED_AUTHSERV_ID', 'mx.example\r\nnet', 'plain hostname'],
    ['IMAP_PORT', 'nine-nine-three', '65535'],
    ['IMAP_PORT', '70000', '65535'],
    ['IMAP_SEEN_KEYWORD', 'Ai Seen', 'letters, digits'],
    ['IMAP_MAX_EXTRACT_BYTES', String(65 * 1024 * 1024), 'must not exceed'],
  ])('refuses to start with %s=%j', (name, raw, phrase) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() => loadConfig(env({ [name]: raw }))).toThrow('exit');
    expect(exit).toHaveBeenCalledWith(1);
    const message = String(error.mock.calls[0]?.[0] ?? '');
    expect(message).toContain(name);
    expect(message).toContain(phrase);
  });
});

function refuses(overrides: Record<string, string>): string {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('exit');
  }) as never);
  expect(() => loadConfig(env(overrides))).toThrow('exit');
  const message = error.mock.calls.flat().join(' ');
  vi.restoreAllMocks();
  return message;
}

describe('values the audit found read the wrong way', () => {
  it('treats an empty IMAP_HOST like a missing one instead of exiting', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig(env({ IMAP_HOST: '' }));
    expect(config.imap.host).toBeUndefined();
    expect(missingConfigKeys(config)).toContain('IMAP_HOST');
  });

  it('treats an empty IMAP_DRAFTS_MAILBOX as unset, so \\Drafts is looked up', () => {
    expect(
      loadConfig(env({ IMAP_DRAFTS_MAILBOX: '' })).imap.draftsMailbox
    ).toBeUndefined();
    expect(
      loadConfig(env({ IMAP_DRAFTS_MAILBOX: '  ' })).imap.draftsMailbox
    ).toBeUndefined();
  });

  it('passes a bracketed IPv6 literal on without its brackets', () => {
    expect(loadConfig(env({ IMAP_HOST: '[::1]' })).imap.host).toBe('::1');
    expect(loadConfig(env({ IMAP_HOST: '2001:db8::1' })).imap.host).toBe(
      '2001:db8::1'
    );
  });

  it.each(['[::1', '::1]', ':', '[imap.example.net]', '[1:2:3]'])(
    'refuses the malformed host %j',
    (host) => {
      expect(refuses({ IMAP_HOST: host })).toContain('IMAP_HOST');
    }
  );

  it.each(['0x3e1', '1e3', '+993', '993.0', '0b11', '9'.repeat(20)])(
    'refuses %j as a port, which Number() would have read',
    (port) => {
      expect(refuses({ IMAP_PORT: port })).toContain('IMAP_PORT');
    }
  );

  it('reads a padded port', () => {
    expect(loadConfig(env({ IMAP_PORT: ' 993 ' })).imap.port).toBe(993);
  });

  it('refuses a count Number() would read past the safe integers', () => {
    expect(refuses({ IMAP_MAX_DOWNLOAD_BYTES: '1e20' })).toContain(
      'IMAP_MAX_DOWNLOAD_BYTES'
    );
    expect(refuses({ IMAP_MAX_DOWNLOAD_BYTES: '99999999999999999' })).toContain(
      'IMAP_MAX_DOWNLOAD_BYTES'
    );
  });

  it('keeps the default page within the hard cap of the limit parameter', () => {
    expect(loadConfig(env({ IMAP_MAX_MESSAGES: '200' })).imap.maxMessages).toBe(
      200
    );
    expect(refuses({ IMAP_MAX_MESSAGES: '201' })).toContain(
      'must not exceed 200'
    );
  });

  it('reads a list of nothing but commas as the default allowlist', () => {
    const fallback = loadConfig(env()).imap.allowedAttachmentTypes;
    expect(
      loadConfig(env({ IMAP_ATTACHMENT_TYPES: ',' })).imap
        .allowedAttachmentTypes
    ).toEqual(fallback);
    expect(fallback.length).toBeGreaterThan(0);
  });

  it('warns about cleartext for a DNS name that merely starts with 127.', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ IMAP_TLS: 'none', IMAP_HOST: '127.mail.example.net' }));
    expect(errors.mock.calls.flat().join(' ')).toContain('unencrypted');
    vi.restoreAllMocks();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    loadConfig(env({ IMAP_TLS: 'none', IMAP_HOST: '127.1.2.3' }));
    expect(quiet.mock.calls.flat().join(' ')).not.toContain('unencrypted');
  });
});

describe('IMAP_COMMAND_TIMEOUT_SECONDS', () => {
  it('defaults to thirty seconds, unset or empty', () => {
    expect(loadConfig(env()).imap.commandTimeoutMs).toBe(30_000);
    expect(
      loadConfig(env({ IMAP_COMMAND_TIMEOUT_SECONDS: '' })).imap
        .commandTimeoutMs
    ).toBe(30_000);
  });

  it.each([
    [' 45 ', 45_000],
    ['1', 1_000],
    ['600', 600_000],
  ])('reads %j as %i ms', (raw, ms) => {
    expect(
      loadConfig(env({ IMAP_COMMAND_TIMEOUT_SECONDS: raw })).imap
        .commandTimeoutMs
    ).toBe(ms);
  });

  it.each([
    '0',
    '-5',
    '1.5',
    '30s',
    '0x1e',
    '1e3',
    '+30',
    '   ',
    '9'.repeat(16),
  ])('refuses %j at startup', (raw) => {
    expect(refuses({ IMAP_COMMAND_TIMEOUT_SECONDS: raw })).toContain(
      'IMAP_COMMAND_TIMEOUT_SECONDS must be a positive integer'
    );
  });

  it.each(['601', '120000', '9'.repeat(15)])(
    'refuses %j past the ceiling rather than clamping it',
    (raw) => {
      // 120000 is the classic slip: thirty seconds' worth of milliseconds
      // times four. Clamped, it would quietly become ten minutes.
      expect(refuses({ IMAP_COMMAND_TIMEOUT_SECONDS: raw })).toContain(
        'IMAP_COMMAND_TIMEOUT_SECONDS must not exceed 600'
      );
    }
  );

  it('never echoes the refused value', () => {
    expect(
      refuses({ IMAP_COMMAND_TIMEOUT_SECONDS: '30 seconds' })
    ).not.toContain('30 seconds');
  });
});

describe('IMAP_TRUSTED_AUTHSERV_ID', () => {
  // CodeQL (js/clear-text-logging, alert 8) reads this variable as a credential
  // because of "AUTH" in its name. Its refusal therefore carries nothing derived
  // from the value — not the value, and not its length either.
  it.each([
    'mx.example net',
    'mx.example.net:25',
    'https://mx.example.net',
    'm'.repeat(254),
  ])('refuses %j without a word about the value', (raw) => {
    const message = refuses({ IMAP_TRUSTED_AUTHSERV_ID: raw });
    expect(message).toContain('IMAP_TRUSTED_AUTHSERV_ID');
    expect(message).toContain('plain hostname');
    expect(message).not.toContain('character');
    expect(message).not.toMatch(/\d/);
    expect(message).not.toContain(raw);
  });

  it.each(['mx.example.net', '192.0.2.1', '2001:db8::1', 'm'.repeat(253)])(
    'accepts %j',
    (raw) => {
      expect(
        loadConfig(env({ IMAP_TRUSTED_AUTHSERV_ID: raw })).imap
          .trustedAuthservId
      ).toBe(raw);
    }
  );

  it.each(['', '   '])('treats %j as unset', (raw) => {
    expect(
      loadConfig(env({ IMAP_TRUSTED_AUTHSERV_ID: raw })).imap.trustedAuthservId
    ).toBeUndefined();
  });

  it('still describes a refused IMAP_HOST by its length', () => {
    expect(refuses({ IMAP_HOST: 'imap.example.net:993' })).toContain(
      'a 20-character value'
    );
  });
});

describe('the draft attachment limits', () => {
  it('default to 2 MiB per attachment and 8 MiB per draft', () => {
    const { imap } = loadConfig(env());
    expect(imap.draftAttachmentMaxBytes).toBe(2 * 1024 * 1024);
    expect(imap.draftMaxBytes).toBe(8 * 1024 * 1024);
  });

  it('read IMAP_ATTACHMENT_MAX_BYTES and IMAP_DRAFT_MAX_BYTES', () => {
    const { imap } = loadConfig(
      env({ IMAP_ATTACHMENT_MAX_BYTES: '1000', IMAP_DRAFT_MAX_BYTES: '5000' })
    );
    expect(imap.draftAttachmentMaxBytes).toBe(1000);
    expect(imap.draftMaxBytes).toBe(5000);
  });

  it('leave the inline read limit alone', () => {
    const { imap } = loadConfig(env({ IMAP_ATTACHMENT_MAX_BYTES: '1000' }));
    expect(imap.maxAttachmentBytes).toBe(1024 * 1024);
  });

  it.each(['IMAP_ATTACHMENT_MAX_BYTES', 'IMAP_DRAFT_MAX_BYTES'])(
    'refuses a malformed or oversized %s at startup',
    (name) => {
      expect(refuses({ [name]: '2MB' })).toContain(
        `${name} must be a positive integer`
      );
      expect(refuses({ [name]: String(65 * 1024 * 1024) })).toContain(
        `${name} must not exceed ${64 * 1024 * 1024}`
      );
    }
  );
});
