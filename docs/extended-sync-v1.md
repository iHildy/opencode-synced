# Extended Sync v1

## Context

The released `opencode-synced` v0.9.0 does not cover the full state needed on two
OpenCode machines. This fork adds a narrow, portable scope without adopting the
unreleased Turso, 1Password, or session-sync changes from upstream `main`.

## Managed data

The fork may synchronize only these paths:

- `opencode.json` or `opencode.jsonc`, `AGENTS.md`, agents, commands, modes, tools,
  themes, and legacy singular plugins
- `skills/`, excluding generated cache and platform metadata
- prompt history and prompt stash as plaintext in a private repository
- the `favorite` projection from `model.json`
- `main-model.txt`, `cheap-model.txt`, and `frontier-model.txt`

The following remain local and are rejected when explicitly enabled:

- authentication files, MCP authentication, and the `secrets/` directory
- sessions and the OpenCode database
- `opencode-synced.jsonc` and `opencode-synced.overrides.jsonc`
- arbitrary extra paths and a custom local repository path

## Conflict policy

The last successful synchronization wins. The operation snapshots local managed
items before fetching. If both local and remote changed since the last applied
commit, the currently synchronizing machine writes its local item in a new commit
whose parent is the fetched remote tip. The displaced remote item is retained in
Git history and an owner-only local rollback bundle.

This policy uses operation order, never wall-clock timestamps.

## Security invariants

- The data repository must be private when prompt synchronization is enabled.
- Remote and local symlinks, gitlinks, devices, sockets, and FIFOs are rejected.
- Every repository path must remain inside the configured repository root.
- Skill cache files (`__pycache__`, `*.pyc`, `*.pyo`) and platform metadata
  (`*:Zone.Identifier`, `.DS_Store`) are excluded.
- Files are staged and atomically renamed instead of overwriting live files in
  place. Directory replacement must preserve a rollback copy until completion.
- On Windows, sync locations follow OpenCode's XDG-compatible `%USERPROFILE%\.config`,
  `%USERPROFILE%\.local\share`, and `%USERPROFILE%\.local\state` roots instead of
  native `APPDATA` and `LOCALAPPDATA` roots.
- Generated local state and overrides use mode `0600`; their parent directory uses
  mode `0700`.
- Secrets, sessions, sync configuration, and overrides are never part of a plan.
- `/sync-resolve` must not run AI over diffs or invoke destructive Git cleanup.

## Model state

Only `model.json.favorite` is portable. Pulling favorites merges that projection
into the local file while preserving local `recent` and `variant` fields.

## Prompt state

Prompt history and stash are synchronized as complete plaintext snapshots in the
private data repository. They are active only after an explicit risk acknowledgement.
Concurrent changes use the general last-successful-sync-wins policy. Git history and
rollback bundles retain prior snapshots.

## Delivery

Development starts from tag `v0.9.0` on `feature/extended-sync-v1`. The pilot uses
one reproducible packed artifact with the same checksum on both machines. Publishing
an npm package is deferred until the two-machine test passes.

## Deferred

- session or database synchronization
- encrypted prompts
- semantic prompt-event merging
- signed commits and review gates
- arbitrary extra paths
- Turso and external secret backends
