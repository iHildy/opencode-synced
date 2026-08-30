---
description: Initialize opencode-synced configuration
---

You MUST call the `opencode_sync` tool with `command="init"`.
Do not answer with plain text only.

Argument handling:
- If `$ARGUMENTS` is non-empty, pass `repo="$ARGUMENTS"`.
- If `$ARGUMENTS` is empty, let the tool choose defaults.

Rules:
- Keep repo private unless the user explicitly asked for public.
- A URL or absolute local path refers to a pre-created Git remote; do not claim it can be created or discovered automatically.
- Never put credentials in a repo URL. Authentication must be configured through Git credential helpers or SSH.
- Pass `acknowledgePrivateRemote=true` only when the user explicitly confirms that a non-GitHub remote is private and may receive sensitive sync data.
- Include `includeSecrets` only if explicitly requested.
- Include `includeMcpSecrets` only if explicitly requested and secrets are enabled.
- Include `includeOpencodeSkills` only if explicitly requested.
- Include `includeAgentsDir` only if explicitly requested.
- Include `extraConfigPaths` only if explicitly provided.
