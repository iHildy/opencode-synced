---
description: Link this computer to an existing sync repo
---

Use the opencode_sync tool with command "link".
This command is for linking a second (or additional) computer to an existing sync repo that was created on another machine.

IMPORTANT: This will OVERWRITE the local opencode configuration with the contents from the synced repo. The only thing preserved is the local overrides file (opencode-synced.overrides.jsonc).

If the user provides a repo name argument, pass it as name="repo-name".
If no repo name is provided, the tool will automatically search for common sync repo names.

After linking:
- Remind the user to restart opencode to apply the synced config
- Use the same includeSkills, prompt, favorites, and model-selector flags as the first machine
- Prompt flags require acknowledgePlaintextPromptRisk=true and a private repository
- Secrets, sessions, arbitrary extra paths, overrides, and sync configuration stay local
