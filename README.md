# @tokentop/agent-cursor

[![npm](https://img.shields.io/npm/v/@tokentop/agent-cursor?style=flat-square&color=CB3837&logo=npm)](https://www.npmjs.com/package/@tokentop/agent-cursor)
[![CI](https://img.shields.io/github/actions/workflow/status/tokentopapp/agent-cursor/ci.yml?style=flat-square&label=CI)](https://github.com/tokentopapp/agent-cursor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[tokentop](https://github.com/tokentopapp/tokentop) agent plugin for **Cursor**. Parses Cursor's local SQLite session data and enriches it with server-side token counts for accurate usage tracking.

## Capabilities

| Capability | Status |
|-----------|--------|
| Session parsing | Yes |
| Real-time tracking | Yes |
| Server enrichment | Yes |
| Multi-provider | No |

## How It Works

Cursor stores session data as "composers" in a SQLite KV table (`state.vscdb`). Each conversation turn is a "bubble" with token counts, model info, and timestamps.

**Hybrid token strategy:**

1. **Immediate** — Sessions appear within seconds using local token estimates (`text.length / 4`)
2. **Enriched** — Accurate token counts (including cache read/write breakdown) are backfilled from Cursor's CSV server export

Enriched data persists across app restarts via plugin storage.

**Real-time activity detection:**

The activity watcher uses a rowid-based cursor on the SQLite DB with a read-write connection (to avoid WAL snapshot isolation). New bubbles are detected via 1s polling + `fs.watch`, with a 500ms fast-poll for pending bubbles during streaming.

## Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| Server enrichment | boolean | `true` | Fetch accurate token counts from Cursor's server |
| Server refresh interval | number | `5` | How often to refresh server data (minutes, 1–60) |
| Estimate tokens | boolean | `true` | Show estimated tokens while server data loads |

## Permissions

| Type | Access | Details |
|------|--------|---------|
| Filesystem | Read | `~/.cursor`, `~/Library/Application Support/Cursor`, `~/.config/Cursor` |
| Network | HTTPS | `cursor.com` (CSV usage export) |

## Install

This plugin is **bundled with tokentop** — no separate install needed. If you need it standalone:

```bash
bun add @tokentop/agent-cursor
```

## Requirements

- [Cursor](https://cursor.com) installed
- [Bun](https://bun.sh/) >= 1.0.0
- `@tokentop/plugin-sdk` ^1.0.0 (peer dependency)

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```

## Project Structure

| File | Responsibility |
|------|----------------|
| `src/index.ts` | Plugin entry — `createAgentPlugin()` wiring, config schema, exports |
| `src/parser.ts` | Session parsing — SQLite reads, workspace mapping, token estimation |
| `src/watcher.ts` | Activity detection — rowid cursor, WAL watching, pending bubbles |
| `src/csv.ts` | Server enrichment — CSV fetch, parse, match, cache, persistent storage |
| `src/auth.ts` | Auth — JWT decode, session cookie for CSV endpoint |
| `src/storage.ts` | Persistence — PluginStorage bridge for enrichment cache |
| `src/cache.ts` | Caching — TTL session cache, LRU aggregate cache, metadata index |
| `src/paths.ts` | Paths — cross-platform Cursor config/data directories |
| `src/types.ts` | Types — Cursor-specific interfaces |
| `src/utils.ts` | SQLite helpers — DB open, KV reads, provider mapping |

## Contributing

See the [Contributing Guide](https://github.com/tokentopapp/.github/blob/main/CONTRIBUTING.md). Issues for this plugin should be [filed on the main tokentop repo](https://github.com/tokentopapp/tokentop/issues/new?template=bug_report.yml&labels=bug,agent-cursor).

## License

MIT
