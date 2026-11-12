# Community fork releases

The fork ships the desktop client and its bundled per-machine server, including Agents and MCP. T3 Connect is removed from the fork, so it needs no Clerk or relay configuration. It does not deploy a hosted web client, mobile apps, or npm packages. Users download the fork once; its updater subsequently follows this repository's nightly releases.

## Enable the release path

`main` is the fork’s default and release branch (`FORK_RELEASE_BRANCH=main`). PR #2 targets `main`; merging it installs both the Agents implementation and the workflows there. GitHub schedules only run from the default branch. Each subsequent reviewed merge to `main` triggers a fork release when `FORK_RELEASE_ENABLED=true`.

`main` requires a pull request and resolution of review conversations, including for administrators. Force-pushes and branch deletion are blocked. Only the owner and explicitly invited write-access collaborators can merge. Automatic merging is disabled. Approve a contributor by granting repository collaborator access; do not grant write access merely so someone can submit a PR.

The workflows are restricted to `jayleaton/t3code` and stay inactive until `FORK_RELEASE_ENABLED=true`. Before enabling, configure the following GitHub repository variables:

| Variable              | Value                                                                           |
| --------------------- | ------------------------------------------------------------------------------- |
| `FORK_RELEASE_BRANCH` | Maintained release branch, normally `main`                                      |
| `FORK_APP_ID`         | Your permanent registered Apple bundle ID, for example `com.jayleaton.t3agents` |
| `FORK_PRODUCT_NAME`   | A distinct permanent name, for example `T3 Agents`                              |
| `APPLE_TEAM_ID`       | Your Apple Developer team ID                                                    |

## Mac signing

Use your own Apple Developer account to create a **Developer ID Application** certificate, retaining its private key securely. Register the permanent fork app identifier and create a Developer ID provisioning profile for it. Configure repository secrets:

- `CSC_LINK`: base64-encoded `.p12` containing the certificate and private key.
- `CSC_KEY_PASSWORD`: the `.p12` password.
- `APPLE_API_KEY`: notarization API key contents in `.p8` format.
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: identifiers for that key.
- `MACOS_PROVISIONING_PROFILE`: base64-encoded provisioning profile for this team and bundle ID.

Do not substitute T3's signing identity.

Keep the bundle ID, product name, signing identity, and install location consistent between releases. Ad-hoc signing ties the designated requirement to a particular build and can cause macOS to forget privacy grants. Old background processes from previous ad-hoc installations can also continue requesting access; after saving active work, a one-time Mac restart clears those processes. This does not guarantee a single prompt across all permission categories.

Windows builds use upstream's optional Azure Trusted Signing secrets when supplied. Without them, the installer is unsigned and Windows may show a reputation warning. Linux AppImage updates use the existing updater; other package formats are not published by this workflow.

## Review and publish

The daily sync checks published upstream nightly tags. It opens one normal merge PR from the upstream commit, then waits until that PR is handled before opening another. It does not overwrite conflict resolutions or merge automatically. Review conflicts and the upstream workflow changes before merging. Fork fixes have been lost when a sync resolved a conflict by dropping or loosening the fork's test for them, so `scripts/fork-guards.json` pins those tests, and CI fails with the fix's PR number when one is removed or changed. On a sync branch, `node scripts/check-fork-guards.ts --base origin/main` also lists the fork fixes whose source files the merge touched. Re-pin with `--update` only after checking the changed test still fails without its fix. Upstream keeps changing T3 Connect files the fork deleted. A checked-in manifest in `scripts/` lists those paths: resolve a modify/delete conflict on a listed path by deleting it. `scripts/check-removed-connect.ts`, part of `vp run check:changed`, fails when a listed path exists again or an `@clerk/` import returns. The built-in GitHub token does not trigger normal PR CI when it creates a PR; the release workflow runs its focused validation after the reviewed merge and before building.

A push to the configured release branch starts the release pipeline. It checks signing and production configuration, runs focused Agents/MCP/packaging tests and scoped typechecks, then builds Mac ARM64/x64, Linux ARM64/x64, and Windows ARM64/x64 on GitHub-hosted runners. Windows packages and signs on Linux, like upstream, then runs its native credential and installer checks on a Windows runner of the same architecture. It includes the corresponding fork Linux runtime for WSL. The MCP companion is transferred with the build artifacts.

The version has the form `<base>-nightly.<UTC date>.<run number × 1000 + attempt>`. Reruns get a new version; previously uploaded release bytes are not overwritten. All six targets must succeed before the draft GitHub release is published with merged architecture update manifests. Failures leave the previous published release available to installed clients. An interrupted upload may leave a draft for inspection or removal.

The update repository is explicitly set to this fork. No release is sent to the official feed, and the upstream infrastructure release workflow is disabled on the fork. Do not switch community users to the stable channel until this fork has a stable release feed.

Before enabling community distribution, test a signed download on the Mac, pair it with the existing devices, exercise Agents and external MCP, then publish and install a second version through the in-app updater. Local tests and workflow lint cannot prove signing, hosted authentication, or an actual update installation.
