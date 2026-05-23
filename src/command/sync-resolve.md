---
description: Resolve uncommitted changes / Разрешить незакоммиченные изменения в репозитории
---

You MUST call the `opencode_sync` tool with `command="resolve"`.
Do not answer with plain text only.

Behavior:
- The tool analyzes uncommitted changes using AI and decides whether to commit or discard them.
- After resolution, the user can retry the failed command.
- If AI analysis is not available, the tool falls back to manual resolution instructions.
