# more Code

more Code is a minimal web GUI for coding agents (currently Codex, Claude, Cursor, Grok Build, and OpenCode, more coming soon).

## Installation

> [!WARNING]
> more Code currently supports Codex, Claude, Cursor, Grok Build, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `cursor-agent login`
> - Grok Build: install [Grok CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3@latest
```

Tip: Use `npx t3@latest --help` for the full CLI reference.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

There's no public docs site yet, checkout the miscellaneous markdown files in [docs](./docs).

## Documentation

- [Getting started](./docs/getting-started/quick-start.md)
- [Architecture overview](./docs/architecture/overview.md)
- [Provider guides](./docs/providers/codex.md)
- [Operations](./docs/operations/ci.md)
- [Headless Linux packages](./docs/operations/headless-linux.md)
- [Reference](./docs/reference/encyclopedia.md)

## If you REALLY want to contribute still.... read this first

### Install `vp`

more Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

### Run this fork

From the root of the repository, run:

```bash
vp run dev
```

Alternatively, use `npm run dev`.

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

## Acknowledgements

Thanks to [Noctalia](https://github.com/noctalia-dev/noctalia) for inspiring more Code's colorful theme palettes.

Thanks to [Odysseus](https://github.com/pewdiepie-archdaemon/odysseus) for inspiring side-by-side multi-model comparisons.
