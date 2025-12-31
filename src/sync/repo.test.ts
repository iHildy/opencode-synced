import { describe, expect, it } from 'vitest';

import { parseRepoVisibility } from './repo.js';

describe('parseRepoVisibility', () => {
  it('parses private status', () => {
    expect(parseRepoVisibility('{"isPrivate": true}')).toBe(true);
    expect(parseRepoVisibility('{"isPrivate": false}')).toBe(false);
  });

  it('throws on invalid payload', () => {
    expect(() => parseRepoVisibility('{"private": true}')).toThrow();
  });
});
