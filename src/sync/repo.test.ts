import { describe, expect, it } from 'vitest';

import {
  assertValidRepoBranch,
  isExplicitGitRemote,
  parseRepoReference,
  parseRepoVisibility,
  redactRemoteCredentials,
  resolveGitHubRepoIdentifier,
  resolveRepoBranch,
} from './repo.js';

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

describe('explicit Git remotes', () => {
  it('recognizes supported URLs, SCP remotes, and absolute local paths', () => {
    expect(isExplicitGitRemote('https://gitlab.com/acme/config.git')).toBe(true);
    expect(isExplicitGitRemote('ssh://git@gitlab.com/acme/config.git')).toBe(true);
    expect(isExplicitGitRemote('git@gitlab.com:acme/config.git')).toBe(true);
    expect(isExplicitGitRemote('file:///tmp/config.git')).toBe(true);
    expect(isExplicitGitRemote('/tmp/config.git')).toBe(true);
    expect(isExplicitGitRemote('C:\\repos\\config.git')).toBe(true);
  });

  it('does not treat GitHub shorthand or relative paths as explicit remotes', () => {
    expect(isExplicitGitRemote('acme/config')).toBe(false);
    expect(isExplicitGitRemote('config')).toBe(false);
    expect(isExplicitGitRemote('./config.git')).toBe(false);
  });

  it('redacts embedded URL userinfo from errors and output', () => {
    const redacted = redactRemoteCredentials(
      'fatal: clone https://ian:super-secret@git.example.com/team/config.git failed'
    );

    expect(redacted).not.toContain('ian');
    expect(redacted).not.toContain('super-secret');
    expect(redacted).toContain('https://[REDACTED]@git.example.com/team/config.git');
  });
});

describe('Git branch validation', () => {
  it('accepts normal branch names including slashes', () => {
    expect(assertValidRepoBranch('main')).toBe('main');
    expect(assertValidRepoBranch('sync/config')).toBe('sync/config');
    expect(resolveRepoBranch({ repo: { branch: 'release/v1' } })).toBe('release/v1');
  });

  it('rejects option-like and invalid ref names', () => {
    for (const branch of ['--upload-pack=evil', 'bad branch', 'feature..test', 'a@{b', '.hidden']) {
      expect(() => assertValidRepoBranch(branch)).toThrow('Invalid Git branch name');
    }
  });
});

describe('resolveGitHubRepoIdentifier', () => {
  it('resolves GitHub owner/name and explicit URLs only', () => {
    expect(resolveGitHubRepoIdentifier({ repo: { owner: 'acme', name: 'config' } })).toBe(
      'acme/config'
    );
    expect(
      resolveGitHubRepoIdentifier({ repo: { url: 'ssh://git@github.com/acme/config.git' } })
    ).toBe('acme/config');
    expect(
      resolveGitHubRepoIdentifier({ repo: { url: 'https://gitlab.com/acme/config.git' } })
    ).toBeNull();
    expect(
      resolveGitHubRepoIdentifier({
        repo: {
          url: 'https://gitlab.com/acme/config.git',
          owner: 'trusted-github-owner',
          name: 'trusted-private-repo',
        },
      })
    ).toBeNull();
  });
});
