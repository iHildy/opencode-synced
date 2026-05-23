# AGENTS.md

## Language
- Все ответы пользователю — ТОЛЬКО на русском языке. Никогда не использовать английский.

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

## Build Output Notes

- **compact JSON**: All session files use `JSON.stringify(session)` without `null, 2` (pretty-print). This saves ~30% disk space and reduces git diff noise. Reading both formats is supported (single-session and old columnar).
- **Broken JSON recovery**: If a session JSON file can't be parsed, a `.broken` backup is created before returning null (prevents total data loss).

## Cross-Platform (Windows / Linux / macOS)

- `platformJoin(platform, ...parts)` in `paths.ts` — uses `path.posix.join` or `path.win32.join` based on `platform` parameter
- `expandHome()` and `normalizePath()` — always produce forward slashes, backslashes normalized before comparison
- All `buildSyncPlan`/`resolveXdgPaths`/`resolveSyncLocations` tests pass on Windows (79/79)

## Project State (23.05.2026)

### Done
- XDG paths on all platforms (no %APPDATA%)
- Notifications (toasts + logs) on key lifecycle points
- Session sync: union-merge per record (session-db.ts, session-merge.ts)
- Projects sync: opencode.global.dat merge (projects-merge.ts)
- Auto-commit pending changes on startup instead of bailing out
- Removed AI commit message generation → date-based messages
- `createNodeShell()`: async `exec` instead of `execSync`, proper arg quoting
- CONFIG_DIRS includes `'plugins'` and `'commands'` for Desktop compatibility
- HEAD cache skip: если HEAD не изменился и нет локальных изменений — пропускаем git fetch (экономия сети)
- skipIfBusy: file-based exclusive lock предотвращает конкурентные sync
- Дебаунс: startup sync обёрнут в skipIfBusy
- Двуязычные комментарии EN/RU в ключевых модулях
- Двуязычные `description` в 14 `.md` командах
- `parseFrontmatter()` — BOM + CRLF + fallback first-line fix
- `platformJoin()` helper для кроссплатформенных тестов
- `expandHome()` — всегда forward slashes (не `path.join`)
- Все 79 тестов проходят на Windows (0 known failures)
- `asSQLValue()` — обёртка всех SQLite-параметров
- `INSERT OR REPLACE` вместо DELETE+INSERT
- Пропуск `writeSessionsToDB` при пустой remote-директории
- `readSessionsFromDir` — поддержка старого колоночного формата JSON
- Убрано копирование `opencode.db` и `storage/` из sync plan (сессии → syncSessions)

### Session Sync Optimizations
1. **Compact JSON** — `JSON.stringify(session)` без `null, 2` (экономия ~30%)
2. **WAL checkpoint один раз** — вынесен из `openDB()` в `syncSessions()`, однакратно за цикл
3. **Background git push** — `pushBranch(...).catch(...)`, не блокирует стартап
4. **Единый DB handle** — `syncSessions()` открывает SQLite один раз, читает/пишет через handle-варианты функций
5. **Batch DB writes** — все мержнутые сессии пишутся одним `BEGIN…COMMIT`, а не по одной
6. **Recovery битых JSON** — перед возвратом `null` создаётся `.broken`-копия файла

### Known Issues
- **Лог Desktop** — кольцевой буфер ~12 строк. MCP-ошибки agentmemory/TestSprite (`prompts/list`) забивают его за ~39 секунд, вытесняя логи плагина. Не наша проблема.
- **Worker threads** — SQLite синхронный (`node:sqlite` DatabaseSync), но с единым handle + batch уже быстро. Если понадобится — вынести в `worker_threads`.

### Removed Upstream Features
- `generateCommitMessage` (commit.ts) — LLM для commit message не используется. Сообщение = `Sync opencode config (YYYY-MM-DD)`
- `opencode.db` исключён из sync plan (предотвращает затирание сессий при pull с другой машины). Сессии → per-session JSON merge (`syncSessions`)

### Deploy
1. `npx tsc -p tsconfig.build.json && npx copyfiles -u 1 "src/command/**/*" dist/`
2. `robocopy dist "C:\Users\Aleks\.config\opencode\plugins\opencode-synced\dist" /MIR /NFL /NDL /NJH /NJS /NC /NS /NP`
3. Restart OpenCode Desktop
