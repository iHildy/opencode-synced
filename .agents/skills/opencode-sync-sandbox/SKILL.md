---
name: opencode-sync-sandbox
description: Sandbox-first workflow for implementing and end to end validating opencode-synced changes. Use when making any changes that effect the opencode-synced opencode plugin. Unless specifically directed not to.
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
   - Run E2E variants that directly exercise the features changed in this task
     (for example: sessions, secrets, or other changed sync flags/paths).
7. Report exact evidence: what changed, what tests ran, and an E2E artifact review.

Do not skip E2E for changes that affect sync workflows, path resolution, repo operations, or command execution.

## E2E Reporting Requirements

- Do not report the E2E artifact path unless the user explicitly asks for it.
- Read `results/summary.json`, command result payloads under `results/`, and relevant `logs/*.log` tails.
- Summarize the executed flow, pass/fail status, key warnings/errors, and any suspicious signals.
- If warnings exist, explain whether they are expected, tolerated, or need follow-up.
- For feature-flagged runs, report the exact artifact-level behavior for each changed feature (including restart requirements when relevant).

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
  - Enable secrets coverage:
    `./.agents/skills/opencode-sync-sandbox/scripts/run-e2e.sh --enable-secrets`
  - Enable session database coverage (implies secrets):
    `./.agents/skills/opencode-sync-sandbox/scripts/run-e2e.sh --enable-sessions`

For additional usage flags, run:

- `python3 scripts/e2e/github_two_instance.py --help`
