#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${PWD}"
if git_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
  REPO_ROOT="${git_root}"
fi

cd "${REPO_ROOT}"
python3 scripts/e2e/github_two_instance.py --preflight-only "$@"
