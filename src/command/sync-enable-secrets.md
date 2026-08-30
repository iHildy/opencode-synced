---
description: Enable secrets sync (private repo required)
---

Use the opencode_sync tool with command "enable-secrets".
If the user supplies extra secret paths, pass them via extraSecretPaths.
If they want MCP secrets committed in a private repo, pass includeMcpSecrets: true.

For a non-GitHub remote, privacy cannot be verified automatically. Pass
`acknowledgePrivateRemote=true` only if the user explicitly confirms that the exact remote is
private and may receive secrets or session data. Never infer this acknowledgement. It is stored
locally for that remote and is not synced.
