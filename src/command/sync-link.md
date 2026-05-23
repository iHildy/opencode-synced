---
description: Link to an existing sync repo / Привязать компьютер к существующему репозиторию синхронизации
---

You MUST call the `opencode_sync` tool with `command="link"`.
Do not answer with plain text only.

Argument handling:
- If `$ARGUMENTS` is non-empty, pass `repo="$ARGUMENTS"` exactly as provided. Do not rewrite or shorten it.
- If `$ARGUMENTS` is empty, let the tool auto-discover.

Reminder:
- Linking overwrites local config except local overrides.
- After linking, remind to restart opencode.
