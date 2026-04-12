---
name: opencode-sync-sandbox
description: Sandbox-first workflow for implementing and validating opencode-synced changes in this repository. Use when you need to plan first, implement a fix, add or update unit/regression tests, and run isolated two-instance GitHub E2E validation without touching global opencode state.
---

# Opencode Sync Sandbox

Follow this workflow whenever a task changes sync behavior, config handling, command behavior, or repo/GitHub integration.

## Required Workflow

1. Create a concrete plan before editing files.
2. Spawn as many subagents as useful for parallelizable work (tests, refactors, docs, investigations).
3. Implement the change in small, reviewable steps.
4. Add or update unit/regression tests for the behavior you changed.
5. Run local checks:
   - `bun run check`
   - `bun test`
   - `bun run build`
6. Run full isolated E2E before declaring success:
   - `./.agents/skills/opencode-sync-sandbox/scripts/run-e2e.sh`
7. Report exact evidence: what changed, what tests ran, and E2E artifact path.

Do not skip E2E for changes that affect sync workflows, path resolution, repo operations, or command execution.

## Sandbox Rules

- Keep all E2E state inside `.memory/e2e/runs/<run-id>/`.
- Never rely on shared global opencode directories for E2E assertions.
- Use the harness-created isolated HOME/XDG sandboxes for each instance.
- Use ephemeral GitHub repos for test runs; keep failed repos only when debugging is needed.

## Upstream Reference Rule

Before changing integration-sensitive behavior, inspect upstream opencode source in:

- `.memory/opencode-upstream/opencode`

Use this clone to confirm command/server/tool behavior and avoid assumptions.

## Helper Scripts

- Preflight only:
  - `./.agents/skills/opencode-sync-sandbox/scripts/preflight.sh`
- Full two-instance GitHub E2E:
  - `./.agents/skills/opencode-sync-sandbox/scripts/run-e2e.sh`

For additional usage flags, run:

- `python3 scripts/e2e/github_two_instance.py --help`
