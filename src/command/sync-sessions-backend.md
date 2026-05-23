---
description: Switch session sync backend (git/turso) / Переключить бэкенд синхронизации сессий
---

You MUST call the `opencode_sync` tool with `command="sessions-backend"`.
Do not answer with plain text only.

Argument handling:
- `$ARGUMENTS` must be either `git` or `turso`.
- Pass `sessionBackend` with that exact value.

Behavior:
- If backend is `git`, switch to best-effort git session sync.
- If backend is `turso`, run setup unless the user explicitly asked not to.
