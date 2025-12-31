import type { PluginInput } from '@opencode-ai/plugin';

type Client = PluginInput['client'];

const SERVICE_NAME = 'opencode-synced';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export function createLogger(client: Client) {
  return {
    debug: (message: string, extra?: Record<string, unknown>) =>
      log(client, 'debug', message, extra),
    info: (message: string, extra?: Record<string, unknown>) => log(client, 'info', message, extra),
    warn: (message: string, extra?: Record<string, unknown>) => log(client, 'warn', message, extra),
    error: (message: string, extra?: Record<string, unknown>) =>
      log(client, 'error', message, extra),
  };
}

function log(
  client: Client,
  level: LogLevel,
  message: string,
  extra?: Record<string, unknown>
): void {
  client.app
    .log({
      body: {
        service: SERVICE_NAME,
        level,
        message,
        extra,
      },
    })
    .catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      showToast(client, `Logging failed: ${errorMsg}`, 'error');
    });
}

export async function showToast(
  client: Client,
  message: string,
  variant: 'info' | 'success' | 'warning' | 'error'
): Promise<void> {
  try {
    await client.tui.showToast({
      body: { title: 'opencode-synced plugin', message, variant },
    });
  } catch {
    // Ignore toast failures (e.g. headless mode or early startup).
  }
}

export function unwrapData<T>(response: unknown): T | null {
  if (!response || typeof response !== 'object') return null;
  const maybeError = (response as { error?: unknown }).error;
  if (maybeError) return null;
  if ('data' in response) {
    const data = (response as { data?: T }).data;
    if (data !== undefined) return data;
    return null;
  }
  return response as T;
}

export function extractTextFromResponse(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;

  const parts =
    (response as { parts?: Array<{ type: string; text?: string }> }).parts ??
    (response as { info?: { parts?: Array<{ type: string; text?: string }> } }).info?.parts ??
    [];

  const textPart = parts.find((part) => part.type === 'text' && part.text);
  return textPart?.text?.trim() ?? null;
}

export async function resolveSmallModel(
  client: Client
): Promise<{ providerID: string; modelID: string } | null> {
  try {
    const response = await client.config.get();
    const config = unwrapData<{ small_model?: string; model?: string }>(response);
    if (!config) return null;

    const modelValue = config.small_model ?? config.model;
    if (!modelValue) return null;

    const [providerID, modelID] = modelValue.split('/', 2);
    if (!providerID || !modelID) return null;
    return { providerID, modelID };
  } catch {
    return null;
  }
}
