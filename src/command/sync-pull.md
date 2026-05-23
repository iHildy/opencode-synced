---
description: Pull and apply synced config / Загрузить и применить синхронизированную конфигурацию
---

You MUST call the `opencode_sync` tool with `command="pull"`.
Do not answer with plain text only.

Reminder:
- Pull applies remote config to local — after a successful pull, tell the user to restart opencode.
- If the local repo has uncommitted changes, pull will fail — suggest /sync-resolve first.
