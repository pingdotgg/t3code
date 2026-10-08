# CLI launcher coverage

`launcher.test.ts` is the fast regression matrix for production JSX. It uses an install-shaped fixture and the real progress renderer, covering inherited `NODE_ENV` and caller JSX configurations. `exitCodes.test.ts` covers command exit behavior. Both run in the Check workflow.

`package.test.ts` is the external-install canary. It installs normal `pnpm pack` tarballs into a fresh OS temporary project with npm, pnpm, or Bun. Packed workspace dependencies are installed through local tarball overrides; third-party dependencies come from the public registry. Nothing is linked to the checkout, and the CLI entrypoint is not substituted.

The canary covers:

- npm, pnpm, and Bun installations.
- Direct Node and Bun execution, `bun --bun alchemy`, and `bun x --bun` (the `bunx` equivalent).
- npm scripts, `npm exec`, and `npx`; pnpm scripts, `pnpm exec`, and `pnpm alchemy`; Bun scripts, `bun run --bun`, and `bun alchemy`.
- Unset and development `NODE_ENV`, plus caller `react-jsxdev` and Solid-style `preserve` configurations.
- Real noninteractive progress, local-state deploy/destroy, and nonzero exit propagation.
- Production environment, expected runtime, unchanged arguments and working directory, and resolved CLI/package paths inside the temporary install.

Each installer and CLI child receives a minimal environment and a fresh home directory with empty npm configuration. Cloud/registry credentials, user profiles, runtime hooks, module search paths, and checkout executable paths are not inherited. The deployed fixture also asserts that no credential environment variables are present. The pnpm fixture explicitly approves esbuild's and workerd's install scripts. Bun uses `--minimum-release-age=0` for fresh package versions. Temporary projects, homes, and local state are removed when the test scope closes. No cloud or registry credentials are needed.

## Run locally

Build and pack Alchemy and its production workspace dependencies, then provide the artifact directory:

```sh
pnpm build:pkg
export ALCHEMY_CLI_PACKAGES=$(mktemp -d)
pnpm --filter-prod 'alchemy...' --recursive pack --pack-destination "$ALCHEMY_CLI_PACKAGES"

for manager in npm pnpm bun; do
  ALCHEMY_CLI_PACKAGE_MANAGER="$manager" timeout 240 pnpm test test/Cli/package.test.ts --retry 0 --sequential
done
```

`ALCHEMY_CLI_PACKAGE_MANAGER` selects one installer. Omitting it runs all three sequentially. Alternatively, `ALCHEMY_CLI_PACKAGE=/absolute/path/alchemy.tgz` tests a single tarball using its published dependency versions, which must already exist in the registry.

Without either artifact variable, the canary is skipped so ordinary unit runs do not install packages or require built artifacts.

## GitHub CI

The Package Preview workflow runs the same release-format packing command and canary immediately after building, **before** publishing preview packages. It uses locally packed workspace dependencies, so it does not need unpublished sibling versions to exist on npm and does not depend on the preview registry. This tests the release format rather than the preview registry's rewritten dependency URLs.
