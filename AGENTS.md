# AGENTS.md

## Build & Test Commands (Windows / Node.js)

- **Build**: `npx tsc -p tsconfig.build.json && copyfiles -u 1 "src/command/**/*" dist/`
- **Test**: `npx vitest run`
- **Single Test**: `npx vitest run --reporter=verbose src/sync/paths.test.ts`
- **Lint**: `npx biome lint .`
- **Check**: `npx biome check --write .`
- **Deploy**: copy `dist/` to `C:\Users\Aleks\.config\opencode\plugins\opencode-synced\`

## PR & Commit Guidelines

- **Conventional Commits**: Use conventional commit messages (e.g., `fix:`, `feat:`, `chore:`, `docs:`, `refactor:`, `test:`, `revert:`).
- **PR Titles**: PR titles MUST follow conventional commit format (e.g., `fix: descriptive title`). This is enforced by GitHub checks.
- **Workflow**: Run `bun run check` and `bun run test` before creating a PR.

## Code Style Guidelines

### Imports & Module System

- Use ES6 `import`/`export` syntax (module: "ESNext", type: "module")
- Group imports: external libraries first, then internal modules
- Use explicit file extensions (`.js`) for internal imports

### Formatting (Biome)

- **Single quotes** (`quoteStyle: 'single'`)
- **Line width**: 100 characters
- **Tab width**: 2 spaces (indentStyle: 'space')
- **Trailing commas**: ES5 (no trailing commas in function parameters)
- **Semicolons**: enabled

### TypeScript & Naming

- **NeverNesters**: avoid deeply nested structures. Always exit early.
- **Strict mode**: enforced (`"strict": true`)
- **Classes**: PascalCase (e.g., `BackgroundTask`, `BackgroundTaskManager`)
- **Methods/properties**: camelCase
- **Status strings**: use union types (e.g., `'pending' | 'running' | 'completed' | 'failed' | 'cancelled'`)
- **Explicit types**: prefer explicit type annotations over inference
- **Return types**: optional (not required but recommended for public methods)

### Error Handling

- Check error type before accessing error properties: `error instanceof Error ? error.toString() : String(error)`
- Log errors with `[ERROR]` prefix for consistency
- Always provide error context when recording output

### Linting Rules

- `@typescript-eslint/no-explicit-any`: warn (avoid `any` type)
- `no-console`: error (minimize console logs)
- `prettier/prettier`: error (formatting violations are errors)

## Testing

- Framework: **vitest** with `describe` & `it` blocks
- Style: Descriptive nested test cases with clear expectations
- Assertion library: `expect()` (vitest)

## Memory

- Store temporary data in `.memory/` directory (gitignored)

## Project Context

- **Type**: ES Module package for opencode plugin system
- **Target**: Bun runtime, ES2021+
- **Purpose**: Sync global opencode config across machines via GitHub, with optional secrets support (e.g., 1Password backend)

## OpenCode Desktop Context (Windows)

- OpenCode v1.15.7 from anomalyco/opencode (Electron/Node.js, not Bun Terminal)
- Desktop config: `C:\Users\Aleks\.config\opencode\` (XDG-style, NOT `%APPDATA%`)
- Plugin API: local at `C:\Users\Aleks\.config\opencode\node_modules\@opencode-ai\plugin\` v1.4.7
- `ctx.$` is `undefined` on Desktop (Bun shell not available), but `createNodeShell()` fallback exists
- Plugin config: `C:\Users\Aleks\.config\opencode\opencode-synced.jsonc` tells which GitHub repo to sync
- Session DB: `C:\Users\Aleks\.local\share\opencode\opencode.db` (SQLite)
- Desktop projects store: `%APPDATA%\ai.opencode.desktop\opencode.global.dat`

## FORK PLAN — 6 Phases

### Phase 0 ✅ DONE
- [x] Clone latest `main` from `github.com/iHildy/opencode-synced` (commit a627673)
- [x] Fix `package.json`: `@opencode-ai/plugin` → local `file:` reference in devDependencies
- [x] `npm install`, `npx tsc -p tsconfig.build.json` — build passes
- [ ] ~~`bun test`~~ → use `npx vitest run` (no bun on Windows)

### Phase 1: path.ts — XDG on all platforms (remove win32 APPDATA)
**Files**: `src/sync/paths.ts`, `src/sync/paths.test.ts`
1. Remove `if (platform === 'win32')` block with `env.APPDATA`/`env.LOCALAPPDATA`
2. `dataDir` = `env.XDG_DATA_HOME ?? path.join(home, '.local', 'share')`
3. `configDir` = `env.XDG_CONFIG_HOME ?? path.join(home, '.config')`
4. Fix `env.opencode_config_dir` → `env.OPENCODE_CONFIG_DIR`
5. Update tests for Windows expectations (no more `%APPDATA%`)

### Phase 2: Notifications — toasts + logs on key lifecycle points
**Files**: `src/sync/utils.ts`, `src/sync/service.ts`
1. Add `notify(client, { emoji, title, message, variant })` — unified entry point
2. `runStartup()` → `"🔄 Sync starting…"`, `"✅ opencode-synced ready"`
3. `pull()` → `"📥 Pulling…"`, `"📥 Pull complete — X changes"`
4. `push()` → `"📤 Pushing…"`, `"📤 Push successful"`
5. `link()` → `"🔗 Linking…"`, `"🔗 Linked to {repo}"`
6. `syncSessions()` → `"💾 Syncing sessions…"`, result summary
7. Errors → `"❌ {message}"` with variant='error'

### Phase 3: Session sync — union-merge per record
**New file**: `src/sync/session-merge.ts`
**Edit**: `src/sync/session-db.ts`, `src/sync/service.ts`

**Problem**: Current `exportSessions` / `importSessions` use `skip-if-exists` — updated sessions are never re-synced.
**Solution**: Replace with `syncSessions(localDB, remoteDir)`:
1. Read ALL sessions from local SQLite → `Map<id, Session>`
2. Read ALL session .json files from repo → `Map<id, Session>`
3. For each unique id: `merge(local, remote)` per record:
   - session meta: newer `time_updated` wins
   - messages: union by `message.id`, each picks max `time_updated`
   - parts: union by `part.id` nested in messages
   - todos, session_messages, shares: union by id
4. Write merged to both sides (SQLite + .json)
5. Called both on pull (after fetchAndFastForward) and push (before syncLocalToRepo)

### Phase 4: includeProjects — sync opencode.global.dat
**Files**: `src/sync/config.ts`, `src/sync/service.ts`
1. Add `includeProjects: boolean = false` config field
2. Read `opencode.global.dat` from Desktop AppData
3. Copy to `data/opencode.global.dat` in repo on push
4. Copy from repo on pull
5. Warn: Desktop restart required to apply projects

### Phase 5: Build, deploy, test
1. `npx tsc -p tsconfig.build.json && copyfiles -u 1 "src/command/**/*" dist/`
2. Copy `dist/` → `C:\Users\Aleks\.config\opencode\plugins\opencode-synced\`
3. Restart OpenCode Desktop
4. Test `/sync-pull`, `/sync-push`, `/sync-status`
5. Test session creation + push/pull between machines
