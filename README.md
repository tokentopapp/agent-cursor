# @tokentop/agent-cursor

[![npm](https://img.shields.io/npm/v/@tokentop/agent-cursor?style=flat-square&color=CB3837&logo=npm)](https://www.npmjs.com/package/@tokentop/agent-cursor)
[![CI](https://img.shields.io/github/actions/workflow/status/tokentopapp/agent-cursor/ci.yml?style=flat-square&label=CI)](https://github.com/tokentopapp/agent-cursor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[tokentop](https://github.com/tokentopapp/tokentop) agent plugin for **Cursor**. Detects installation and provides the plugin scaffold for session tracking.

> **Status: Scaffold** — This plugin detects whether Cursor is installed but does not yet parse sessions or track usage. Contributions welcome!

## Capabilities

| Capability | Status |
|-----------|--------|
| Session parsing | Not yet |
| Credential reading | Not yet |
| Real-time tracking | Not yet |
| Multi-provider | No |

## What Works Today

- **Installation detection** — tokentop can detect if Cursor is installed by checking for `~/.cursor`
- **Plugin registration** — the agent appears in tokentop's plugin list

## What Needs Implementation

Session parsing, credential reading, and real-time file watching need to be built. See [`@tokentop/agent-opencode`](https://github.com/tokentopapp/agent-opencode) for a complete reference implementation.

If you use Cursor and want to help, check the [Contributing Guide](https://github.com/tokentopapp/.github/blob/main/CONTRIBUTING.md) — this is a great first contribution.

## Install

This plugin is **bundled with tokentop** — no separate install needed. If you need it standalone:

```bash
bun add @tokentop/agent-cursor
```

## Requirements

- [Cursor](https://cursor.com) installed
- [Bun](https://bun.sh/) >= 1.0.0
- `@tokentop/plugin-sdk` ^1.0.0 (peer dependency)

## Permissions

| Type | Access | Paths |
|------|--------|-------|
| Filesystem | Read | `~/.cursor` |

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```

## Contributing

See the [Contributing Guide](https://github.com/tokentopapp/.github/blob/main/CONTRIBUTING.md). Issues for this plugin should be [filed on the main tokentop repo](https://github.com/tokentopapp/tokentop/issues/new?template=bug_report.yml&labels=bug,agent-cursor).

## License

MIT
