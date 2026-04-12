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
- Include `includeSecrets` only if explicitly requested.
- Include `includeMcpSecrets` only if explicitly requested and secrets are enabled.
- Include `extraConfigPaths` only if explicitly provided.
