---
description: Link this computer to an existing sync repo
---

You MUST call the `opencode_sync` tool with `command="link"`.
Do not answer with plain text only.

Argument handling:
- If `$ARGUMENTS` is non-empty, pass `repo="$ARGUMENTS"` exactly as provided. Do not rewrite or shorten it.
- If `$ARGUMENTS` is empty, let the tool auto-discover.

Reminder:
- Linking overwrites local config except local overrides.
- After linking, remind to restart opencode.
