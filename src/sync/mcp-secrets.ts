import { deepMerge, hasOwn, isPlainObject } from './config.js';

export interface McpSecretExtraction {
  sanitizedConfig: Record<string, unknown>;
  secretOverrides: Record<string, unknown>;
}

const ENV_PLACEHOLDER_PATTERN = /\{env:[^}]+\}/i;

export class McpSecretExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpSecretExtractionError';
  }
}

export function extractMcpSecrets(config: Record<string, unknown>): McpSecretExtraction {
  const sanitizedConfig = cloneConfig(config);
  const secretOverrides: Record<string, unknown> = {};

  const mcp = getPlainObject(sanitizedConfig.mcp);
  if (!mcp) {
    return { sanitizedConfig, secretOverrides };
  }

  for (const [serverName, serverConfigValue] of Object.entries(mcp)) {
    if (serverName === '__proto__') {
      throw new McpSecretExtractionError(
        'Unsafe MCP server field "mcp.__proto__" is not allowed during secret scrubbing.'
      );
    }
    const serverConfig = getPlainObject(serverConfigValue);
    if (!serverConfig) continue;

    const headers = getPlainObject(serverConfig.headers);
    if (headers) {
      for (const [headerName, headerValue] of Object.entries(headers)) {
        if (typeof headerValue !== 'string') {
          throw new McpSecretExtractionError(
            `MCP credential field ${formatFieldPath([
              'mcp',
              serverName,
              'headers',
              headerName,
            ])} must be a string before it can be synchronized.`
          );
        }
        if (headerValue.length === 0) {
          throw new McpSecretExtractionError(
            `MCP credential field ${formatFieldPath([
              'mcp',
              serverName,
              'headers',
              headerName,
            ])} must not be empty before it can be synchronized.`
          );
        }
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
      if (hasOwn(oauth, 'clientSecret') && typeof clientSecret !== 'string') {
        throw new McpSecretExtractionError(
          `MCP credential field ${formatFieldPath([
            'mcp',
            serverName,
            'oauth',
            'clientSecret',
          ])} must be a string before it can be synchronized.`
        );
      }
      if (clientSecret === '') {
        throw new McpSecretExtractionError(
          `MCP credential field ${formatFieldPath([
            'mcp',
            serverName,
            'oauth',
            'clientSecret',
          ])} must not be empty before it can be synchronized.`
        );
      }
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

function formatFieldPath(path: string[]): string {
  let result = path[0] ?? '';
  for (const key of path.slice(1)) {
    result += /^[a-zA-Z_$][a-zA-Z0-9_$]*$/u.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
  }
  return `"${result}"`;
}

function setNestedValue(target: Record<string, unknown>, path: string[], value: unknown): void {
  let current = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const key = path[i];
    const next = hasOwn(current, key) ? current[key] : undefined;
    if (!isPlainObject(next)) {
      defineOwnValue(current, key, {});
    }
    current = current[key] as Record<string, unknown>;
  }
  defineOwnValue(current, path[path.length - 1], value);
}

function defineOwnValue(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
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
