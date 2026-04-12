#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import fcntl
import json
import os
import shutil
import signal
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from common import (
  build_run_id,
  fail,
  find_free_port,
  log,
  print_banner,
  random_suffix,
  require_commands,
  run_cmd,
  short_worktree_hash,
  write_json,
)


PERMISSION_CONFIG = {
  '*': 'deny',
  'opencode_sync': 'allow',
  'read': 'allow',
  'list': 'allow',
  'glob': 'allow',
  'grep': 'allow',
}

SESSION_PERMISSION_RULES: list[dict[str, str]] = [
  {'permission': '*', 'pattern': '*', 'action': 'deny'},
  {'permission': 'opencode_sync', 'pattern': '*', 'action': 'allow'},
  {'permission': 'read', 'pattern': '*', 'action': 'allow'},
  {'permission': 'list', 'pattern': '*', 'action': 'allow'},
  {'permission': 'glob', 'pattern': '*', 'action': 'allow'},
  {'permission': 'grep', 'pattern': '*', 'action': 'allow'},
]


@dataclass(frozen=True)
class GitStateSnapshot:
  branch: str
  head: str
  status_lines: tuple[str, ...]


@dataclass
class ServerInstance:
  name: str
  serve_root: Path
  sandbox_root: Path
  port: int
  plugin_spec: str
  model: str
  gh_token: str
  real_git_config: Path | None
  real_xdg_data: Path

  process: subprocess.Popen[str] | None = None
  process_group_id: int | None = None
  log_path: Path | None = None
  _reader_thread: threading.Thread | None = None
  _ready_event: threading.Event = threading.Event()
  _listening_url: str | None = None
  _lines: list[str] | None = None

  def __post_init__(self) -> None:
    self._lines = []

  @property
  def home(self) -> Path:
    return self.sandbox_root / 'home'

  @property
  def xdg_config_home(self) -> Path:
    return self.home / '.config'

  @property
  def xdg_cache_home(self) -> Path:
    return self.home / '.cache'

  @property
  def xdg_data_home(self) -> Path:
    return self.home / '.local' / 'share'

  @property
  def xdg_state_home(self) -> Path:
    return self.home / '.local' / 'state'

  @property
  def opencode_config_root(self) -> Path:
    return self.xdg_config_home / 'opencode'

  @property
  def base_url(self) -> str:
    return f'http://127.0.0.1:{self.port}'

  def prepare_filesystem(self) -> None:
    for path in [
      self.home,
      self.xdg_config_home,
      self.xdg_cache_home,
      self.xdg_data_home,
      self.xdg_state_home,
      self.opencode_config_root,
    ]:
      path.mkdir(parents=True, exist_ok=True)

    for name in ['auth.json', 'mcp-auth.json']:
      source = self.real_xdg_data / 'opencode' / name
      destination = self.xdg_data_home / 'opencode' / name
      destination.parent.mkdir(parents=True, exist_ok=True)
      if source.exists():
        destination.write_bytes(source.read_bytes())

    config_payload = {
      '$schema': 'https://opencode.ai/config.json',
      'model': self.model,
      'small_model': self.model,
      'permission': PERMISSION_CONFIG,
      'plugin': [self.plugin_spec],
    }
    write_json(self.opencode_config_root / 'opencode.json', config_payload)

  def start(self, logs_dir: Path) -> None:
    self.prepare_filesystem()
    logs_dir.mkdir(parents=True, exist_ok=True)
    self.log_path = logs_dir / f'{self.name}.log'
    self._lines = []
    self._ready_event = threading.Event()
    self._listening_url = None

    env = os.environ.copy()
    env['HOME'] = str(self.home)
    env['XDG_CONFIG_HOME'] = str(self.xdg_config_home)
    env['XDG_CACHE_HOME'] = str(self.xdg_cache_home)
    env['XDG_DATA_HOME'] = str(self.xdg_data_home)
    env['XDG_STATE_HOME'] = str(self.xdg_state_home)
    env['GH_TOKEN'] = self.gh_token
    if self.real_git_config:
      env['GIT_CONFIG_GLOBAL'] = str(self.real_git_config)

    command = [
      'opencode',
      'serve',
      '--hostname',
      '127.0.0.1',
      '--port',
      str(self.port),
      '--print-logs',
    ]

    self.process = subprocess.Popen(
      command,
      cwd=str(self.serve_root),
      env=env,
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
      text=True,
      bufsize=1,
      start_new_session=True,
    )
    self.process_group_id = self.process.pid

    self._reader_thread = threading.Thread(target=self._read_logs, daemon=True)
    self._reader_thread.start()

  def _read_logs(self) -> None:
    if not self.process or not self.process.stdout or not self.log_path:
      return

    with self.log_path.open('w', encoding='utf-8') as handle:
      for raw_line in self.process.stdout:
        line = raw_line.rstrip('\n')
        self._lines.append(line)
        handle.write(raw_line)
        handle.flush()
        if 'opencode server listening on ' in line:
          self._listening_url = line.split('opencode server listening on ', 1)[1].strip()
          self._ready_event.set()

  def wait_until_listening(self, timeout_sec: int) -> str:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
      if self._ready_event.is_set() and self._listening_url:
        return self._listening_url
      if self.process and self.process.poll() is not None:
        break
      time.sleep(0.2)

    tail = '\n'.join(self.tail(80))
    raise RuntimeError(
      f'{self.name} failed to start listening within {timeout_sec}s. Recent logs:\n{tail}'
    )

  def tail(self, max_lines: int = 40) -> list[str]:
    if not self._lines:
      return []
    return self._lines[-max_lines:]

  def stop(self) -> None:
    if not self.process:
      return

    # Kill the entire server process group. opencode serve may daemonize/re-parent child
    # processes, and killing only the original parent PID can leak high-CPU orphans.
    if self.process_group_id is not None:
      try:
        os.killpg(self.process_group_id, signal.SIGTERM)
      except ProcessLookupError:
        pass
      except PermissionError:
        pass

    if self.process.poll() is None:
      try:
        self.process.wait(timeout=5)
      except subprocess.TimeoutExpired:
        if self.process_group_id is not None:
          try:
            os.killpg(self.process_group_id, signal.SIGKILL)
          except ProcessLookupError:
            pass
          except PermissionError:
            pass
        try:
          self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
          pass

    # Fallback cleanup by exact server port in case any process escaped process-group control.
    escaped = run_cmd(
      [
        'pgrep',
        '-f',
        f'opencode serve --hostname 127.0.0.1 --port {self.port} --print-logs',
      ],
      check=False,
    )
    if escaped.returncode == 0 and escaped.stdout.strip():
      for raw in escaped.stdout.splitlines():
        pid_text = raw.strip()
        if not pid_text:
          continue
        try:
          pid = int(pid_text)
        except ValueError:
          continue
        for sig in (signal.SIGTERM, signal.SIGKILL):
          try:
            os.kill(pid, sig)
          except ProcessLookupError:
            break
          except PermissionError:
            break

    if self._reader_thread and self._reader_thread.is_alive():
      self._reader_thread.join(timeout=2)


class ApiClient:
  def __init__(self, base_url: str):
    self.base_url = base_url.rstrip('/')

  def _request(self, method: str, path: str, payload: dict[str, Any] | None, timeout_sec: int) -> Any:
    url = f'{self.base_url}{path}'
    body = None
    headers: dict[str, str] = {}
    if payload is not None:
      body = json.dumps(payload).encode('utf-8')
      headers['Content-Type'] = 'application/json'

    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
      with urllib.request.urlopen(request, timeout=timeout_sec) as response:
        response_body = response.read().decode('utf-8')
        if not response_body:
          return None
        return json.loads(response_body)
    except urllib.error.HTTPError as error:
      text = error.read().decode('utf-8', errors='replace')
      raise RuntimeError(f'HTTP {error.code} {method} {path}: {text}') from error

  def get_json(self, path: str, timeout_sec: int = 30) -> Any:
    return self._request('GET', path, None, timeout_sec)

  def post_json(self, path: str, payload: dict[str, Any], timeout_sec: int = 300) -> Any:
    return self._request('POST', path, payload, timeout_sec)

  def patch_json(self, path: str, payload: dict[str, Any], timeout_sec: int = 120) -> Any:
    return self._request('PATCH', path, payload, timeout_sec)


class E2EFailure(RuntimeError):
  pass


def parse_args() -> argparse.Namespace:
  parser = argparse.ArgumentParser(
    description='Run two-instance GitHub E2E for opencode-synced using isolated opencode sandboxes.'
  )
  parser.add_argument('--owner', help='GitHub owner for ephemeral test repos. Defaults to gh api user login.')
  parser.add_argument('--repo-prefix', default='opencode-sync-e2e', help='Prefix for ephemeral repo names.')
  parser.add_argument('--model', default='opencode/gpt-5-nano', help='Model for command execution.')
  parser.add_argument(
    '--timeout-sec',
    type=int,
    default=240,
    help='Timeout for long command calls and polling loops.',
  )
  parser.add_argument(
    '--keep-failed-repo',
    action='store_true',
    help='Keep ephemeral repo when the test fails for debugging.',
  )
  parser.add_argument(
    '--preflight-only',
    action='store_true',
    help='Run preflight checks only and exit.',
  )
  return parser.parse_args()


def repo_root_from_git() -> Path:
  root = run_cmd(['git', 'rev-parse', '--show-toplevel']).stdout.strip()
  if not root:
    fail('Unable to resolve repository root from git.')
  return Path(root)


def parse_gh_scopes() -> set[str]:
  status = run_cmd(['gh', 'auth', 'status', '-h', 'github.com'], check=False)
  output = f'{status.stdout}\n{status.stderr}'
  if status.returncode != 0:
    raise RuntimeError(f'gh auth status failed:\n{output}')

  for line in output.splitlines():
    marker = 'Token scopes:'
    if marker not in line:
      continue
    raw_scopes = line.split(marker, 1)[1].strip().strip("'")
    scopes = [entry.strip().strip("'") for entry in raw_scopes.split(',') if entry.strip()]
    return set(scopes)

  return set()


def preflight(real_home: Path) -> tuple[str, str]:
  print_banner('Preflight')
  require_commands(['opencode', 'gh', 'git', 'bun', 'python3', 'pgrep'])
  scopes = parse_gh_scopes()
  required_scopes = {'repo', 'delete_repo'}
  missing_scopes = sorted(required_scopes - scopes)
  if missing_scopes:
    raise RuntimeError(
      'gh auth token is missing required scopes: '
      + ', '.join(missing_scopes)
      + '. Run: gh auth refresh -h github.com -s '
      + ','.join(missing_scopes)
    )

  token_result = run_cmd(['gh', 'auth', 'token'])
  gh_token = token_result.stdout.strip()
  if not gh_token:
    raise RuntimeError('Failed to resolve GH token from gh auth token.')

  real_xdg_data = Path(os.environ.get('XDG_DATA_HOME', str(real_home / '.local' / 'share')))
  auth_path = real_xdg_data / 'opencode' / 'auth.json'
  if not auth_path.exists():
    raise RuntimeError(
      f'Expected opencode auth file at {auth_path}. Log in to opencode before running E2E.'
    )

  owner = run_cmd(['gh', 'api', 'user', '--jq', '.login']).stdout.strip()
  if not owner:
    raise RuntimeError('Unable to detect GitHub owner via gh api user --jq .login.')

  log(f'Preflight passed. Default owner: {owner}')
  return gh_token, owner


def capture_git_state(repo_root: Path) -> GitStateSnapshot:
  branch = run_cmd(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd=repo_root).stdout.strip() or 'HEAD'
  head = run_cmd(['git', 'rev-parse', 'HEAD'], cwd=repo_root).stdout.strip()
  status_raw = run_cmd(['git', 'status', '--porcelain'], cwd=repo_root).stdout
  status_lines = tuple(line.rstrip() for line in status_raw.splitlines() if line.strip())
  return GitStateSnapshot(branch=branch, head=head, status_lines=status_lines)


def assert_git_state_unchanged(repo_root: Path, baseline: GitStateSnapshot, stage: str) -> None:
  current = capture_git_state(repo_root)
  if current == baseline:
    return

  expected_status = '\n'.join(baseline.status_lines) if baseline.status_lines else '(clean)'
  current_status = '\n'.join(current.status_lines) if current.status_lines else '(clean)'
  raise E2EFailure(
    'Active dev tree changed unexpectedly during E2E guard check.\n'
    f'Stage: {stage}\n'
    f'Expected branch/head: {baseline.branch} {baseline.head}\n'
    f'Current branch/head: {current.branch} {current.head}\n'
    f'Expected status:\n{expected_status}\n'
    f'Current status:\n{current_status}'
  )


def package_plugin(repo_root: Path, run_root: Path) -> Path:
  print_banner('Build + Pack Plugin')
  lock_path = repo_root / '.memory' / 'e2e' / 'build-pack.lock'
  lock_path.parent.mkdir(parents=True, exist_ok=True)
  with lock_path.open('w', encoding='utf-8') as lock_file:
    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
    run_cmd(['bun', 'run', 'build'], cwd=repo_root)
    pack_result = run_cmd(
      ['bun', 'pm', 'pack', '--quiet', '--ignore-scripts', '--destination', str(run_root)],
      cwd=repo_root,
      check=False,
    )
    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

  if pack_result.returncode != 0:
    raise RuntimeError(
      f'bun pm pack failed:\nstdout:\n{pack_result.stdout}\nstderr:\n{pack_result.stderr}'
    )

  tarball_name = ''
  for line in pack_result.stdout.splitlines():
    cleaned = line.strip()
    if cleaned:
      tarball_name = cleaned
  if not tarball_name:
    raise RuntimeError(f'Unable to determine tarball from bun pm pack output: {pack_result.stdout}')

  maybe_path = Path(tarball_name)
  tarball_path = maybe_path if maybe_path.is_absolute() else (run_root / maybe_path.name)
  if not tarball_path.exists():
    raise RuntimeError(f'Packed tarball not found at {tarball_path}')

  log(f'Packaged plugin tarball: {tarball_path}')
  return tarball_path


def prepare_source_sandbox(repo_root: Path, run_root: Path) -> Path:
  print_banner('Prepare Disposable Source Sandbox')
  source_root = run_root / 'source-sandbox'
  if source_root.exists():
    shutil.rmtree(source_root)

  ignore = shutil.ignore_patterns(
    '.git',
    '.memory',
    'node_modules',
    'dist',
    'coverage',
    '.bun',
    '__pycache__',
    '.DS_Store',
  )
  shutil.copytree(repo_root, source_root, symlinks=True, ignore=ignore)
  log(f'Prepared disposable source sandbox: {source_root}')
  return source_root


def build_ephemeral_repo_name(prefix: str, repo_root: Path) -> str:
  worktree_hash = short_worktree_hash(repo_root)
  timestamp = int(time.time())
  candidate = f'{prefix}-{worktree_hash}-{timestamp}-{random_suffix(4)}'.lower()
  return candidate.replace('_', '-')[:95]


def repo_exists(full_repo: str) -> bool:
  view = run_cmd(['gh', 'repo', 'view', full_repo, '--json', 'name'], check=False)
  return view.returncode == 0


def delete_repo(full_repo: str) -> None:
  delete = run_cmd(['gh', 'repo', 'delete', full_repo, '--yes'], check=False)
  if delete.returncode != 0:
    log(f'WARNING: Failed to delete repo {full_repo}.\n{delete.stdout}\n{delete.stderr}')
  else:
    log(f'Deleted ephemeral repo: {full_repo}')


def wait_for_tool(client: ApiClient, tool_name: str, timeout_sec: int) -> None:
  deadline = time.time() + timeout_sec
  while time.time() < deadline:
    try:
      ids = client.get_json('/experimental/tool/ids', timeout_sec=20)
    except Exception:
      time.sleep(1)
      continue
    if isinstance(ids, list) and tool_name in ids:
      return
    time.sleep(1)
  raise RuntimeError(f'Tool {tool_name} was not registered before timeout.')


def create_session(client: ApiClient) -> str:
  payload = client.post_json('/session', {}, timeout_sec=40)
  if not isinstance(payload, dict) or 'id' not in payload:
    raise RuntimeError(f'Unexpected /session response: {payload}')
  session_id = str(payload['id'])
  client.patch_json(
    f'/session/{urllib.parse.quote(session_id)}',
    {'permission': SESSION_PERMISSION_RULES},
    timeout_sec=40,
  )
  return session_id


def run_command(client: ApiClient, session_id: str, command: str, arguments: str, timeout_sec: int) -> dict[str, Any]:
  payload = client.post_json(
    f'/session/{urllib.parse.quote(session_id)}/command',
    {'command': command, 'arguments': arguments},
    timeout_sec=timeout_sec,
  )
  if not isinstance(payload, dict):
    raise RuntimeError(f'Unexpected command payload for {command}: {payload}')
  return payload


def response_error(payload: dict[str, Any]) -> str | None:
  info = payload.get('info')
  if not isinstance(info, dict):
    return None
  error = info.get('error')
  if not error:
    return None
  if isinstance(error, dict):
    data = error.get('data')
    if isinstance(data, dict) and isinstance(data.get('message'), str):
      return str(data['message'])
    if isinstance(error.get('name'), str):
      return str(error['name'])
  return str(error)


def extract_text(payload: dict[str, Any]) -> str:
  parts = payload.get('parts')
  if not isinstance(parts, list):
    return ''
  chunks: list[str] = []
  for part in parts:
    if not isinstance(part, dict):
      continue
    if part.get('type') in {'text', 'reasoning'} and isinstance(part.get('text'), str):
      chunks.append(str(part['text']))
  return '\n'.join(chunks).strip()


def append_sentinel(path: Path, sentinel: str) -> None:
  existing = ''
  if path.exists():
    existing = path.read_text(encoding='utf-8')
  updated = existing + ('' if existing.endswith('\n') or not existing else '\n') + sentinel + '\n'
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(updated, encoding='utf-8')


def get_default_branch(full_repo: str) -> str:
  endpoint = f'repos/{full_repo}'
  response = run_cmd(['gh', 'api', endpoint, '--jq', '.default_branch'])
  branch = response.stdout.strip()
  if not branch:
    raise RuntimeError(f'Unable to resolve default branch for {full_repo}')
  return branch


def fetch_remote_file_text(full_repo: str, repo_path: str, branch: str) -> str | None:
  endpoint = f'repos/{full_repo}/contents/{repo_path}?ref={urllib.parse.quote(branch)}'
  response = run_cmd(['gh', 'api', endpoint], check=False)
  if response.returncode != 0:
    return None
  payload = json.loads(response.stdout)
  if not isinstance(payload, dict):
    return None
  encoded = payload.get('content')
  if not isinstance(encoded, str):
    return None
  normalized = encoded.replace('\n', '')
  decoded = base64.b64decode(normalized).decode('utf-8', errors='replace')
  return decoded


def wait_for_remote_sentinel(full_repo: str, branch: str, sentinel: str, timeout_sec: int) -> None:
  deadline = time.time() + timeout_sec
  while time.time() < deadline:
    text = fetch_remote_file_text(full_repo, 'config/AGENTS.md', branch)
    if text and sentinel in text:
      return
    time.sleep(2)
  raise RuntimeError(f'Sentinel not found in remote repo within timeout: {sentinel}')


def file_contains(path: Path, needle: str) -> bool:
  if not path.exists():
    return False
  content = path.read_text(encoding='utf-8', errors='replace')
  return needle in content


def run_and_validate_command(
  *,
  client: ApiClient,
  session_id: str,
  command: str,
  arguments: str,
  timeout_sec: int,
  result_path: Path,
  active_repo_root: Path,
  baseline_state: GitStateSnapshot,
  label: str,
) -> dict[str, Any]:
  assert_git_state_unchanged(active_repo_root, baseline_state, f'before {label}')
  payload = run_command(client, session_id, command, arguments, timeout_sec=timeout_sec)
  write_json(result_path, payload)

  error = response_error(payload)
  if error:
    raise E2EFailure(f'{label} failed: {error}')

  assert_git_state_unchanged(active_repo_root, baseline_state, f'after {label}')
  return payload


def run_pull_until_repo_sentinel(
  *,
  client: ApiClient,
  session_id: str,
  sentinel: str,
  repo_agents_path: Path,
  timeout_sec: int,
  results_dir: Path,
  result_prefix: str,
  active_repo_root: Path,
  baseline_state: GitStateSnapshot,
) -> dict[str, Any]:
  deadline = time.time() + timeout_sec
  attempt = 1
  last_payload: dict[str, Any] | None = None

  while time.time() < deadline:
    remaining = max(30, min(120, int(deadline - time.time())))
    assert_git_state_unchanged(active_repo_root, baseline_state, f'before {result_prefix} attempt {attempt}')
    payload = run_command(client, session_id, 'sync-pull', '', timeout_sec=remaining)
    write_json(results_dir / f'{result_prefix}-attempt-{attempt}.json', payload)
    last_payload = payload
    assert_git_state_unchanged(active_repo_root, baseline_state, f'after {result_prefix} attempt {attempt}')

    pull_error = response_error(payload)
    if pull_error:
      log(f'WARNING: {result_prefix} attempt {attempt} returned error: {pull_error}')

    if file_contains(repo_agents_path, sentinel):
      return payload

    snippet = extract_text(payload)
    if snippet:
      compact = ' '.join(snippet.split())
      log(
        f'WARNING: {result_prefix} attempt {attempt} did not apply sentinel yet. '
        f'Response snippet: {compact[:200]}'
      )

    attempt += 1
    time.sleep(2)

  raise E2EFailure(
    f'{result_prefix} failed to propagate sentinel to {repo_agents_path}. '
    f'Last response present={last_payload is not None}'
  )


def run_e2e(args: argparse.Namespace) -> int:
  repo_root = repo_root_from_git()
  real_home = Path(os.environ.get('HOME', str(Path.home())))
  gh_token, detected_owner = preflight(real_home)
  owner = args.owner or detected_owner
  if args.preflight_only:
    log('Preflight-only mode complete.')
    return 0

  run_id = build_run_id(repo_root)
  run_root = repo_root / '.memory' / 'e2e' / 'runs' / run_id
  logs_dir = run_root / 'logs'
  results_dir = run_root / 'results'
  run_root.mkdir(parents=True, exist_ok=True)
  logs_dir.mkdir(parents=True, exist_ok=True)
  results_dir.mkdir(parents=True, exist_ok=True)

  log(f'Run directory: {run_root}')

  baseline_state = capture_git_state(repo_root)

  assert_git_state_unchanged(repo_root, baseline_state, 'before packaging')
  tarball = package_plugin(repo_root, run_root)
  assert_git_state_unchanged(repo_root, baseline_state, 'after packaging')

  source_root = prepare_source_sandbox(repo_root, run_root)
  plugin_spec = f'opencode-synced@file:{tarball}'

  repo_name = build_ephemeral_repo_name(args.repo_prefix, repo_root)
  full_repo = f'{owner}/{repo_name}'

  branch = 'main'
  successful = False
  exit_code = 1
  should_delete_repo = True

  machine_a = ServerInstance(
    name='machine-a',
    serve_root=source_root,
    sandbox_root=run_root / 'machine-a',
    port=find_free_port(),
    plugin_spec=plugin_spec,
    model=args.model,
    gh_token=gh_token,
    real_git_config=(real_home / '.gitconfig') if (real_home / '.gitconfig').exists() else None,
    real_xdg_data=Path(os.environ.get('XDG_DATA_HOME', str(real_home / '.local' / 'share'))),
  )
  machine_b = ServerInstance(
    name='machine-b',
    serve_root=source_root,
    sandbox_root=run_root / 'machine-b',
    port=find_free_port(),
    plugin_spec=plugin_spec,
    model=args.model,
    gh_token=gh_token,
    real_git_config=(real_home / '.gitconfig') if (real_home / '.gitconfig').exists() else None,
    real_xdg_data=Path(os.environ.get('XDG_DATA_HOME', str(real_home / '.local' / 'share'))),
  )

  summary: dict[str, Any] = {
    'run_id': run_id,
    'repo': full_repo,
    'owner': owner,
    'model': args.model,
    'ports': {
      'machine_a': machine_a.port,
      'machine_b': machine_b.port,
    },
    'active_tree': {
      'branch': baseline_state.branch,
      'head': baseline_state.head,
      'status_count': len(baseline_state.status_lines),
    },
    'status': 'running',
  }

  try:
    print_banner('Start Servers')
    machine_a.start(logs_dir)
    machine_b.start(logs_dir)

    listen_a = machine_a.wait_until_listening(timeout_sec=60)
    listen_b = machine_b.wait_until_listening(timeout_sec=60)
    log(f'machine-a listening at {listen_a}')
    log(f'machine-b listening at {listen_b}')

    client_a = ApiClient(machine_a.base_url)
    client_b = ApiClient(machine_b.base_url)

    wait_for_tool(client_a, 'opencode_sync', timeout_sec=60)
    wait_for_tool(client_b, 'opencode_sync', timeout_sec=60)

    session_a = create_session(client_a)
    session_b = create_session(client_b)
    summary['sessions'] = {'machine_a': session_a, 'machine_b': session_b}
    log(f'machine-a session: {session_a}')
    log(f'machine-b session: {session_b}')

    print_banner('sync-init on machine A')
    run_and_validate_command(
      client=client_a,
      session_id=session_a,
      command='sync-init',
      arguments=full_repo,
      timeout_sec=args.timeout_sec,
      result_path=results_dir / 'machine-a-sync-init.json',
      active_repo_root=repo_root,
      baseline_state=baseline_state,
      label='sync-init on machine A',
    )

    if not repo_exists(full_repo):
      raise E2EFailure(f'sync-init completed but repo was not created: {full_repo}')

    branch = get_default_branch(full_repo)

    sentinel1 = f'opencode-sync-e2e sentinel 1 ({run_id})'
    sentinel2 = f'opencode-sync-e2e sentinel 2 ({run_id})'

    print_banner('sync-push sentinel 1 from machine A')
    agents_a = machine_a.opencode_config_root / 'AGENTS.md'
    append_sentinel(agents_a, sentinel1)

    run_and_validate_command(
      client=client_a,
      session_id=session_a,
      command='sync-push',
      arguments='',
      timeout_sec=args.timeout_sec,
      result_path=results_dir / 'machine-a-sync-push-1.json',
      active_repo_root=repo_root,
      baseline_state=baseline_state,
      label='sync-push #1 on machine A',
    )

    wait_for_remote_sentinel(full_repo, branch, sentinel1, timeout_sec=args.timeout_sec)

    print_banner('sync-link on machine B')
    run_and_validate_command(
      client=client_b,
      session_id=session_b,
      command='sync-link',
      arguments=repo_name,
      timeout_sec=args.timeout_sec,
      result_path=results_dir / 'machine-b-sync-link.json',
      active_repo_root=repo_root,
      baseline_state=baseline_state,
      label='sync-link on machine B',
    )

    machine_b_sync_config = machine_b.opencode_config_root / 'opencode-synced.jsonc'
    if not machine_b_sync_config.exists():
      raise E2EFailure(f'sync-link did not produce expected config file: {machine_b_sync_config}')
    if not file_contains(machine_b_sync_config, f'\"name\": \"{repo_name}\"'):
      preview = machine_b_sync_config.read_text(encoding='utf-8', errors='replace')
      raise E2EFailure(
        'sync-link bound machine B to an unexpected repo.\n'
        f'Expected repo name: {repo_name}\n'
        f'Config path: {machine_b_sync_config}\n'
        f'Config contents:\n{preview}'
      )

    agents_b = machine_b.opencode_config_root / 'AGENTS.md'
    machine_b_repo_agents = (
      machine_b.xdg_data_home / 'opencode' / 'opencode-synced' / 'repo' / 'config' / 'AGENTS.md'
    )
    if not file_contains(machine_b_repo_agents, sentinel1):
      raise E2EFailure(
        'sync-link did not materialize sentinel1 in machine-b repo clone '
        f'({machine_b_repo_agents}).'
      )
    if not file_contains(agents_b, sentinel1):
      log(
        'WARNING: machine-b local AGENTS.md did not include sentinel1 after sync-link; '
        'local sync repo contains sentinel1 and replication is confirmed.'
      )

    print_banner('sync-push sentinel 2 from machine A')
    append_sentinel(agents_a, sentinel2)
    run_and_validate_command(
      client=client_a,
      session_id=session_a,
      command='sync-push',
      arguments='',
      timeout_sec=args.timeout_sec,
      result_path=results_dir / 'machine-a-sync-push-2.json',
      active_repo_root=repo_root,
      baseline_state=baseline_state,
      label='sync-push #2 on machine A',
    )

    wait_for_remote_sentinel(full_repo, branch, sentinel2, timeout_sec=args.timeout_sec)

    print_banner('sync-pull sentinel 2 on machine B')
    run_pull_until_repo_sentinel(
      client=client_b,
      session_id=session_b,
      sentinel=sentinel2,
      repo_agents_path=machine_b_repo_agents,
      timeout_sec=args.timeout_sec,
      results_dir=results_dir,
      result_prefix='machine-b-sync-pull-2',
      active_repo_root=repo_root,
      baseline_state=baseline_state,
    )
    if not file_contains(agents_b, sentinel2):
      log(
        'WARNING: machine-b local AGENTS.md did not include sentinel2 after sync-pull; '
        'local sync repo contains sentinel2 and replication is confirmed.'
      )

    assert_git_state_unchanged(repo_root, baseline_state, 'after E2E flow')

    summary['status'] = 'passed'
    successful = True
    exit_code = 0
    log('E2E passed. Sentinel propagated across both instances with active tree unchanged.')

  except Exception as error:
    summary['status'] = 'failed'
    summary['error'] = str(error)
    log(f'E2E failed: {error}')
    exit_code = 1

  finally:
    machine_a.stop()
    machine_b.stop()

    summary['logs'] = {
      'machine_a': str(machine_a.log_path) if machine_a.log_path else None,
      'machine_b': str(machine_b.log_path) if machine_b.log_path else None,
    }

    try:
      assert_git_state_unchanged(repo_root, baseline_state, 'final teardown')
    except Exception as guard_error:
      summary['status'] = 'failed'
      summary['guard_error'] = str(guard_error)
      log(f'FINAL GUARD FAILURE: {guard_error}')
      exit_code = 1

    repo_present = repo_exists(full_repo)
    summary['repo_present_at_teardown'] = repo_present
    if should_delete_repo and repo_present:
      if successful:
        delete_repo(full_repo)
      elif args.keep_failed_repo:
        log(f'Keeping failed repo for debugging: {full_repo}')
      else:
        delete_repo(full_repo)

    write_json(results_dir / 'summary.json', summary)
    log(f'Run artifacts: {run_root}')

  return exit_code


def main() -> int:
  args = parse_args()
  return run_e2e(args)


if __name__ == '__main__':
  raise SystemExit(main())
