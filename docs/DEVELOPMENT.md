# Developing Continuum IDE

Continuum IDE keeps T3 Code's toolchain: a pnpm monorepo driven by [Vite+](https://viteplus.dev/guide/)
(`vp`), Effect on the server, React on the web client, and Electron for the desktop app.

## Prerequisites

- Git
- Vite+: `curl -fsSL https://vite.plus | bash` (Windows: `irm https://vite.plus/ps1 | iex`).
  It installs the exact Node.js (`engines.node`) and pnpm versions the repo pins.
- For the desktop app: Rust (`cargo`), a C compiler, `make`, and on Linux `pkg-config`,
  `libsecret-1-dev`, and ImageMagick. On NixOS, `nix develop` provides all of these.

## Common commands

| Task                              | Command                                                                      |
| --------------------------------- | ---------------------------------------------------------------------------- |
| Install dependencies              | `vp i`                                                                       |
| Server + web app (browser)        | `vp run dev`                                                                 |
| Desktop app (Electron)            | `vp run dev:desktop`                                                         |
| Use a throwaway data folder       | `vp run dev:desktop --home-dir /tmp/continuum-dev --no-seed`                 |
| Typecheck one package             | `vp run --filter @t3tools/web typecheck`                                     |
| Run tests next to a file          | `vp test run path/to/file.test.ts` (from the package folder)                 |
| CI's fast checks for your changes | `vp run check:changed`                                                       |
| Linux AppImage + .deb             | `vp run dist:desktop:artifact --platform linux --target AppImage --arch x64` |
| Windows installer                 | `vp run dist:desktop:artifact --platform win --target nsis --arch x64`       |
| Regenerate app icons              | `node scripts/generate-continuum-icons.mjs`                                  |

Development data defaults to `~/.continuum/dev`; worktrees use their own `.t3` folder. The first
`vp run dev` seeds an empty development database from a read-only copy of `~/.continuum/userdata`
when it exists (`--no-seed` skips this).

## Where things live

| Path                      | What                                                              |
| ------------------------- | ----------------------------------------------------------------- |
| `apps/server`             | WebSocket server, orchestration, provider adapters, checkpointing |
| `apps/web`                | React UI used by the desktop app and browsers                     |
| `apps/desktop`            | Electron shell: windows, IPC, updates, packaging resources        |
| `apps/mobile`             | Upstream T3 Code mobile app (unchanged; pairs with Continuum)     |
| `packages/contracts`      | Typed schemas shared by every surface                             |
| `packages/shared`         | Shared runtime helpers, including `branding.ts`                   |
| `packages/client-runtime` | Client state shared by web and mobile                             |
| `scripts/`                | Dev runner, packaging (`build-desktop-artifact.ts`), icons        |

Architecture background: [ARCHITECTURE.md](./ARCHITECTURE.md) and upstream's
[internals docs](./internals/overview.md).

## Releases

`.github/workflows/continuum-release.yml` builds the Windows installer and Linux AppImage/.deb/.rpm
on GitHub-hosted runners and publishes them to this repository's Releases. Run it from the Actions
tab with a version (for example `1.0.0`), or push a tag `v1.0.0`. Installers are unsigned.
