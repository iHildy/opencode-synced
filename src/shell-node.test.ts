import { describe, expect, it } from 'vitest';

import { buildArgv, createNodeShell, quoteWin32 } from './shell-node.js';

const argv = (strings: TemplateStringsArray, ...values: unknown[]) =>
  buildArgv(strings as unknown as string[], values);

describe('buildArgv', () => {
  it('splits plain text', () => {
    expect(buildArgv(['git status --porcelain'], [])).toEqual(['git', 'status', '--porcelain']);
  });

  it('keeps mid-token interpolation as one argv element', () => {
    expect(argv`git rev-list --max-count=${5} origin/${'main'}..HEAD`).toEqual([
      'git',
      'rev-list',
      '--max-count=5',
      'origin/main..HEAD',
    ]);
  });

  it('treats a value with spaces as a single argv element', () => {
    expect(argv`git commit -m ${'fix: a b c'}`).toEqual(['git', 'commit', '-m', 'fix: a b c']);
  });

  it('keeps an empty value as an argv slot', () => {
    expect(argv`git commit -m ${''}`).toEqual(['git', 'commit', '-m', '']);
  });

  it('glues adjacent values', () => {
    expect(argv`gh repo create ${'me'}/${'repo'} ${'public'}`).toEqual([
      'gh',
      'repo',
      'create',
      'me/repo',
      'public',
    ]);
  });

  it('tolerates leading/trailing/multiple whitespace', () => {
    expect(buildArgv(['  git   -C  ', 'x', '   '], [])).toEqual(['git', '-C', 'x']);
  });

  it('preserves newlines and percent signs inside values', () => {
    expect(argv`git commit -m ${'line1\nline2 50% done'}`).toEqual([
      'git',
      'commit',
      '-m',
      'line1\nline2 50% done',
    ]);
  });
});

describe('quoteWin32', () => {
  it('quotes cmd.exe metacharacters instead of short-circuiting', () => {
    expect(quoteWin32('a&&b')).toBe('"a&&b"');
    expect(quoteWin32('x|y')).toBe('"x|y"');
  });

  it('escapes an embedded quote in MSVCRT shape', () => {
    expect(quoteWin32('a"b')).toBe('"a\\"b"');
  });

  it('doubles a backslash run before a closing quote', () => {
    expect(quoteWin32('a\\"b')).toBe('"a\\\\"b"');
  });

  it('doubles trailing backslashes before the closing quote', () => {
    expect(quoteWin32('a b\\')).toBe('"a b\\\\"');
  });
});

describe.skipIf(process.platform === 'win32')('createNodeShell execution', () => {
  it('runs a real command and resolves .text()', async () => {
    const $ = createNodeShell();
    const out = await $`echo ${'hello world'}`.text();
    expect(out.trim()).toBe('hello world');
  });
});
