# E2E Workflow Notes

## Default Execution

```bash
./.agents/skills/opencode-sync-sandbox/scripts/preflight.sh
./.agents/skills/opencode-sync-sandbox/scripts/run-e2e.sh
```

## Useful Flags

```bash
python3 scripts/e2e/github_two_instance.py --help
python3 scripts/e2e/github_two_instance.py --owner <owner>
python3 scripts/e2e/github_two_instance.py --repo-prefix opencode-sync-e2e
python3 scripts/e2e/github_two_instance.py --model opencode/gpt-5-nano
python3 scripts/e2e/github_two_instance.py --keep-failed-repo
```

## Artifacts

Each run writes logs and results to:

- `.memory/e2e/runs/<run-id>/logs/`
- `.memory/e2e/runs/<run-id>/results/summary.json`
