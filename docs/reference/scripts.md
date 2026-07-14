# Scripts

- `vp install` — installs JavaScript and native-module dependencies.
- `vp run build:server` — bundles the Node backend used by the native macOS sidecar.
- `vp run build:mac` — builds the native macOS Swift package.
- `vp run package:mac` — assembles `apps/mac/dist/SurgeCode.app`.
- `vp run dev:server` — runs the standalone backend in headless pairing mode with file watching.
- `vp run test:mac` — runs the Swift test suites.
- `vp run test` — runs all TypeScript package test scripts.
- `vp check` and `vp run typecheck` — required repository quality gates.
- `vp run lint:mobile` — checks native mobile sources.

The macOS app expects `apps/server/dist/bin.mjs` in development, so build the server before launching the app from SwiftPM.
