# SergeCode

SergeCode is a minimal web GUI for coding agents (currently Codex, Claude, Cursor, Grok, and OpenCode).

> [!IMPORTANT]
> SergeCode is a **permanent, independent hard fork** of [T3 Code](https://github.com/pingdotgg/t3code). It evolves separately and will never be merged back upstream. Do not open PRs or issues against the upstream repository — everything lives at [SergeSerb2/SergeCode](https://github.com/SergeSerb2/SergeCode).

## Prerequisites

> [!WARNING]
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

## Running from source

```bash
pnpm install
pnpm dev
```

See [package.json](./package.json) scripts for the full set of dev/build/start commands (`pnpm dev:server`, `pnpm dev:web`, `pnpm dev:desktop`, `pnpm build`, ...).

Note: the upstream distribution channels (`npx t3`, winget, Homebrew, AUR) ship upstream T3 Code, not SergeCode. Run SergeCode from source or from this repository's own releases.

## Some notes

This project is a personal fork and very much a WIP. Expect bugs.

There's no public docs site; check out the miscellaneous markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Reference](./docs/reference/encyclopedia.md)
