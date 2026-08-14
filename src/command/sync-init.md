---
description: Initialize opencode-synced configuration
---

Use the opencode_sync tool with command "init".
The repo will be created automatically if it doesn't exist (private by default).
Default repo name is "my-opencode-config" with owner auto-detected from GitHub CLI.
If the user wants a custom repo name, pass name="custom-name".
If the user wants an org-owned repo, pass owner="org-name".
Pass includeSkills, includeModelFavorites, and includeModelSelectors for portable state.
Prompt history and stash require a private repo plus acknowledgePlaintextPromptRisk=true.
Secrets, sessions, arbitrary extra paths, overrides, and sync configuration are never synced.
