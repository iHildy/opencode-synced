#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import random
import shlex
import shutil
import socket
import string
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable


def log(message: str) -> None:
  timestamp = time.strftime('%Y-%m-%d %H:%M:%S')
  print(f'[{timestamp}] {message}', flush=True)


def run_cmd(
  args: list[str],
  *,
  cwd: Path | None = None,
  env: dict[str, str] | None = None,
  check: bool = True,
  timeout: int | None = None,
) -> subprocess.CompletedProcess[str]:
  result = subprocess.run(
    args,
    cwd=str(cwd) if cwd else None,
    env=env,
    check=False,
    capture_output=True,
    text=True,
    timeout=timeout,
  )
  if check and result.returncode != 0:
    cmd = shlex.join(args)
    raise RuntimeError(
      f'Command failed ({result.returncode}): {cmd}\nstdout:\n{result.stdout}\nstderr:\n{result.stderr}'
    )
  return result


def require_commands(commands: Iterable[str]) -> None:
  missing = [name for name in commands if shutil.which(name) is None]
  if missing:
    raise RuntimeError(f'Missing required command(s): {", ".join(missing)}')


def find_free_port() -> int:
  with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(('127.0.0.1', 0))
    sock.listen(1)
    return int(sock.getsockname()[1])


def write_json(path: Path, payload: object) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')


def short_worktree_hash(repo_root: Path) -> str:
  digest = hashlib.sha1(str(repo_root.resolve()).encode('utf-8')).hexdigest()
  return digest[:8]


def random_suffix(length: int = 6) -> str:
  chars = string.ascii_lowercase + string.digits
  return ''.join(random.choice(chars) for _ in range(length))


def build_run_id(repo_root: Path) -> str:
  return f"{int(time.time())}-{short_worktree_hash(repo_root)}-{os.getpid()}-{random_suffix(5)}"


def xdg_data_home_for_home(home: Path) -> Path:
  return home / '.local' / 'share'


def xdg_state_home_for_home(home: Path) -> Path:
  return home / '.local' / 'state'


def xdg_cache_home_for_home(home: Path) -> Path:
  return home / '.cache'


def xdg_config_home_for_home(home: Path) -> Path:
  return home / '.config'


def ensure_dir(path: Path) -> None:
  path.mkdir(parents=True, exist_ok=True)


def fail(message: str) -> None:
  log(f'ERROR: {message}')
  raise RuntimeError(message)


def dump_text(path: Path, text: str) -> None:
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(text, encoding='utf-8')


def summarize_completed_process(result: subprocess.CompletedProcess[str]) -> str:
  stdout = result.stdout.strip()
  stderr = result.stderr.strip()
  return (
    f'returncode={result.returncode}\n'
    f'stdout={stdout[:500]}\n'
    f'stderr={stderr[:500]}'
  )


def print_banner(title: str) -> None:
  border = '=' * max(12, len(title) + 4)
  log(border)
  log(f'= {title} =')
  log(border)


if __name__ == '__main__':
  print('common.py is a helper module and should be imported, not executed.', file=sys.stderr)
  sys.exit(1)
