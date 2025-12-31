# AGENTS.md

## Build & Test Commands

- **Build**: `mise run build` or `bun build ./src/index.ts --outdir dist --target bun`
- **Test**: `mise run test` or `bun test`
- **Single Test**: `bun test BackgroundTask.test.ts` (use file glob pattern)
- **Watch Mode**: `bun test --watch`
- **Lint**: `mise run lint` or `bun run lint` (biome)
- **Fix Lint**: `mise run lint:fix` or `bun run lint:fix` (biome --write)
- **Format**: `mise run format` or `bun run format` (biome format --write)
- **Check (Lint + Format)**: `bun run check` (biome check --write)

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

- **Type**: ES Module package for OpenCode plugin system
- **Target**: Bun runtime, ES2021+
- **Purpose**: Sync global OpenCode config across machines via GitHub
