---
description: Install/auth/provision Turso for session sync on this machine
---

You MUST call the `opencode_sync` tool with `command="sessions-setup-turso"`.

Behavior:
- Run Turso CLI install if missing.
- Run headless Turso login when needed.
- Provision/reuse the configured Turso session database and machine-local credential.
