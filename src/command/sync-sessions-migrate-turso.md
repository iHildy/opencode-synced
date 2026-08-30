---
description: Migrate session sync from git artifacts to Turso backend
---

You MUST call the `opencode_sync` tool with `command="sessions-migrate-turso"`.

Behavior:
- Ensure Turso setup is complete.
- Bootstrap remote Turso sessions from the current local session DB.
- Switch session backend to Turso.
- Preserve existing git session artifacts for temporary fallback.
