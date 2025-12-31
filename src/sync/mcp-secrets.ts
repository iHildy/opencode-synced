import { deepMerge } from './config.js';

export interface McpSecretExtraction {
  sanitizedConfig: Record<string, unknown>;
  secretOverrides: Record<string, unknown>;
}

const ENV_PLACEHOLDER_PATTERN = /\{env:[^}]+\}/i;

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
        const placeholder = buildHeaderPlaceholder(String(headerValue), envVar);
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
  return typeof value === 'string' && value.length > 0 && !ENV_PLACEHOLDER_PATTERN.test(value);
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
  return `OPENCODE_MCP_${serverToken}_${keyToken}`;
}

function toEnvToken(input: string, fallback: string): string {
  const cleaned = String(input)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return fallback;
  return cleaned.toUpperCase();
}

function buildHeaderPlaceholder(value: string, envVar: string): string {
  const bearerMatch = value.match(/^Bearer\s+/i);
  if (bearerMatch) {
    return `${bearerMatch[0]}{env:${envVar}}`;
  }
  return `{env:${envVar}}`;
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function cloneConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (typeof structuredClone === 'function') {
    return structuredClone(config);
  }
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
    if (!Object.hasOwn(result, key)) continue;
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
