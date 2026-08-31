# Changelog

All notable changes to this project will be documented here by Release Please.

## [0.10.1](https://github.com/iHildy/opencode-synced/compare/v0.10.0...v0.10.1) (2026-08-31)


### Bug Fixes

* preserve release version in smoke workflow ([PR #79](https://github.com/iHildy/opencode-synced/pull/79)) ([22ef5c1](https://github.com/iHildy/opencode-synced/commit/22ef5c17fcbd9a445229ca78b80a80bdb88bdc1d))
* unblock release publication workflows ([PR #77](https://github.com/iHildy/opencode-synced/pull/77)) ([7b93df6](https://github.com/iHildy/opencode-synced/commit/7b93df6d9a0d4f715956e01bad453d3a7f44fe37))

## [0.10.0](https://github.com/iHildy/opencode-synced/compare/v0.9.0...v0.10.0) (2026-08-31)

This release substantially expands what can be synced and how safely it can move between
machines. It also adds isolated end-to-end coverage for the supported workflows.

### Secrets and private configuration

* Add a 1Password-backed secrets store, machine-local backend configuration, and
  `sync-secrets-pull`, `sync-secrets-push`, and `sync-secrets-status` commands. Auth files stay
  out of Git when the backend is enabled, backend actions validate before running, and original
  1Password errors remain available for diagnosis. See [PR #35](https://github.com/iHildy/opencode-synced/pull/35)
  and [issue #34](https://github.com/iHildy/opencode-synced/issues/34).
* Resolve `{env:VAR}` placeholders from local overrides at runtime without writing resolved
  credentials to the sync repository or logs. Missing variables, malformed credentials, and
  unsafe keys fail closed, while secret-bearing override files use mode `0600`. See
  [PR #47](https://github.com/iHildy/opencode-synced/pull/47) and
  [issue #44](https://github.com/iHildy/opencode-synced/issues/44).
* Strip local-only override keys even when the base repository config contains the same key, so
  pushes no longer restore values that should remain machine-local. See
  [PR #50](https://github.com/iHildy/opencode-synced/pull/50) and
  [issue #49](https://github.com/iHildy/opencode-synced/issues/49).

### Sessions and storage

* Support both OpenCode's SQLite session database and legacy session directories, including
  SQLite sidecars, preserve-on-missing behavior, restart guidance after pull, and feature-specific
  E2E coverage. See [PR #53](https://github.com/iHildy/opencode-synced/pull/53).
* Add an opt-in Turso session backend for concurrent-safe multi-machine sync, with setup,
  migration, backend-selection, and Git-cleanup commands. Git remains the default backend. See
  [PR #54](https://github.com/iHildy/opencode-synced/pull/54).
* Make repository selection deterministic during link and Turso E2E flows, while accepting
  explicit GitHub HTTPS and SSH references. See [PR #55](https://github.com/iHildy/opencode-synced/pull/55).
* Chunk session files larger than 50 MiB into validated, content-addressed parts. Database bundles
  install atomically, corrupt or unsafe pointers fail closed, and oversized blobs in unpushed Git
  history produce backup and recovery instructions instead of rewriting history automatically.
  See [PR #76](https://github.com/iHildy/opencode-synced/pull/76) and
  [issue #45](https://github.com/iHildy/opencode-synced/issues/45).

### Sync coverage and portability

* Sync `~/.config/opencode/skills/` by default and deduplicate it from extra paths. See
  [PR #56](https://github.com/iHildy/opencode-synced/pull/56) and
  [issue #40](https://github.com/iHildy/opencode-synced/issues/40).
* Sync `~/.agents/` by default, with `includeAgentsDir: false` as an opt-out. This directory can
  contain private instructions or skills, so users should review it before syncing to a shared
  repository. See [PR #57](https://github.com/iHildy/opencode-synced/pull/57).
* Sync canonical plural OpenCode directories such as `agents/`, `commands/`, `modes/`, `plugins/`,
  and `tools/`, while keeping legacy singular directories compatible. See
  [PR #71](https://github.com/iHildy/opencode-synced/pull/71) and
  [issue #67](https://github.com/iHildy/opencode-synced/issues/67).
* Resolve relative extra config and secret paths from the OpenCode config root instead of the
  process working directory. Preserve absolute and home-relative behavior, exact allowlists, and
  repository containment. See [PR #72](https://github.com/iHildy/opencode-synced/pull/72) and
  [issue #43](https://github.com/iHildy/opencode-synced/issues/43).
* Store extra-path manifests in a portable form across different homes and operating systems,
  accept legacy Windows separators, and reject repository paths that escape the sync checkout.
  See [PR #58](https://github.com/iHildy/opencode-synced/pull/58).
* Use current OpenCode config, data, and state paths on Windows, honor explicit XDG overrides, and
  verify path behavior on a real Windows runner. See
  [PR #74](https://github.com/iHildy/opencode-synced/pull/74) and
  [issue #59](https://github.com/iHildy/opencode-synced/issues/59).
* Support pre-created HTTPS, SSH, SCP-style, `file://`, and absolute local Git remotes. Generic
  remotes reject embedded credentials, redact user info, validate branches, and require a
  machine-local privacy acknowledgement before syncing sensitive data. See
  [PR #73](https://github.com/iHildy/opencode-synced/pull/73) and
  [issue #61](https://github.com/iHildy/opencode-synced/issues/61).
* Sync `opencode-synced.jsonc` as a core config item and deduplicate it from extra paths.
* Preserve nested model IDs in `small_model` selectors while retaining invalid-selector handling
  and fallback to `model`. See [PR #70](https://github.com/iHildy/opencode-synced/pull/70) and
  [issue #69](https://github.com/iHildy/opencode-synced/issues/69).

### Testing, documentation, and releases

* Add an isolated two-instance GitHub E2E system with per-run HOME and XDG sandboxes, dynamic
  ports, exact plugin packaging, strict cleanup, parallel-run safety, and feature variants for
  sessions and secrets. See [PR #52](https://github.com/iHildy/opencode-synced/pull/52).
* Expand the README and dedicated 1Password documentation for secrets, session backends,
  migration, restart behavior, default synced directories, privacy controls, and non-GitHub
  remotes.
* Harden release publication around canonical commit SHAs, exact packed artifacts, pre-publish and
  post-publish smoke tests, OIDC-only npm publication, immutable prerelease versions, pinned
  actions, and frozen dependency setup. See [PR #75](https://github.com/iHildy/opencode-synced/pull/75).
* Keep the moving `latest` Git tag on the newest stable release. See
  [PR #36](https://github.com/iHildy/opencode-synced/pull/36).

## [0.9.0](https://github.com/iHildy/opencode-synced/compare/v0.8.0...v0.9.0) (2026-01-29)


### Features

* add model favorites sync setting ([ea67233](https://github.com/iHildy/opencode-synced/commit/ea672339a69deda24517c08f0f938efaea1d9080))

## [0.8.0](https://github.com/iHildy/opencode-synced/compare/v0.7.1...v0.8.0) (2026-01-29)


### Features

* support syncing extra config paths ([7cfab68](https://github.com/iHildy/opencode-synced/commit/7cfab681c09e8c0b8308aaf6875b057bfab82f23))


### Bug Fixes

* safe chmod extra path entries ([5b37a7c](https://github.com/iHildy/opencode-synced/commit/5b37a7c55812acef513870b7f015c5215913dbe5))

## [0.7.1](https://github.com/iHildy/opencode-synced/compare/v0.7.0...v0.7.1) (2026-01-05)


### Bug Fixes

* remove uppercase mention ([9e3e022](https://github.com/iHildy/opencode-synced/commit/9e3e022ac1dcb29870af6593236d8b001f72fb27))

## [0.7.0](https://github.com/iHildy/opencode-synced/compare/v0.6.0...v0.7.0) (2026-01-01)


### Features

* add file locking and improved chmod handling to fix false bug ([e3382dc](https://github.com/iHildy/opencode-synced/commit/e3382dce421685449e423bbad8b64d6133d80c23))

## [0.6.0](https://github.com/iHildy/opencode-synced/compare/v0.5.1...v0.6.0) (2025-12-31)


### Features

* support trailing commas in config and improve error handling ([00ae89c](https://github.com/iHildy/opencode-synced/commit/00ae89c5e291e9dd32777e27aab03712257ad81d))

## [0.5.1](https://github.com/iHildy/opencode-synced/compare/v0.5.0...v0.5.1) (2025-12-31)


### Bug Fixes

* avoid Object.hasOwn and structuredClone ([198857b](https://github.com/iHildy/opencode-synced/commit/198857bf1f4c01689c4e6c92d2559ae0a38e30df))
* move hasOwn to shared utility and use hasOwnProperty.call ([6919922](https://github.com/iHildy/opencode-synced/commit/6919922f6785d6f1fae2dc09580ca4dfb4746ba9))

## [0.5.0](https://github.com/iHildy/opencode-synced/compare/v0.4.2...v0.5.0) (2025-12-31)


### Features

* implement MCP secret scrubbing and optional sync ([49b8116](https://github.com/iHildy/opencode-synced/commit/49b8116f03c2dd4a37e66f68ed30bb812edc75b5))


### Bug Fixes

* generalize authorization scheme matching in mcp secrets ([3a50890](https://github.com/iHildy/opencode-synced/commit/3a50890d86180c5ded4e1b71a81cf00a6097acf4))

## [0.4.2](https://github.com/iHildy/opencode-synced/compare/v0.4.1...v0.4.2) (2025-12-31)


### Bug Fixes

* harden plugin loading and add pack test ([a230567](https://github.com/iHildy/opencode-synced/commit/a23056704377bcf07805478c38a37b65555daed8))

## [0.4.2](https://github.com/iHildy/opencode-synced/compare/v0.3.0...v0.4.2) (2025-12-31)


### Bug Fixes

* harden plugin load when command assets are missing and broaden module exports
* add production-like local pack test script

## [0.4.1](https://github.com/iHildy/opencode-synced/compare/v0.4.0...v0.4.1) (2025-12-31)


### Bug Fixes

* use .js extensions in missed imports and update convention ([bae3ebb](https://github.com/iHildy/opencode-synced/commit/bae3ebb7fbc3696965190d49d29deaa3e3ca6f3f))

## [0.4.0](https://github.com/iHildy/opencode-synced/compare/v0.3.0...v0.4.0) (2025-12-31)


### Features

* force release 0.4.0 ([e104eab](https://github.com/iHildy/opencode-synced/commit/e104eab65219de06dd0fd2115a66cf1fdcf64cdd))

## [0.3.0](https://github.com/iHildy/opencode-synced/compare/v0.2.0...v0.3.0) (2025-12-31)


### Features

* force release for node compatibility refactor ([ec31b45](https://github.com/iHildy/opencode-synced/commit/ec31b45c355f8777d2e502bb0a5681bc7c929bcf))

## [0.2.0](https://github.com/iHildy/opencode-synced/compare/v0.1.1...v0.2.0) (2025-12-31)


### Features

* add /opencode-sync-resolve command to auto-resolve changes ([35e3545](https://github.com/iHildy/opencode-synced/commit/35e354507bffa7dc380d90fd771f8a3f8424cebe))
* add GitHub user auto-detection and auto-create sync repo ([8998f8c](https://github.com/iHildy/opencode-synced/commit/8998f8cbbf62cd90a50dc8dc064eb31de7303235))
* add prompt stash sync option (includePromptStash) ([2699008](https://github.com/iHildy/opencode-synced/commit/2699008967a48af5f8418d89201172e64152265d))
* add sync-link command and improve repo management ([f7bbc7b](https://github.com/iHildy/opencode-synced/commit/f7bbc7b655efd507d97662203df8d22d13bc64ff))


### Bug Fixes

* address reviewer feedback on startup reliability and toasts ([11d417b](https://github.com/iHildy/opencode-synced/commit/11d417b8d8abad3a2c4a2d0e59c436c2f318fce2))
* adjust repo org/name detection ([b1c0fef](https://github.com/iHildy/opencode-synced/commit/b1c0fef508c3f9ea6e00a42abb033fcbdad18c19))
* improve startup sync reliability and repository validation ([2480fb2](https://github.com/iHildy/opencode-synced/commit/2480fb2f9b2874014eeef992e0b7f2c51a70476e))


### Reverts

* event-driven startup sync in favor of setTimeout delay ([221bf8c](https://github.com/iHildy/opencode-synced/commit/221bf8c04f4fe322f138b204202e4ea2e098f7ad))

## [0.1.1](https://github.com/iHildy/opencode-synced/compare/v0.1.0...v0.1.1) (2025-12-31)


### Bug Fixes

* address reviewer feedback on startup reliability and toasts ([11d417b](https://github.com/iHildy/opencode-synced/commit/11d417b8d8abad3a2c4a2d0e59c436c2f318fce2))
* improve startup sync reliability and repository validation ([2480fb2](https://github.com/iHildy/opencode-synced/commit/2480fb2f9b2874014eeef992e0b7f2c51a70476e))


### Reverts

* event-driven startup sync in favor of setTimeout delay ([221bf8c](https://github.com/iHildy/opencode-synced/commit/221bf8c04f4fe322f138b204202e4ea2e098f7ad))

## 0.1.0 (2025-12-30)

### Features

- **sync**: Initial implementation of opencode configuration sync via GitHub
- **sync**: Support for secrets sync in private repositories
- **sync**: Support for session history sync
- **sync**: Support for prompt stash sync
- **sync**: Added `/sync-*` slash commands for easy management
- **sync**: Added automatic sync on opencode startup
- **sync**: Added AI-powered conflict resolution with `/sync-resolve`
- **sync**: Automatic GitHub repository detection and creation during initialization
