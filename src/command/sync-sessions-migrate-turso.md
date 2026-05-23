---
description: Migrate session sync to Turso / Перенести синхронизацию сессий из git в Turso
---

You MUST call the `opencode_sync` tool with `command="sessions-migrate-turso"`.
Do not answer with plain text only.

Behavior:
- Ensure Turso setup is complete.
- Bootstrap remote Turso sessions from the current local session DB.
- Switch session backend to Turso.
- Preserve existing git session artifacts for temporary fallback.
