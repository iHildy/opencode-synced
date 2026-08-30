---
description: Link this computer to an existing sync repo
---

You MUST call the `opencode_sync` tool with `command="link"`.
Do not answer with plain text only.

Argument handling:
- If `$ARGUMENTS` is non-empty, pass `repo="$ARGUMENTS"` exactly as provided. Do not rewrite or shorten it.
- If `$ARGUMENTS` is empty, let the tool auto-discover.

Rules:
- Explicit HTTPS, SSH, SCP-style SSH, file, and absolute local remotes are supported.
- Never put credentials in a repo URL. Authentication must be configured through Git credential helpers or SSH.
- Do not pass `acknowledgePrivateRemote=true` unless the user explicitly confirms the non-GitHub remote is private and may receive sensitive sync data.

Reminder:
- Linking overwrites local config except local overrides.
- After linking, remind to restart opencode.
