---
description: Setup Turso for session sync / Настроить Turso для синхронизации сессий
---

You MUST call the `opencode_sync` tool with `command="sessions-setup-turso"`.
Do not answer with plain text only.

Behavior:
- Run Turso CLI install if missing.
- Run headless Turso login when needed.
- Provision/reuse the configured Turso session database and machine-local credential.
