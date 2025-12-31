---
description: Link this computer to an existing sync repo
---

Use the opencode_sync tool with command "link".
This command is for linking a second (or additional) computer to an existing sync repo that was created on another machine.

IMPORTANT: This will OVERWRITE the local OpenCode configuration with the contents from the synced repo. The only thing preserved is the local overrides file (opencode-synced.overrides.jsonc).

If the user provides a repo name argument, pass it as name="repo-name".
If no repo name is provided, the tool will automatically search for common sync repo names.

After linking:
- Remind the user to restart OpenCode to apply the synced config
- If they want to enable secrets sync, they should run /sync-enable-secrets
