---
description: Initialize opencode-synced configuration
---

Use the opencode_sync tool with command "init".
The repo will be created automatically if it doesn't exist (private by default).
Default repo name is "my-opencode-config" with owner auto-detected from GitHub CLI.
If the user wants a custom repo name, pass name="custom-name".
If the user wants an org-owned repo, pass owner="org-name".
If the user wants a public repo, pass private=false.
Include includeSecrets if the user explicitly opts in.
Include includeMcpSecrets only if they want MCP secrets committed to a private repo.
