import { describe, expect, it } from 'vitest';
import { summarizeChanges } from './preview.js';

describe('summarizeChanges', () => {
  it('returns nothing for no changes', () => {
    expect(summarizeChanges([])).toEqual([]);
    expect(summarizeChanges(['', '  '])).toEqual([]);
  });

  it('counts actions and lists paths from porcelain and name-status lines', () => {
    expect(
      summarizeChanges([
        'M config/opencode.json',
        '?? config/agents/lead.md',
        'D\tconfig/commands/old.md',
        'A\tconfig/commands/new.md',
      ])
    ).toEqual([
      '4 files: 1 updated, 2 added, 1 deleted',
      '  update config/opencode.json',
      '  add config/agents/lead.md',
      '  delete config/commands/old.md',
      '  add config/commands/new.md',
    ]);
  });

  it('uses the new path for renames and the singular noun for one file', () => {
    expect(summarizeChanges(['R100\tconfig/a.md\tconfig/b.md'])[0]).toBe('1 file: 1 renamed');
    expect(summarizeChanges(['R  config/a.md -> config/b.md'])[1]).toBe('  rename config/b.md');
  });

  it('truncates long lists', () => {
    const lines = Array.from({ length: 20 }, (_value, index) => `M config/file-${index}.md`);
    const summary = summarizeChanges(lines, 5);
    expect(summary).toHaveLength(1 + 5 + 1);
    expect(summary.at(-1)).toBe('  ... and 15 more');
  });
});
