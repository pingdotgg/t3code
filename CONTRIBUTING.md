# Contributing to Continuum IDE

Thanks for helping. Continuum IDE welcomes bug fixes, features, documentation, and packaging work.

## Before you start

- **Bugs:** open an [issue](https://github.com/SwashX-dev/continuum-ide/issues) with steps to
  reproduce, your OS, and the app version (Settings → About).
- **Features:** open an issue first describing the problem and the proposed behavior, so the design
  can be agreed before you write code.
- **Upstream bugs:** if the bug also exists in [T3 Code](https://github.com/pingdotgg/t3code), it may
  be better fixed there; read [their contributing rules](./docs/upstream/T3CODE-CONTRIBUTING.md) first.

## Development setup

See [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md). In short: install Vite+, run `vp i`, then
`vp run dev:desktop`. On NixOS, run `nix develop` first.

## Pull requests

1. Branch from `main`, keep each pull request to one problem or feature.
2. Follow the conventions in [AGENTS.md](./AGENTS.md) (Effect services, typed contracts, UI
   components, tests at the lowest layer that can fail).
3. Keep fork-specific code isolated where you can (`packages/shared/src/branding.ts`, new modules)
   so upstream changes keep merging.
4. Run `vp run check:changed` and the tests next to your change before pushing.
5. Describe what changed and how you verified it. UI changes need before/after screenshots.

## Syncing with upstream

`upstream` points at `pingdotgg/t3code`. Maintainers merge it periodically:

```bash
git fetch upstream && git merge upstream/main
```

Conflicts usually come from branded strings; keep Continuum's branding module and re-run the tests.
