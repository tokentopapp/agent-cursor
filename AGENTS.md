# AGENTS.md — @tokentop/agent-cursor

## What is TokenTop?

[TokenTop](https://github.com/tokentopapp/tokentop) is a terminal-based dashboard for monitoring
AI token usage and costs across providers and coding agents. It uses a plugin architecture
(`@tokentop/plugin-sdk`) with four plugin types: **provider** (API cost fetching), **agent**
(session parsing), **theme** (TUI colors), and **notification** (alerts).

This package is an **agent plugin**. Agent plugins parse local session files written by coding
agents (Claude Code, Cursor, etc.) to extract per-turn token usage, then feed normalized
`SessionUsageData` rows back to the TokenTop core for display. This plugin specifically tracks
Cursor AI editor session usage.

## Build & Run

```bash
bun install                  # Install dependencies
bun run build                # Full build (types + JS bundle)
bun run build:types          # tsc --emitDeclarationOnly
bun run build:js             # bun build → dist/
bun run typecheck            # tsc --noEmit (strict)
bun test                     # Run all tests (bun test runner)
bun test src/parser.test.ts  # Run a single test file
bun test --watch             # Watch mode
```

CI runs `bun run build` then `bun run typecheck`. Both must pass.

## Project Structure

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Plugin entry point — `createAgentPlugin()` wiring (`isInstalled`, `parseSessions`, `startActivityWatch`, `stopActivityWatch`), config schema, re-exports public API constants and cache objects |
| `src/parser.ts` | Session parsing — reads Cursor's SQLite `state.vscdb`, iterates composers and bubbles, builds workspace-to-composer mapping, estimates tokens from text, returns normalized `SessionUsageData[]` with caching |
| `src/watcher.ts` | Activity detection — `sessionWatcher` marks dirty on DB/WAL changes for incremental parsing, `activityWatcher` uses rowid-based cursor with read-write DB connection for real-time `ActivityUpdate` deltas, pending bubble re-checks during streaming, periodic full reconciliation |
| `src/csv.ts` | Server enrichment — fetches Cursor's CSV usage export (`/api/dashboard/export-usage-events-csv`), parses rows, matches to sessions by timestamp (±60s window), caches enriched data in `sessionEnrichmentCache` with persistent hydration via PluginStorage |
| `src/auth.ts` | Authentication — JWT decode (base64url), session cookie construction (`WorkosCursorSessionToken`) from `cursorAuth/accessToken` in SQLite |
| `src/storage.ts` | Persistence — `setPluginStorage()`/`getPluginStorage()` bridge for enrichment cache hydration across app restarts |
| `src/cache.ts` | Caching — TTL-based session cache (2s), per-composer aggregate cache with LRU eviction (10K max), composer metadata index for change detection |
| `src/paths.ts` | Path resolution — cross-platform Cursor config/data directories (macOS, Linux, Windows), workspace directory listing |
| `src/types.ts` | Type definitions — Cursor-specific interfaces for composers, bubbles, token counts, model config, workspace metadata, cache entries, CSV usage rows |
| `src/utils.ts` | SQLite helpers — `openDatabase` (readonly for parser), `openDatabaseForWatcher` (readwrite for WAL visibility), KV reads (`composerData:*`, `bubbleId:*`), workspace composer index, `resolveProviderId` (model-name-to-provider mapping), URI parsing |

## Architecture Notes

- **SQLite-based parsing**: Cursor stores sessions as "composers" in a SQLite KV table (`cursorDiskKV` in `state.vscdb` at `<UserData>/globalStorage/`). Composers are keyed as `composerData:{composerId}`, individual messages (bubbles) as `bubbleId:{composerId}:{bubbleId}`. Assistant bubbles (type 2) with either non-zero token counts or non-empty text content are tracked.
- **Token estimation**: Cursor populates `tokenCount` asynchronously via server polling (`getTokenUsage`). When the server doesn't return a `usageUuid` (common in agent-mode), `tokenCount` stays at zero. The plugin estimates output tokens from response text (`text.length / 4`) as a fallback.
- **Hybrid enrichment**: Sessions appear immediately with local estimates, then get backfilled with accurate data from Cursor's CSV server export. The CSV fetch is awaited on stale/empty cache so enrichment lands on the same `parseSessions` cycle. Enriched data is cached in `sessionEnrichmentCache` (in-memory) and persisted to `PluginStorage` for cross-restart survival.
- **Workspace mapping**: Composer-to-project mapping is resolved via workspace storage directories (`<UserData>/workspaceStorage/`). Each workspace has its own `state.vscdb` with an `ItemTable` entry at `composer.composerData` listing composer IDs. The workspace's `workspace.json` provides the project folder URI.
- **Two-layer caching**: `sessionCache` (TTL-based full result cache, 2s TTL) + `sessionAggregateCache` (per-composer parsed rows, LRU eviction at 10K entries)
- **Dirty tracking**: `fs.watch` on both `state.vscdb` and `state.vscdb-wal` sets a dirty flag; only dirty or new composers get re-parsed. A composer metadata index tracks `lastUpdatedAt` per composer to skip unchanged entries. Empty cached results are always re-checked.
- **Reconciliation**: Full stat sweep forced every 10 minutes via interval timer, bypassing dirty/metadata checks
- **Activity watching**: Rowid-based cursor on `cursorDiskKV` detects new bubble INSERTs. Uses `openDatabaseForWatcher()` (read-write mode) to avoid bun:sqlite WAL snapshot isolation. Pending bubbles (empty assistant messages during streaming) are re-checked at 500ms until content appears. Base poll interval is 1s with 150ms debounce on `fs.watch` events.
- **Auth for CSV**: Access token read from `cursorAuth/accessToken` in `ItemTable`. JWT `sub` field provides the userId. Cookie format: `WorkosCursorSessionToken=${userId}%3A%3A${accessToken}`.
- **Deduplication**: Uses `bubbleId` as dedup key within each composer via `Map<string, SessionUsageData>`
- **Model-to-provider mapping**: `resolveProviderId()` maps model name prefixes to provider IDs (`claude*` → `anthropic`, `gpt*/o1*/o3*/o4*` → `openai`, `gemini*` → `google`, `deepseek*` → `deepseek`, fallback → `cursor`). Per-bubble model info is preferred over composer-level model config; unresolved models fall back to `cursor-default`.
## TypeScript Configuration

- **Strict mode**: `strict: true` — all strict checks enabled
- **No unused code**: `noUnusedLocals`, `noUnusedParameters` both `true`
- **No fallthrough**: `noFallthroughCasesInSwitch: true`
- **Target**: ESNext, Module: ESNext, ModuleResolution: bundler
- **Types**: `bun-types` (not `@types/node`)
- **Declaration**: Emits `.d.ts` + declaration maps + source maps

## Code Style

### Imports

- **Use `.ts` extensions** in all relative imports: `import { foo } from './bar.ts'`
- **Type-only imports** use the `type` keyword:
  ```typescript
  import type { SessionUsageData } from '@tokentop/plugin-sdk';
  import { createAgentPlugin, type AgentFetchContext } from '@tokentop/plugin-sdk';
  ```
- **Node.js modules** via namespace imports: `import * as fs from 'fs'`, `import * as path from 'path'`
- **Order**: External packages → relative imports (no blank line separator used)

### Module Format

- ESM only (`"type": "module"` in package.json)
- Named exports for everything except the main plugin (default export)
- Re-export public API items explicitly from `index.ts`

### Naming Conventions

- **Constants**: `UPPER_SNAKE_CASE` — `CACHE_TTL_MS`, `RECONCILIATION_INTERVAL_MS`
- **Functions**: `camelCase` — `parseSessionsFromProjects`, `readJsonlFile`
- **Interfaces**: `PascalCase` — `CursorSessionEntry`, `SessionWatcherState`
- **Type predicates**: `is` prefix — `isTokenBearingEntry(entry): entry is ...`
- **Unused required params**: Underscore prefix — `_ctx: PluginContext`
- **File names**: `kebab-case.ts`

### Types

- **Interfaces** for object shapes, not type aliases
- **Explicit return types** on all exported functions
- **Type predicates** for runtime validation guards (narrowing `unknown` → typed)
- **`Partial<T>`** for candidate validation instead of `as any`
- Never use `as any`, `@ts-ignore`, or `@ts-expect-error`
- Validate unknown data at boundaries with type guard functions

### Functions

- **Functional style** — no classes. State held in module-level objects/Maps
- **Pure functions** where possible; side effects isolated to watcher/cache modules
- **Early returns** for guard clauses
- **Async/await** throughout, no raw Promise chains

### Error Handling

- **Empty catch blocks are intentional** for graceful degradation (filesystem ops that may fail)
- Pattern: `try { await fs.access(path); } catch { return []; }`
- Never throw from filesystem operations — return empty/default values
- Use `Number.isFinite()` for numeric validation, not `isNaN()`
- Validate at data boundaries, trust within module

### Formatting

- No explicit formatter config (Prettier/ESLint not configured)
- 2-space indentation (observed convention)
- Single quotes for strings
- Trailing commas in multiline structures
- Semicolons always
- Opening brace on same line

## Plugin SDK Contract

The plugin SDK (`@tokentop/plugin-sdk`) defines the interface contract between plugins and
the TokenTop core (`~/development/tokentop/ttop`). The SDK repo lives at
`~/development/tokentop/plugin-sdk`. This plugin is a peer dependency consumer — it declares
`@tokentop/plugin-sdk` as a `peerDependency`, not a bundled dep.

This plugin implements the `AgentPlugin` interface via the `createAgentPlugin()` factory:

```typescript
const plugin = createAgentPlugin({
  id: 'cursor',
  type: 'agent',
  agent: { name: 'Cursor', command: 'cursor', configPath, sessionPath },
  capabilities: { sessionParsing: true, realTimeTracking: true, ... },
  isInstalled(ctx) { ... },
  parseSessions(options, ctx) { ... },
  startActivityWatch(ctx, callback) { ... },
  stopActivityWatch(ctx) { ... },
});
export default plugin;
```

### AgentPlugin interface (required methods)

| Method | Signature | Purpose |
|--------|-----------|---------|
| `isInstalled` | `(ctx: PluginContext) → Promise<boolean>` | Check if this agent exists on the user's machine |
| `parseSessions` | `(options: SessionParseOptions, ctx: AgentFetchContext) → Promise<SessionUsageData[]>` | Parse session files into normalized usage rows |
| `startActivityWatch` | `(ctx: PluginContext, callback: ActivityCallback) → void` | Begin real-time file watching, emit deltas |
| `stopActivityWatch` | `(ctx: PluginContext) → void` | Tear down watchers |

### Key SDK types

| Type | Shape | Used for |
|------|-------|----------|
| `SessionUsageData` | `{ sessionId, providerId, modelId, tokens: { input, output, cacheRead?, cacheWrite? }, timestamp, sessionUpdatedAt?, projectPath?, sessionName? }` | Normalized per-turn usage row returned from `parseSessions` |
| `ActivityUpdate` | `{ sessionId, messageId, tokens: { input, output, cacheRead?, cacheWrite? }, timestamp }` | Real-time delta emitted via `ActivityCallback` |
| `SessionParseOptions` | `{ sessionId?, limit?, since?, timePeriod? }` | Filters passed by core to `parseSessions` |
| `AgentFetchContext` | `{ http, logger, config, signal }` | Context bag — `ctx.logger` for debug logging |
| `PluginContext` | `{ logger, storage, config, signal }` | Context for lifecycle methods |

### SDK subpath imports

| Import path | Use |
|-------------|-----|
| `@tokentop/plugin-sdk` | Everything (types + helpers) |
| `@tokentop/plugin-sdk/types` | Type definitions only |
| `@tokentop/plugin-sdk/testing` | `createTestContext()` for tests |

## Commit Conventions

Conventional Commits enforced by CI on both PR titles and commit messages:

```
feat(parser): add support for cache_creation breakdown
fix(watcher): handle race condition in delta reads
chore(deps): update dependencies
refactor: simplify session metadata indexing
```

Valid prefixes: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
Optional scope in parentheses. Breaking changes use `!` suffix before colon.

## Release Process

- semantic-release via GitHub Actions (currently manual `workflow_dispatch`)
- Publishes to npm as `@tokentop/agent-cursor` with public access + provenance
- Runs `bun run clean && bun run build` before publish (`prepublishOnly`)
- Branches: `main` only

## Testing

- Test runner: `bun test` (Bun's built-in test runner)
- Test files: `*.test.ts` (excluded from tsconfig compilation, picked up by bun test)
- Place test files adjacent to source: `src/parser.test.ts`
- Use `createTestContext()` from `@tokentop/plugin-sdk/testing` for mock contexts
