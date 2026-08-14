import { deepMerge, hasOwn, isPlainObject } from './config.js';

export interface McpSecretExtraction {
  sanitizedConfig: Record<string, unknown>;
  secretOverrides: Record<string, unknown>;
}

const SAFE_REFERENCE_PATTERN = /^(?:[A-Za-z][A-Za-z0-9+.-]*\s+)?\{(?:env|file):[^{}]+\}$/i;
const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|token|access[_-]?token|secret|client[_-]?secret|password|authorization|cookie)$/i;

export function extractMcpSecrets(config: Record<string, unknown>): McpSecretExtraction {
  const sanitizedConfig = cloneConfig(config);
  const secretOverrides: Record<string, unknown> = {};

  const mcp = getPlainObject(sanitizedConfig.mcp);
  if (!mcp) {
    return { sanitizedConfig, secretOverrides };
  }

  for (const [serverName, serverConfigValue] of Object.entries(mcp)) {
    const serverConfig = getPlainObject(serverConfigValue);
    if (!serverConfig) continue;

    const headers = getPlainObject(serverConfig.headers);
    if (headers) {
      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (!isSecretString(headerValue)) continue;
        const envVar = buildHeaderEnvVar(serverName, headerName);
        const placeholder = buildHeaderPlaceholder(String(headerValue), envVar, headerName);
        headers[headerName] = placeholder;
        setNestedValue(secretOverrides, ['mcp', serverName, 'headers', headerName], headerValue);
      }
    }

    const oauth = getPlainObject(serverConfig.oauth);
    if (oauth) {
      const clientSecret = oauth.clientSecret;
      if (isSecretString(clientSecret)) {
        const envVar = buildEnvVar(serverName, 'OAUTH_CLIENT_SECRET');
        oauth.clientSecret = `{env:${envVar}}`;
        setNestedValue(secretOverrides, ['mcp', serverName, 'oauth', 'clientSecret'], clientSecret);
      }
    }
  }

  return { sanitizedConfig, secretOverrides };
}

function isSecretString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !SAFE_REFERENCE_PATTERN.test(value);
}

export function assertNoLiteralSecrets(config: Record<string, unknown>): void {
  visitSecretCandidates(config, []);
}

function visitSecretCandidates(value: unknown, pathTokens: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      visitSecretCandidates(entry, [...pathTokens, String(index)]);
    });
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, entry] of Object.entries(value)) {
    const nextPath = [...pathTokens, key];
    if (
      typeof entry === 'string' &&
      entry.length > 0 &&
      SENSITIVE_KEY_PATTERN.test(key) &&
      !SAFE_REFERENCE_PATTERN.test(entry)
    ) {
      throw new Error(
        `Literal secret-like value must use an env/file reference: ${nextPath.join('.')}`
      );
    }
    visitSecretCandidates(entry, nextPath);
  }
}

function buildHeaderEnvVar(serverName: string, headerName: string): string {
  if (/^[A-Z0-9_]+$/.test(headerName)) {
    return headerName;
  }
  return buildEnvVar(serverName, headerName);
}

function buildEnvVar(serverName: string, key: string): string {
  const serverToken = toEnvToken(serverName, 'SERVER');
  const keyToken = toEnvToken(key, 'VALUE');
  return `opencode_mcp_${serverToken}_${keyToken}`;
}

function toEnvToken(input: string, fallback: string): string {
  const cleaned = String(input)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return fallback;
  return cleaned.toUpperCase();
}

function buildHeaderPlaceholder(value: string, envVar: string, headerName?: string): string {
  if (!isAuthorizationHeader(headerName)) {
    return `{env:${envVar}}`;
  }

  const schemeMatch = value.match(/^([A-Za-z][A-Za-z0-9+.-]*)\s+/);
  if (schemeMatch) {
    return `${schemeMatch[0]}{env:${envVar}}`;
  }
  return `{env:${envVar}}`;
}

function isAuthorizationHeader(headerName?: string): boolean {
  if (!headerName) return false;
  const normalized = headerName.toLowerCase();
  return normalized === 'authorization' || normalized === 'proxy-authorization';
}

function setNestedValue(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const next = current[key];
    if (!isPlainObject(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[path[path.length - 1]] = value;
}

function getPlainObject(value: unknown): Record<string, unknown> | null {
  return isPlainObject(value) ? (value as Record<string, unknown>) : null;
}

function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
}

export function mergeOverrides(
  base: Record<string, unknown>,
  extra: Record<string, unknown>
): Record<string, unknown> {
  return deepMerge(base, extra) as Record<string, unknown>;
}

export function stripOverrideKeys(
  base: Record<string, unknown>,
  toRemove: Record<string, unknown>
): Record<string, unknown> {
  if (!isPlainObject(base) || !isPlainObject(toRemove)) {
    return base;
  }

  const result: Record<string, unknown> = { ...base };

  for (const [key, removeValue] of Object.entries(toRemove)) {
    if (!hasOwn(result, key)) continue;
    const currentValue = result[key];
    if (isPlainObject(removeValue) && isPlainObject(currentValue)) {
      const stripped = stripOverrideKeys(
        currentValue as Record<string, unknown>,
        removeValue as Record<string, unknown>
      );
      if (Object.keys(stripped).length === 0) {
        delete result[key];
      } else {
        result[key] = stripped;
      }
      continue;
    }

    delete result[key];
  }

  return result;
}

export function hasOverrides(value: Record<string, unknown>): boolean {
  return Object.keys(value).length > 0;
}
