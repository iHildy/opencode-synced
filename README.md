# @tsunamik/opencode-synced

Hardened, narrow OpenCode configuration and state synchronization for trusted machines.
This project is a fork of [iHildy/opencode-synced](https://github.com/iHildy/opencode-synced)
based on the upstream `v0.9.0` release.

## Scope

Supported synchronized data:

- global `opencode.json` or `opencode.jsonc` and `AGENTS.md`
- `agent/`, `command/`, `mode/`, `tool/`, `themes/`, and legacy singular `plugin/`
- global `skills/`
- plaintext prompt history and prompt stash in a private repository
- only the `favorite` projection from `state/opencode/model.json`
- `main-model.txt`, `cheap-model.txt`, and `frontier-model.txt`

Always local and rejected by configuration validation:

- OpenCode authentication and MCP authentication files
- sessions, messages, parts, diffs, and `opencode.db`
- the global `secrets/` directory
- `opencode-synced.jsonc` and `opencode-synced.overrides.jsonc`
- arbitrary extra paths and custom local repository paths

## Important Security Properties

- Prompt synchronization requires a private GitHub repository and the explicit
  `acknowledgePlaintextPromptRisk` setting.
- Private GitHub repositories provide access control, not end-to-end encryption. Prompt
  content remains recoverable from Git history and every clone.
- Remote and local symlinks and unsupported filesystem entries are rejected.
- Skills exclude `__pycache__`, `*.pyc`, `*.pyo`, `.DS_Store`, and
  `*:Zone.Identifier` files.
- Local generated configuration, state, and rollback bundles use owner-only permissions.
- Secrets, sessions, local overrides, and sync configuration cannot be enabled by tool flags.
- The AI-based destructive `/sync-resolve` command is removed.

The sync repository contains active content. A trusted machine can push agents, commands,
skills, MCP commands, or plugin configuration that executes on another linked machine.

## Conflict Policy

The last successful synchronization wins.

Before fetch, the plugin projects the current local managed state into a temporary owner-only
directory. After fetching remote changes, only items that were changed locally are applied on
top of the fetched branch. This preserves unrelated changes from both machines. If both machines
changed the same managed item, the currently synchronizing machine wins.

The displaced remote item remains in Git history and is copied to an owner-only rollback bundle
under the OpenCode state directory. Wall-clock timestamps are never used to choose a winner.

## Requirements

- Git
- GitHub CLI (`gh`) installed and authenticated
- a private GitHub data repository when prompt synchronization is enabled

## Pilot Installation

Build and pack one artifact, then install the exact same artifact checksum on both machines:

```bash
npm install --ignore-scripts --no-package-lock
npm test
npm run build
npm pack --ignore-scripts
```

During the pilot, load the built `dist/index.js` from a local clone or install the packed
artifact into OpenCode's package cache. Do not use a mutable branch reference.

## Configuration

`~/.config/opencode/opencode-synced.jsonc` is local-only:

```jsonc
{
  "repo": {
    "owner": "your-github-user",
    "name": "my-opencode-config",
    "branch": "main"
  },
  "includeSkills": true,
  "includePromptHistory": true,
  "includePromptStash": true,
  "acknowledgePlaintextPromptRisk": true,
  "includeModelFavorites": true,
  "includeModelSelectors": true
}
```

Prompt flags fail unless the risk acknowledgement is exactly `true`. The repository visibility
is checked before prompt data is read or written.

On Windows, sync locations follow OpenCode's XDG-compatible layout: `%USERPROFILE%\.config`,
`%USERPROFILE%\.local\share`, and `%USERPROFILE%\.local\state`. The native `APPDATA` and
`LOCALAPPDATA` roots are not used for sync locations.

## Commands

| Command | Description |
| --- | --- |
| `/sync-init` | Create or initialize the first private sync repository |
| `/sync-link` | Link another machine after making a local backup |
| `/sync-status` | Show repository and operation state |
| `/sync-pull` | Apply the remote state; remote wins for an explicit pull |
| `/sync-push` | Reconcile and push; the current machine wins same-item conflicts |

Linking applies the remote managed scope and may overwrite local files. Back up every machine
before the first link.

## Repository Layout

```text
config/
  opencode.json
  AGENTS.md
  agent/
  command/
  skills/
state/
  model-favorites.json
  model-selectors/
    main-model.txt
    cheap-model.txt
    frontier-model.txt
  prompts/
    prompt-history.jsonl
    prompt-stash.jsonl
```

Legacy `data/`, `secrets/`, raw `state/model.json`, direct prompt files, extra manifests, and
tracked sync configuration cause synchronization to stop with a migration error.

## Model State

Only `model.json.favorite` is stored in Git. Pulling favorites preserves each machine's local
`recent` and `variant` data.

## Prompt State

Prompt files must be valid JSONL and are limited to 16 MiB each. They are synchronized as whole
snapshots. Concurrent same-file changes use the last-successful-sync-wins policy; the losing
snapshot remains recoverable from Git history and the local rollback bundle.

Prompt/model state is synchronized before OpenCode registers the plugin hooks so in-memory TUI
stores do not overwrite freshly imported state during startup. Manual pulls should still be
followed by an OpenCode restart.

## Recovery

- Never force-push the data repository.
- Resolve an unexpected dirty sync clone manually after preserving a copy.
- Revert bad remote changes with a normal Git revert commit.
- Local conflict backups live under the OpenCode state directory in
  `opencode-synced/rollbacks/`.
- Restore the previous pinned plugin artifact to roll back plugin behavior.

## Development

```bash
npm install --ignore-scripts --no-package-lock
npm test
npm run build
npm run lint
```

Architecture and threat-model decisions are documented in
[`docs/extended-sync-v1.md`](docs/extended-sync-v1.md).

## License

MIT, preserving the original upstream copyright and license.
