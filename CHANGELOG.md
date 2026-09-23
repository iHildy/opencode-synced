# Changelog

All notable changes to this project will be documented here by Release Please.

## [0.12.0](https://github.com/iHildy/opencode-synced/compare/v0.11.0...v0.12.0) (2026-09-23)


### Features

* add /opencode-sync-resolve command to auto-resolve changes ([a9b2420](https://github.com/iHildy/opencode-synced/commit/a9b24203d186e62291e80982672ac973003f0530))
* add /opencode-sync-resolve command to auto-resolve changes ([35e3545](https://github.com/iHildy/opencode-synced/commit/35e354507bffa7dc380d90fd771f8a3f8424cebe))
* Add file locking and improved chmod handling ([4a143a0](https://github.com/iHildy/opencode-synced/commit/4a143a012f9ac15211d796e9b45bdb68556e808e))
* add file locking and improved chmod handling to fix false bug ([e3382dc](https://github.com/iHildy/opencode-synced/commit/e3382dce421685449e423bbad8b64d6133d80c23))
* add GitHub user auto-detection and auto-create sync repo ([773af26](https://github.com/iHildy/opencode-synced/commit/773af26472f24e4817a43081b8a1a8b6c2e2c391))
* add GitHub user auto-detection and auto-create sync repo ([8998f8c](https://github.com/iHildy/opencode-synced/commit/8998f8cbbf62cd90a50dc8dc064eb31de7303235))
* add injectable AI provider and node shell shim for v2 ([c21227b](https://github.com/iHildy/opencode-synced/commit/c21227b3f1f84bd46040f2e8b5cf31d8be6d3e6d))
* add isolated GitHub two-instance E2E workflow ([#52](https://github.com/iHildy/opencode-synced/issues/52)) ([e5c338f](https://github.com/iHildy/opencode-synced/commit/e5c338f99630a34bc6741e2524ab7fad1d611fbb))
* Add MCP secret scrubbing and optional sync ([7ab9dfb](https://github.com/iHildy/opencode-synced/commit/7ab9dfbf74ce97b78c296040a7fc77d5a79617d2))
* add model favorites sync setting ([30a9326](https://github.com/iHildy/opencode-synced/commit/30a93268df0ac8db245249eae73ba13ed23ddb4f))
* add model favorites sync setting ([ea67233](https://github.com/iHildy/opencode-synced/commit/ea672339a69deda24517c08f0f938efaea1d9080))
* add prompt stash sync option (includePromptStash) ([2699008](https://github.com/iHildy/opencode-synced/commit/2699008967a48af5f8418d89201172e64152265d))
* add secrets backend config support ([f6a56e2](https://github.com/iHildy/opencode-synced/commit/f6a56e28b2f34dd6f6ba08d3cebfc3fc30806048))
* add secrets sync commands ([c29d63a](https://github.com/iHildy/opencode-synced/commit/c29d63a2895eac43c4bb401bfed2597e38fe762d))
* add shared blankEnvPlaceholders helper ([1e6ab65](https://github.com/iHildy/opencode-synced/commit/1e6ab65d3af10e27128f51549dd88598754de7a6))
* Add support syncing extra config paths ([5d09e51](https://github.com/iHildy/opencode-synced/commit/5d09e5181dee9b1997f34cfe431f513ce4089937))
* add sync-link command and improve repo management ([9525687](https://github.com/iHildy/opencode-synced/commit/952568725fc48f6e1f37d2b013536aac28659b95))
* add sync-link command and improve repo management ([f7bbc7b](https://github.com/iHildy/opencode-synced/commit/f7bbc7b655efd507d97662203df8d22d13bc64ff))
* add SyncService.dispose for background timers ([c703436](https://github.com/iHildy/opencode-synced/commit/c703436555d3cbfa54901713ede912ce689cde16))
* force release 0.4.0 ([e104eab](https://github.com/iHildy/opencode-synced/commit/e104eab65219de06dd0fd2115a66cf1fdcf64cdd))
* force release for node compatibility refactor ([ec31b45](https://github.com/iHildy/opencode-synced/commit/ec31b45c355f8777d2e502bb0a5681bc7c929bcf))
* implement MCP secret scrubbing and optional sync ([49b8116](https://github.com/iHildy/opencode-synced/commit/49b8116f03c2dd4a37e66f68ed30bb812edc75b5))
* integrate 1Password secrets backend ([ca6a5bb](https://github.com/iHildy/opencode-synced/commit/ca6a5bb927402d1b302a8691a6add200ea00f3e1))
* support explicit non-GitHub Git remotes ([#73](https://github.com/iHildy/opencode-synced/issues/73)) ([0b46b29](https://github.com/iHildy/opencode-synced/commit/0b46b29733363acacdde28361f3959ec882f083e))
* support opencode v2 plugin API alongside v1 ([f16dec2](https://github.com/iHildy/opencode-synced/commit/f16dec2126de9dbb199d89b1ce1eab63d73c31a2))
* support OpenCode v2 with safe sync tool commands ([d549b0f](https://github.com/iHildy/opencode-synced/commit/d549b0fa8e4e927a0f98c3388e484e5eb4014078))
* support syncing extra config paths ([7cfab68](https://github.com/iHildy/opencode-synced/commit/7cfab681c09e8c0b8308aaf6875b057bfab82f23))
* support trailing commas in config and improve error handling ([378bc1a](https://github.com/iHildy/opencode-synced/commit/378bc1a70476e378a958cf0461aa3cb204808f9b))
* support trailing commas in config and improve error handling ([00ae89c](https://github.com/iHildy/opencode-synced/commit/00ae89c5e291e9dd32777e27aab03712257ad81d))
* sync skills directory by default ([#56](https://github.com/iHildy/opencode-synced/issues/56)) ([a627673](https://github.com/iHildy/opencode-synced/commit/a627673f7a00f9cdcdefe168ba110803c0678b3a))
* update release workflow to maintain latest tag ([d5a0c75](https://github.com/iHildy/opencode-synced/commit/d5a0c751b1e817539af0de484eee8866b0e3a6fd))


### Bug Fixes

* address reviewer feedback on startup reliability and toasts ([11d417b](https://github.com/iHildy/opencode-synced/commit/11d417b8d8abad3a2c4a2d0e59c436c2f318fce2))
* address secrets backend review ([f2eb33b](https://github.com/iHildy/opencode-synced/commit/f2eb33b9ea605a17230b5d43dae9891a59822d0b))
* adjust repo org/name detection ([b1c0fef](https://github.com/iHildy/opencode-synced/commit/b1c0fef508c3f9ea6e00a42abb033fcbdad18c19))
* authenticate OpenCode smoke version lookup ([0e13dc9](https://github.com/iHildy/opencode-synced/commit/0e13dc92405fa7fe4efb9ca79f34c2d46a235d7d))
* authenticate OpenCode smoke version lookup ([ccef85c](https://github.com/iHildy/opencode-synced/commit/ccef85c26c9377fcb0e5202bec969d4c31cbaf11))
* avoid Object.hasOwn and structuredClone ([3248bef](https://github.com/iHildy/opencode-synced/commit/3248bef6df3a7f224fb97dd1c14baf369fcc10ab))
* avoid Object.hasOwn and structuredClone ([198857b](https://github.com/iHildy/opencode-synced/commit/198857bf1f4c01689c4e6c92d2559ae0a38e30df))
* expand e2e coverage and docs for session sync compatibility ([#53](https://github.com/iHildy/opencode-synced/issues/53)) ([78a4f88](https://github.com/iHildy/opencode-synced/commit/78a4f88ad12d72f911c0fa0e7704ff0e305e9852))
* for [#69](https://github.com/iHildy/opencode-synced/issues/69) (nice) `resolveSmallModel` truncated selectors when the model ID itself contained `/`, ([#70](https://github.com/iHildy/opencode-synced/issues/70)) ([9a9ead9](https://github.com/iHildy/opencode-synced/commit/9a9ead9a0a679f0aa6844f89b6d055898aa90183))
* generalize authorization scheme matching in mcp secrets ([3a50890](https://github.com/iHildy/opencode-synced/commit/3a50890d86180c5ded4e1b71a81cf00a6097acf4))
* guard secrets backend validation before actions ([790f850](https://github.com/iHildy/opencode-synced/commit/790f85039b9a2c30ac66979ffdee8d426234e798))
* harden plugin loading and add pack test ([48a5b43](https://github.com/iHildy/opencode-synced/commit/48a5b436ba361c84ec4429cd554f1b9a84dfb173))
* harden plugin loading and add pack test ([a230567](https://github.com/iHildy/opencode-synced/commit/a23056704377bcf07805478c38a37b65555daed8))
* harden release publication pipeline ([#75](https://github.com/iHildy/opencode-synced/issues/75)) ([7e37271](https://github.com/iHildy/opencode-synced/commit/7e37271de21a254c1f8c7d5a35e83c13564a9f6c))
* harden secrets backend integration ([5c37236](https://github.com/iHildy/opencode-synced/commit/5c37236ec76c27125adc9e99156e87622bf9ea8b))
* improve startup reliability, repo validation, and toasts ([4fc999b](https://github.com/iHildy/opencode-synced/commit/4fc999b8f21d0230583f84c625246f085959744f))
* improve startup sync reliability and repository validation ([2480fb2](https://github.com/iHildy/opencode-synced/commit/2480fb2f9b2874014eeef992e0b7f2c51a70476e))
* keep v2 sync status read-only ([4a6c51d](https://github.com/iHildy/opencode-synced/commit/4a6c51d02a27b2fd148791c1e1e9c98b57541fb4))
* move hasOwn to shared utility and use hasOwnProperty.call ([6919922](https://github.com/iHildy/opencode-synced/commit/6919922f6785d6f1fae2dc09580ca4dfb4746ba9))
* portable paths in extra-manifest for cross-platform sync ([#58](https://github.com/iHildy/opencode-synced/issues/58)) ([96836af](https://github.com/iHildy/opencode-synced/commit/96836afd19737caba1bca03716a98cd4540c620f))
* preserve original 1password errors ([e67d675](https://github.com/iHildy/opencode-synced/commit/e67d6755a0c2024782b4eb2ec6da73f4a2223344))
* preserve release version in smoke workflow ([#79](https://github.com/iHildy/opencode-synced/issues/79)) ([22ef5c1](https://github.com/iHildy/opencode-synced/commit/22ef5c17fcbd9a445229ca78b80a80bdb88bdc1d))
* preserve valid v2 MCP override siblings ([5f4f15e](https://github.com/iHildy/opencode-synced/commit/5f4f15e547e6bc41f999b70917a3b3108f1ace0d))
* record session restoration as a pull ([2c65e4d](https://github.com/iHildy/opencode-synced/commit/2c65e4d7faa301696efe22ca6c9be12e3afc1804))
* remove uppercase mention ([9e3e022](https://github.com/iHildy/opencode-synced/commit/9e3e022ac1dcb29870af6593236d8b001f72fb27))
* resolve relative extra paths from config root ([#72](https://github.com/iHildy/opencode-synced/issues/72)) ([10a3a83](https://github.com/iHildy/opencode-synced/commit/10a3a83b7798ce625ccb636aeb06ab7710d11a3c))
* restore Git sessions on link and pull ([c475c61](https://github.com/iHildy/opencode-synced/commit/c475c61468533a5c68288c9956a3998154c57c36))
* restore Git sessions on link and pull ([a7fc170](https://github.com/iHildy/opencode-synced/commit/a7fc17044372ea299194822db37ed8edb04ec8c6))
* safe chmod extra path entries ([5b37a7c](https://github.com/iHildy/opencode-synced/commit/5b37a7c55812acef513870b7f015c5215913dbe5))
* safely resolve MCP environment overrides ([#47](https://github.com/iHildy/opencode-synced/issues/47)) ([2f0ebea](https://github.com/iHildy/opencode-synced/commit/2f0ebea239cfee0923e5e5d6833e1a0882e6c2a5))
* safely sync large session files ([#76](https://github.com/iHildy/opencode-synced/issues/76)) ([5be4e06](https://github.com/iHildy/opencode-synced/commit/5be4e067d234121917c160ba79204b0e441ebf4a))
* strip overrides removes keys missing from local config ([#49](https://github.com/iHildy/opencode-synced/issues/49)) ([#50](https://github.com/iHildy/opencode-synced/issues/50)) ([f87ca69](https://github.com/iHildy/opencode-synced/commit/f87ca69810de342f73ad87a4ab30c5fd17260540))
* sync opencode-synced config ([034bbe8](https://github.com/iHildy/opencode-synced/commit/034bbe8feb72cf4f2306399788dca5d897d50283))
* sync plural OpenCode config directories ([#71](https://github.com/iHildy/opencode-synced/issues/71)) ([2f4fe70](https://github.com/iHildy/opencode-synced/commit/2f4fe700dd1776a907fdc74f4565cf50c234ebcc))
* unblock release publication workflows ([#77](https://github.com/iHildy/opencode-synced/issues/77)) ([7b93df6](https://github.com/iHildy/opencode-synced/commit/7b93df6d9a0d4f715956e01bad453d3a7f44fe37))
* use .js extensions in missed imports and update convention ([bae3ebb](https://github.com/iHildy/opencode-synced/commit/bae3ebb7fbc3696965190d49d29deaa3e3ca6f3f))
* use current OpenCode paths on Windows ([#74](https://github.com/iHildy/opencode-synced/issues/74)) ([4c013dc](https://github.com/iHildy/opencode-synced/commit/4c013dc52ba396fa6dcd2b3f14234dafaae46220))
* use explicit dual entrypoint fields ([2343c84](https://github.com/iHildy/opencode-synced/commit/2343c8474a401fbb8e6c6f1f5ccc4d79ea7f977a))


### Reverts

* event-driven startup sync in favor of setTimeout delay ([221bf8c](https://github.com/iHildy/opencode-synced/commit/221bf8c04f4fe322f138b204202e4ea2e098f7ad))

## [0.11.0](https://github.com/iHildy/opencode-synced/compare/v0.10.1...v0.11.0) (2026-09-23)


### Features

* Support OpenCode v2 alongside v1 with explicit dual entrypoints and safe sync tool commands ([#84](https://github.com/iHildy/opencode-synced/pull/84)).


### Bug Fixes

* Restore synced Git sessions on link and pull across machines ([#83](https://github.com/iHildy/opencode-synced/pull/83), [#51](https://github.com/iHildy/opencode-synced/issues/51)).
* Keep v2 sync status read-only and preserve valid MCP server overrides when another server lacks secrets ([#84](https://github.com/iHildy/opencode-synced/pull/84)).

### Security

* Pin the remaining GitHub Actions to immutable commits ([#82](https://github.com/iHildy/opencode-synced/pull/82)).

### Release Reliability

* Authenticate OpenCode version lookup in the macOS prepublish smoke without exposing the token to its installer ([#87](https://github.com/iHildy/opencode-synced/pull/87)).

### Documentation

* Explain v1/v2 requirements, configuration keys, and the Node shell shim ([#84](https://github.com/iHildy/opencode-synced/pull/84)).

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
