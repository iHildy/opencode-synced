import { describe, expect, it } from 'vitest';
import {
  invertModelRemap,
  remapConfigModels,
  remapFrontmatterModel,
  remapModelString,
} from './model-remap.js';

const REMAP = { 'claude-agent/opus': 'vercel/anthropic/claude-opus-5.5' };

describe('remapModelString', () => {
  it('maps exact matches and keeps unknown values', () => {
    expect(remapModelString('claude-agent/opus', REMAP)).toBe('vercel/anthropic/claude-opus-5.5');
    expect(remapModelString('other/model', REMAP)).toBe('other/model');
  });

  it('keeps a variant suffix when only the base model is mapped', () => {
    expect(remapModelString('claude-agent/opus#high', REMAP)).toBe(
      'vercel/anthropic/claude-opus-5.5#high'
    );
  });

  it('does not read inherited object properties', () => {
    expect(remapModelString('constructor', REMAP)).toBe('constructor');
    expect(remapModelString('__proto__', REMAP)).toBe('__proto__');
  });
});

describe('invertModelRemap', () => {
  it('reverses one-to-one entries and drops ambiguous targets', () => {
    expect(invertModelRemap({ a: 'x', b: 'y', c: 'y' })).toEqual({ x: 'a' });
  });
});

describe('remapFrontmatterModel', () => {
  it('rewrites only the model key of the leading frontmatter', () => {
    const input = [
      '---',
      'description: Worker',
      'model: claude-agent/opus',
      'mode: primary',
      '---',
      '',
      'model: claude-agent/opus is mentioned in the body and must stay.',
      '',
    ].join('\n');
    const output = remapFrontmatterModel(input, REMAP);
    expect(output).toContain('model: vercel/anthropic/claude-opus-5.5\nmode: primary');
    expect(output).toContain('model: claude-agent/opus is mentioned in the body');
  });

  it('keeps quotes and CRLF line endings', () => {
    const input = '---\r\nmodel: "claude-agent/opus"\r\n---\r\nbody\r\n';
    expect(remapFrontmatterModel(input, REMAP)).toBe(
      '---\r\nmodel: "vercel/anthropic/claude-opus-5.5"\r\n---\r\nbody\r\n'
    );
  });

  it('leaves files without frontmatter or without a model alone', () => {
    expect(remapFrontmatterModel('no frontmatter\nmodel: claude-agent/opus\n', REMAP)).toBe(
      'no frontmatter\nmodel: claude-agent/opus\n'
    );
    expect(remapFrontmatterModel('---\nmode: all\n---\nx\n', REMAP)).toBe(
      '---\nmode: all\n---\nx\n'
    );
  });

  it('does not touch an indented model key', () => {
    const input = '---\noptions:\n  model: claude-agent/opus\n---\n';
    expect(remapFrontmatterModel(input, REMAP)).toBe(input);
  });
});

describe('remapConfigModels', () => {
  it('remaps model and small_model at any depth without mutating the input', () => {
    const input = {
      model: 'claude-agent/opus',
      small_model: 'claude-agent/opus',
      agent: { lead: { model: 'claude-agent/opus', description: 'claude-agent/opus' } },
      list: [{ model: 'claude-agent/opus' }],
    };
    const output = remapConfigModels(input, REMAP);
    expect(output).toEqual({
      model: 'vercel/anthropic/claude-opus-5.5',
      small_model: 'vercel/anthropic/claude-opus-5.5',
      agent: {
        lead: { model: 'vercel/anthropic/claude-opus-5.5', description: 'claude-agent/opus' },
      },
      list: [{ model: 'vercel/anthropic/claude-opus-5.5' }],
    });
    expect(input.model).toBe('claude-agent/opus');
  });
});
