# CI quality gates

`.github/workflows/ci.yml` runs the repository check, TypeScript typecheck, backend build, TypeScript tests, native macOS tests, and mobile native static analysis on pull requests and pushes to `main`.

The legacy multi-platform release pipeline was removed. Native macOS distribution should be added as a dedicated signed and notarized workflow when the packaging contract is finalized.
