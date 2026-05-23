---
description: Enable secrets sync / Включить синхронизацию секретов (требуется приватный репозиторий)
---

You MUST call the `opencode_sync` tool with `command="enable-secrets"`.
Do not answer with plain text only.

Argument handling:
- If the user supplies extra secret paths, pass them via `extraSecretPaths`.
- If they want MCP secrets committed in a private repo, pass `includeMcpSecrets: true`.

Reminder:
- Enabling secrets requires the sync repo to be private — the tool will enforce this.
- Secrets are synced via a configured backend (e.g., 1Password), not stored in git directly.
