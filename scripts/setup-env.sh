#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${PWD}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-root)
      REPO_ROOT="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "${REPO_ROOT}" ]]; then
  echo "Repository root does not exist: ${REPO_ROOT}" >&2
  exit 1
fi

cd "${REPO_ROOT}"

echo "[setup] Installing dependencies with bun (idempotent)..."
bun install

echo "[setup] Preparing runtime directories..."
mkdir -p \
  "${REPO_ROOT}/.memory" \
  "${REPO_ROOT}/.memory/opencode-upstream" \
  "${REPO_ROOT}/.memory/e2e/runs"

UPSTREAM_DIR="${REPO_ROOT}/.memory/opencode-upstream/opencode"
if [[ -d "${UPSTREAM_DIR}/.git" ]]; then
  echo "[setup] Upstream opencode clone already exists at ${UPSTREAM_DIR}; skipping clone."
else
  echo "[setup] Cloning upstream opencode into ${UPSTREAM_DIR}..."
  git clone --depth=1 "https://github.com/anomalyco/opencode" "${UPSTREAM_DIR}"
fi

echo "[setup] Done."
