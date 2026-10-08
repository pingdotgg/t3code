---
title: Optimizing Alchemy's CI Workflows
date: 2026-09-24T16:00:00Z
excerpt: Moving CI to Blacksmith, fixing cache bugs, switching to pnpm, running CI conditionally and cut website build times from 162s to 39s.
---

As of writing this, Alchemy is a monorepo of almost 100 packages (86 of them are [distilled](https://distilled.cloud) SDKs), with a docs website with thousands of generated pages, regular CI checks, preview package publishing, tests for our local cloudflare runtime and a release pipeline that publishes to npm. Over past few weeks we made several CI improvements to make it so the contributors and their agents can iterate fast.

## Swapping out GitHub runners and Tooling
Our first immediate improvement came from moving our workflows to [Blacksmith](https://blacksmith.sh/?ref=alchemy.run) runners ([#1162](https://github.com/alchemy-run/alchemy/pull/1162)). Just by doing this we saw a huge improvement, let's take a look at some numbers:

| Workflow | Before | After | |
|---|---:|---:|---:|
| check | 7.8 min | 4.8 min | −38% |
| cloudflare-tools | 16.2 min | 5.3 min | −67% |
| pr-package | 5.0 min | 3.2 min | −36% |

These numbers are compiled from a very short numbers of runs we had immediately after switching, since I started optimizing the CI pipeline soon after we don't have much data to compare, but it's clear that just by switching to Blacksmith made a difference already.

We also switched our package manager from `bun` to `pnpm` ([#1214](https://github.com/alchemy-run/alchemy/pull/1214)). Bun kept us giving trouble: it behaves weirdly around updating lock files when manually add/removing deps from `package.json`, fails randomly during install failures in CI, broke our publishing of packages when using `workspace:` and `catalog:` in dependencies, doesn't respect `publishConfig` overrides, didn't have deduping until `1.4`, doesn't work without `pkg.alchemy.run` preview URLs since it doesn't dedupe tarball url deps, and the list goes on.

We are still supporting and using bun as our runtime, but our repo is stuck on bun `1.3.13` since later versions introduced a [bug in `AsyncLocalStorage`](https://github.com/oven-sh/bun/issues/32693) which breaks our test runner. This is yet to be fixed and our blocker for upgrading `bun`.

All of our CI now runs on Blacksmith, except for **npm releases**. Npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/) only allows publishing from GitHub-hosted runners, GitLab.com, and CircleCI cloud. So we had to split releases in two jobs: build on Blacksmith, publish on GitHub. We don't want this extra complexity, but npm has yet to [allow trusted publishing from any other CI provider](https://x.com/samgoodwin89/status/2085278917825552412).

```yaml  
name: Release
jobs:
  build:
    runs-on: blacksmith-8vcpu-ubuntu-2404  
    # Build, Pack, Upload tarballs  
  publish:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      id-token: write  
    # Publish tarballs using pnpm publish which handles everything
```

## Making our website deploy faster

Our docs site is a content heavy site. It used to have over 4k+ pages (and paired OG image for each page), most of them being generated specs from our jsdoc. It would take up to 25 min building and deploying all those pages and assets.
[Astro 7.2](https://astro.build/blog/astro-720/) shipped [experimental incremental builds](https://docs.astro.build/en/reference/experimental-flags/incremental-build/), which skip building pages that haven't changed. We enabled it, patched Starlight to support it, and persisted the cache across CI runs ([#1128](https://github.com/alchemy-run/alchemy/pull/1128), [#1136](https://github.com/alchemy-run/alchemy/pull/1136)). Now a warm build restores most of the pages and almost all OG images.

But the biggest improvement came from changing how the API references are generated. We had one page per resource totaling to 4,368 pages. We merged them into one page per service ([#1767](https://github.com/alchemy-run/alchemy/pull/1767), [#1774](https://github.com/alchemy-run/alchemy/pull/1774)).

| | Before | After |
|---|---:|---:|
| Reference pages | 4,368 | 406 |
| Cold build | 162 s | 39 s |
| Output size | 3.64GB | 438MB |
| Website CI run (median) | 8.0 min | 4.1 min |

Along with that, Website previews in PRs used to deploy a new Worker each time. Now they're versions of a single stable preview Worker, so assets already uploaded from `main` are reused ([#1267](https://github.com/alchemy-run/alchemy/pull/1267)). Deploys on PRs are still only triggered when `deploy-website` tag is used, and doesn't work on fork PRs yet.

## Conditional Test runs, workflow concurrency and cancellation

We went through our runs to find where we were burning minutes ([#1362](https://github.com/alchemy-run/alchemy/pull/1362)).

- New pushes in the PR didn't cancel the already ongoing runs, so every commit was still running the full CI even though our agents had already pushed more commits to the branch. Now we cancel the old runs in the same group.
- Cloudflare tooling tests always ran, regardless of if anything related to it happened in the PR. Now we have scoped it to only run when its packages change.
- We were accidentally deleting our stable preview workers. Now that's fixed, so wiping our test account doesn't force a full asset upload.

## Rewriting `pkg.alchemy.run`

[`@alchemy.run/pkg`](https://github.com/alchemy-run/alchemy/pull/1516) publishes every PR's packages to an installable URL, like [pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new). We built our own version of this as soon as we hit pkg.pr.new's limits, and we host it on Cloudflare with Alchemy. We recently rewrote it so now it supports everything:

- Fork PRs can publish without secrets, because each publish is verified against the GitHub Actions run that built it ([#1681](https://github.com/alchemy-run/alchemy/pull/1681)).
- Previews can publish only the packages a change affects ([#1727](https://github.com/alchemy-run/alchemy/pull/1727)).
- Previews stay alive while their PR is open ([#1511](https://github.com/alchemy-run/alchemy/pull/1511)).

## Thanks to Blacksmith

Huge shoutout to our friends at [Blacksmith](https://blacksmith.sh/?ref=alchemy.run) for sponsoring our CI runners. We are utilizing their fast Linux, macOS, and Windows runners. We found Github runners so slow that we were splitting our workloads. With blacksmith's fast runners we just throw our tests across platforms, deploy our content-heavy website, and run checks without having to even think about it.