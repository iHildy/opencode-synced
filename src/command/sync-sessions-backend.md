---
description: Switch session sync backend between git and turso
---

You MUST call the `opencode_sync` tool with `command="sessions-backend"`.

Argument handling:
- `$ARGUMENTS` must be either `git` or `turso`.
- Pass `sessionBackend` with that exact value.

Behavior:
- If backend is `git`, switch to best-effort git session sync.
- If backend is `turso`, run setup unless the user explicitly asked not to.
