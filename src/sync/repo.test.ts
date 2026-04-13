import { describe, expect, it } from 'vitest';

import { parseRepoReference, parseRepoVisibility } from './repo.js';

describe('parseRepoVisibility', () => {
  it('parses private status', () => {
    expect(parseRepoVisibility('{"isPrivate": true}')).toBe(true);
    expect(parseRepoVisibility('{"isPrivate": false}')).toBe(false);
  });

  it('throws on invalid payload', () => {
    expect(() => parseRepoVisibility('{"private": true}')).toThrow();
  });
});

describe('parseRepoReference', () => {
  it('parses short repo name with authenticated-user fallback', () => {
    expect(parseRepoReference('my-opencode-config', 'ihildy')).toEqual({
      owner: 'ihildy',
      name: 'my-opencode-config',
    });
  });

  it('parses explicit owner/repo input', () => {
    expect(parseRepoReference('acme/opencode-sync', 'ignored')).toEqual({
      owner: 'acme',
      name: 'opencode-sync',
    });
  });

  it('parses GitHub https repo URLs', () => {
    expect(parseRepoReference('https://github.com/acme/opencode-sync.git', 'ignored')).toEqual({
      owner: 'acme',
      name: 'opencode-sync',
    });
  });

  it('parses GitHub ssh:// repo URLs', () => {
    expect(parseRepoReference('ssh://git@github.com/acme/opencode-sync.git', 'ignored')).toEqual({
      owner: 'acme',
      name: 'opencode-sync',
    });
  });

  it('parses GitHub SSH repo URLs', () => {
    expect(parseRepoReference('git@github.com:acme/opencode-sync.git', 'ignored')).toEqual({
      owner: 'acme',
      name: 'opencode-sync',
    });
  });

  it('parses GitHub SSH repo URLs with trailing slash', () => {
    expect(parseRepoReference('git@github.com:acme/opencode-sync.git/', 'ignored')).toEqual({
      owner: 'acme',
      name: 'opencode-sync',
    });
  });

  it('returns null for invalid repo references', () => {
    expect(parseRepoReference('https://example.com/acme/opencode-sync', 'ignored')).toBeNull();
    expect(
      parseRepoReference('https://github.com/acme/opencode-sync/issues', 'ignored')
    ).toBeNull();
    expect(parseRepoReference('acme/opencode/sync', 'ignored')).toBeNull();
    expect(parseRepoReference('git@notgithub:acme/opencode-sync', 'ignored')).toBeNull();
    expect(parseRepoReference('   ', 'ihildy')).toBeNull();
  });
});
