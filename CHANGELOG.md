# Changelog

All notable changes to this project will be documented here by Release Please.

## [0.10.0](https://github.com/iHildy/opencode-synced/compare/v0.9.0...v0.10.0) (2026-08-31)


### Features

* add isolated GitHub two-instance E2E workflow ([#52](https://github.com/iHildy/opencode-synced/issues/52)) ([e5c338f](https://github.com/iHildy/opencode-synced/commit/e5c338f99630a34bc6741e2524ab7fad1d611fbb))
* add secrets backend config support ([f6a56e2](https://github.com/iHildy/opencode-synced/commit/f6a56e28b2f34dd6f6ba08d3cebfc3fc30806048))
* add secrets sync commands ([c29d63a](https://github.com/iHildy/opencode-synced/commit/c29d63a2895eac43c4bb401bfed2597e38fe762d))
* integrate 1Password secrets backend ([ca6a5bb](https://github.com/iHildy/opencode-synced/commit/ca6a5bb927402d1b302a8691a6add200ea00f3e1))
* support explicit non-GitHub Git remotes ([#73](https://github.com/iHildy/opencode-synced/issues/73)) ([0b46b29](https://github.com/iHildy/opencode-synced/commit/0b46b29733363acacdde28361f3959ec882f083e))
* sync skills directory by default ([#56](https://github.com/iHildy/opencode-synced/issues/56)) ([a627673](https://github.com/iHildy/opencode-synced/commit/a627673f7a00f9cdcdefe168ba110803c0678b3a))
* update release workflow to maintain latest tag ([d5a0c75](https://github.com/iHildy/opencode-synced/commit/d5a0c751b1e817539af0de484eee8866b0e3a6fd))


### Bug Fixes

* address secrets backend review ([f2eb33b](https://github.com/iHildy/opencode-synced/commit/f2eb33b9ea605a17230b5d43dae9891a59822d0b))
* expand e2e coverage and docs for session sync compatibility ([#53](https://github.com/iHildy/opencode-synced/issues/53)) ([78a4f88](https://github.com/iHildy/opencode-synced/commit/78a4f88ad12d72f911c0fa0e7704ff0e305e9852))
* for [#69](https://github.com/iHildy/opencode-synced/issues/69) (nice) `resolveSmallModel` truncated selectors when the model ID itself contained `/`, ([#70](https://github.com/iHildy/opencode-synced/issues/70)) ([9a9ead9](https://github.com/iHildy/opencode-synced/commit/9a9ead9a0a679f0aa6844f89b6d055898aa90183))
* guard secrets backend validation before actions ([790f850](https://github.com/iHildy/opencode-synced/commit/790f85039b9a2c30ac66979ffdee8d426234e798))
* harden release publication pipeline ([#75](https://github.com/iHildy/opencode-synced/issues/75)) ([7e37271](https://github.com/iHildy/opencode-synced/commit/7e37271de21a254c1f8c7d5a35e83c13564a9f6c))
* harden secrets backend integration ([5c37236](https://github.com/iHildy/opencode-synced/commit/5c37236ec76c27125adc9e99156e87622bf9ea8b))
* portable paths in extra-manifest for cross-platform sync ([#58](https://github.com/iHildy/opencode-synced/issues/58)) ([96836af](https://github.com/iHildy/opencode-synced/commit/96836afd19737caba1bca03716a98cd4540c620f))
* preserve original 1password errors ([e67d675](https://github.com/iHildy/opencode-synced/commit/e67d6755a0c2024782b4eb2ec6da73f4a2223344))
* resolve relative extra paths from config root ([#72](https://github.com/iHildy/opencode-synced/issues/72)) ([10a3a83](https://github.com/iHildy/opencode-synced/commit/10a3a83b7798ce625ccb636aeb06ab7710d11a3c))
* safely resolve MCP environment overrides ([#47](https://github.com/iHildy/opencode-synced/issues/47)) ([2f0ebea](https://github.com/iHildy/opencode-synced/commit/2f0ebea239cfee0923e5e5d6833e1a0882e6c2a5))
* safely sync large session files ([#76](https://github.com/iHildy/opencode-synced/issues/76)) ([5be4e06](https://github.com/iHildy/opencode-synced/commit/5be4e067d234121917c160ba79204b0e441ebf4a))
* strip overrides removes keys missing from local config ([#49](https://github.com/iHildy/opencode-synced/issues/49)) ([#50](https://github.com/iHildy/opencode-synced/issues/50)) ([f87ca69](https://github.com/iHildy/opencode-synced/commit/f87ca69810de342f73ad87a4ab30c5fd17260540))
* sync opencode-synced config ([034bbe8](https://github.com/iHildy/opencode-synced/commit/034bbe8feb72cf4f2306399788dca5d897d50283))
* sync plural OpenCode config directories ([#71](https://github.com/iHildy/opencode-synced/issues/71)) ([2f4fe70](https://github.com/iHildy/opencode-synced/commit/2f4fe700dd1776a907fdc74f4565cf50c234ebcc))
* use current OpenCode paths on Windows ([#74](https://github.com/iHildy/opencode-synced/issues/74)) ([4c013dc](https://github.com/iHildy/opencode-synced/commit/4c013dc52ba396fa6dcd2b3f14234dafaae46220))

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
