# opencode-synced

Sync global OpenCode configuration across machines via a GitHub repo, with optional secrets support for private repos.

## Features

- Syncs global OpenCode config (`~/.config/opencode`) and related directories
- Optional secrets sync when the repo is private
- Optional session sync to share conversation history across machines
- Optional prompt stash sync to share stashed prompts and history across machines
- Startup auto-sync with restart toast
- Per-machine overrides via `opencode-synced.overrides.jsonc`
- Custom `/sync-*` commands and `opencode_sync` tool

## Requirements

- GitHub CLI (`gh`) installed and authenticated (`gh auth login`)
- Git installed and available on PATH

## Setup

Enable the plugin in your global OpenCode config (OpenCode will install it on next run):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-synced"],
}
```

OpenCode does not auto-update plugins. To update, remove the cached plugin and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/node_modules/opencode-synced
opencode
```

## Configure

### First machine (create new sync repo)

Run `/sync-init` to create a new sync repo:

1. Detects your GitHub username
2. Creates a private repo (`my-opencode-config` by default)
3. Clones the repo and pushes your current config

### Additional machines (link to existing repo)

Run `/sync-link` to connect to your existing sync repo:

1. Searches your GitHub for common sync repo names (prioritizes `my-opencode-config`)
2. Clones and applies the synced config
3. **Overwrites local config** with synced content (preserves your local overrides file)

If auto-detection fails, specify the repo name: `/sync-link my-opencode-config`

After linking, restart OpenCode to apply the synced settings.

### Custom repo name or org

You can specify a custom repo name or use an organization:

- `/sync-init` - Uses `{your-username}/my-opencode-config`
- `/sync-init my-config` - Uses `{your-username}/my-config`
- `/sync-init my-org/team-config` - Uses `my-org/team-config`

<details>
<summary>Manual configuration</summary>

Create `~/.config/opencode/opencode-synced.jsonc`:

```jsonc
{
  "repo": {
    "owner": "your-org",
    "name": "opencode-config",
    "branch": "main",
  },
  "includeSecrets": false,
  "includeSessions": false,
  "includePromptStash": false,
  "extraSecretPaths": [],
}
```

</details>

### Synced paths (default)

- `~/.config/opencode/opencode.json` and `opencode.jsonc`
- `~/.config/opencode/AGENTS.md`
- `~/.config/opencode/agent/`, `command/`, `mode/`, `tool/`, `themes/`, `plugin/`

### Secrets (private repos only)

Enable secrets with `/sync-enable-secrets` or set `"includeSecrets": true`:

- `~/.local/share/opencode/auth.json`
- `~/.local/share/opencode/mcp-auth.json`
- Any extra paths in `extraSecretPaths` (allowlist)

### Sessions (private repos only)

Sync your OpenCode sessions (conversation history from `/sessions`) across machines by setting `"includeSessions": true`. This requires `includeSecrets` to also be enabled since sessions may contain sensitive data.

```jsonc
{
  "repo": { ... },
  "includeSecrets": true,
  "includeSessions": true
}
```

Synced session data:

- `~/.local/share/opencode/storage/session/` - Session files
- `~/.local/share/opencode/storage/message/` - Message history
- `~/.local/share/opencode/storage/part/` - Message parts
- `~/.local/share/opencode/storage/session_diff/` - Session diffs

### Prompt Stash (private repos only)

Sync your stashed prompts and prompt history across machines by setting `"includePromptStash": true`. This requires `includeSecrets` to also be enabled since prompts may contain sensitive data.

```jsonc
{
  "repo": { ... },
  "includeSecrets": true,
  "includePromptStash": true
}
```

Synced prompt data:

- `~/.local/state/opencode/prompt-stash.jsonl` - Stashed prompts
- `~/.local/state/opencode/prompt-history.jsonl` - Prompt history

## Overrides

Create a local-only overrides file at:

```
~/.config/opencode/opencode-synced.overrides.jsonc
```

Overrides are merged into the runtime config and re-applied to `opencode.json(c)` after pull.

## Usage

| Command | Description |
|---------|-------------|
| `/sync-init` | Create a new sync repo (first machine) |
| `/sync-link` | Link to existing sync repo (additional machines) |
| `/sync-status` | Show repo status and last sync times |
| `/sync-pull` | Fetch and apply remote config |
| `/sync-push` | Commit and push local changes |
| `/sync-enable-secrets` | Enable secrets sync (private repos only) |
| `/sync-resolve` | Auto-resolve uncommitted changes using AI |

<details>
<summary>Manual sync (without slash commands)</summary>

### Trigger a sync

Restart OpenCode to run the startup sync flow (pull remote, apply if changed, push local changes if needed).

### Check status

Inspect the local repo directly:

```bash
cd ~/.local/share/opencode/opencode-synced/repo
git status
git log --oneline -5
```

</details>

## Recovery

If the sync repo has uncommitted changes, you can:

1. **Auto-resolve using AI**: Run `/sync-resolve` to let AI analyze and decide whether to commit or discard the changes
2. **Manual resolution**: Navigate to the repo and resolve manually:

```bash
cd ~/.local/share/opencode/opencode-synced/repo
git status
git pull --rebase
```

Then re-run `/sync-pull` or `/sync-push`.

## Removal

<details>
<summary>How to completely remove and delete opencode-synced</summary>

Run this one-liner to remove the plugin from your config, delete local sync files, and delete the GitHub repository:

```bash
bun -e '
  const fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { spawnSync } = require("node:child_process");
  const isWin = os.platform() === "win32", home = os.homedir();
  const configDir = isWin ? path.join(process.env.APPDATA, "opencode") : path.join(home, ".config", "opencode");
  const dataDir = isWin ? path.join(process.env.LOCALAPPDATA, "opencode") : path.join(home, ".local", "share", "opencode");
  ["opencode.json", "opencode.jsonc"].forEach(f => {
    const p = path.join(configDir, f);
    if (fs.existsSync(p)) {
      const c = fs.readFileSync(p, "utf8"), u = c.replace(/"opencode-synced"\s*,?\s*/g, "").replace(/,\s*\]/g, "]");
      if (c !== u) fs.writeFileSync(p, u);
    }
  });
  const scp = path.join(configDir, "opencode-synced.jsonc");
  if (fs.existsSync(scp)) {
    try {
      const c = JSON.parse(fs.readFileSync(scp, "utf8").replace(/\/\/.*/g, ""));
      if (c.repo?.owner && c.repo?.name) {
        const res = spawnSync("gh", ["repo", "delete", `${c.repo.owner}/${c.repo.name}`, "--yes"], { stdio: "inherit" });
        if (res.status !== 0) console.log("\nNote: Repository delete failed. If it is a permission error, run: gh auth refresh -s delete_repo\n");
      }
    } catch (e) {}
  }
  [scp, path.join(configDir, "opencode-synced.overrides.jsonc"), path.join(dataDir, "sync-state.json"), path.join(dataDir, "opencode-synced")].forEach(p => {
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  });
  console.log("opencode-synced removed.");
'
```

### Manual steps
1. Remove `"opencode-synced"` from the `plugin` array in `~/.config/opencode/opencode.json` (or `.jsonc`).
2. Delete the local configuration and state:
   ```bash
   rm ~/.config/opencode/opencode-synced.jsonc
   rm ~/.local/share/opencode/sync-state.json
   rm -rf ~/.local/share/opencode/opencode-synced
   ```
3. (Optional) Delete the backup repository on GitHub via the web UI or `gh repo delete`.

</details>

## Development

- `bun run build`
- `bun run test`
- `bun run lint`


## Prefer a CLI version?

I stumbled upon [opencodesync](https://www.npmjs.com/package/opencodesync) while publishing this plugin.
