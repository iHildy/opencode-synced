import { type Dirent, promises as fs } from 'node:fs';
import path from 'node:path';

/** Maps a canonical `provider/model` string (as stored in the repo) to this machine's value. */
export type ModelRemap = Record<string, string>;

/** Directory names whose markdown files carry a `model:` frontmatter key. */
export const MODEL_REMAP_DIR_NAMES: ReadonlySet<string> = new Set([
  'agent',
  'agents',
  'command',
  'commands',
  'mode',
  'modes',
]);

const MODEL_KEYS: ReadonlySet<string> = new Set(['model', 'small_model']);
const FRONTMATTER = /^(---[ \t]*\r?\n)([\s\S]*?)(\r?\n---[ \t]*(?:\r?\n|$))/;
const MODEL_LINE = /^(model:[ \t]*)(["']?)([^\r\n"']+?)(["']?)([ \t]*)$/gm;

export function isEmptyRemap(remap: ModelRemap | undefined): boolean {
  return !remap || Object.keys(remap).length === 0;
}

/**
 * Reverses a remap so local values can be turned back into canonical ones on push.
 * A local value that two canonical values map to is ambiguous and is left out.
 */
export function invertModelRemap(remap: ModelRemap | undefined): ModelRemap {
  const inverse: ModelRemap = {};
  const ambiguous = new Set<string>();
  for (const [canonical, local] of Object.entries(remap ?? {})) {
    if (hasOwn(inverse, local)) {
      ambiguous.add(local);
      continue;
    }
    inverse[local] = canonical;
  }
  for (const local of ambiguous) {
    delete inverse[local];
  }
  return inverse;
}

/** Remaps one model string. A trailing `#variant` is kept when only the base model is mapped. */
export function remapModelString(value: string, remap: ModelRemap): string {
  if (hasOwn(remap, value)) return remap[value] as string;
  const hashIndex = value.lastIndexOf('#');
  if (hashIndex <= 0) return value;
  const base = value.slice(0, hashIndex);
  if (!hasOwn(remap, base)) return value;
  return `${remap[base]}${value.slice(hashIndex)}`;
}

/** Remaps the `model:` key of a markdown file's leading frontmatter block. */
export function remapFrontmatterModel(content: string, remap: ModelRemap): string {
  if (isEmptyRemap(remap)) return content;
  const match = FRONTMATTER.exec(content);
  if (!match) return content;
  const [whole, open, body, close] = match as unknown as [string, string, string, string];
  const rewritten = body.replace(
    MODEL_LINE,
    (_line, key: string, openQuote: string, value: string, closeQuote: string, tail: string) =>
      `${key}${openQuote}${remapModelString(value, remap)}${closeQuote}${tail}`
  );
  if (rewritten === body) return content;
  return `${open}${rewritten}${close}${content.slice(whole.length)}`;
}

/** Remaps `model` and `small_model` string values anywhere in a parsed config document. */
export function remapConfigModels<T>(value: T, remap: ModelRemap): T {
  if (isEmptyRemap(remap)) return value;
  return remapNode(value, remap) as T;
}

function remapNode(value: unknown, remap: ModelRemap): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => remapNode(item, remap));
  }
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const remapped =
      MODEL_KEYS.has(key) && typeof child === 'string'
        ? remapModelString(child, remap)
        : remapNode(child, remap);
    Object.defineProperty(result, key, {
      value: remapped,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

/** Rewrites the `model:` frontmatter key of every markdown file below `directory`. */
export async function remapMarkdownDirectory(directory: string, remap: ModelRemap): Promise<void> {
  if (isEmptyRemap(remap)) return;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await remapMarkdownDirectory(entryPath, remap);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const content = await fs.readFile(entryPath, 'utf8');
    const rewritten = remapFrontmatterModel(content, remap);
    if (rewritten !== content) {
      await fs.writeFile(entryPath, rewritten, 'utf8');
    }
  }
}

function hasOwn(target: object, key: string): boolean {
  return Object.hasOwn(target, key);
}
