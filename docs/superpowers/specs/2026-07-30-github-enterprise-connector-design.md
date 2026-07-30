# GitHub Enterprise Connector — Design

## Problem

T3 has a GitHub source control connector built on the `gh` CLI. It does not recognize GitHub
Enterprise. Two host families fail:

- **GitHub Enterprise Server** on an arbitrary hostname (`git.corp.com`) —
  `detectSourceControlProviderFromRemoteUrl` (`packages/shared/src/sourceControl.ts:186`) falls
  through to kind `unknown`, so no provider is routed.
- **GitHub Enterprise Cloud with data residency** on `<tenant>.ghe.com` — same failure; the
  hostname contains neither `github` nor `github.com`.

A third case is mislabeled rather than broken: `github.acme.com` matches
`isGitHubHost`'s `host.includes("github")` and resolves to kind `github`, name
"GitHub Self-Hosted".

The `gh` CLI itself supports enterprise hosts natively — `gh auth login --hostname`,
`gh auth status --json hosts`, and per-repo host resolution from the git remote. The gap is
entirely on the T3 side.

## Goals

Full parity with the existing GitHub connector, against any number of enterprise hosts
simultaneously: PR list / view / create / checkout, repository lookup, clone, publish, default
branch, discovery, and settings display.

Enterprise hosts appear as distinct connections, one per host, in the same way Cursor models
separate GitHub and GitHub Enterprise connections.

## Non-goals

T3 does not drive `gh auth login`. Enterprise authentication stays in the user's `gh` config,
consistent with how GitLab, Bitbucket, and Azure DevOps auth work today. An unauthenticated host
surfaces in settings with a `gh auth login --hostname <host>` hint.

## Prior art in this repo

GitLab already solved the self-hosted detection problem. `GitLabSourceControlProvider.ts:73`
defines `refineUnknownGitLabRemote`, wired into the discovery spec as `refineUnknownRemote`. When
a remote resolves to kind `unknown`, `refineUnknownRemoteProvider`
(`SourceControlProviderDiscovery.ts:270`) runs each spec's auth probe and lets it claim the host.
The GitHub spec has no such hook. This design follows the same mechanism.

## Design

### 1. Contract

`packages/contracts/src/sourceControl.ts:5` gains a kind:

```ts
export const SourceControlProviderKind = Schema.Literals([
  "github", "github-enterprise", "gitlab", "azure-devops", "bitbucket", "unknown",
]);
```

Because multiple enterprise hosts coexist, a discovery item needs identity beyond its kind:

```ts
export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  id: TrimmedNonEmptyString,        // "github" | "github-enterprise:git.acme.com"
  host: Schema.Option(TrimmedNonEmptyString),
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
```

`id` replaces `kind` as the React key for settings rows
(`apps/web/src/components/settings/SourceControlSettings.tsx:571`). `host` drives the row subtitle
and host-scoped commands.

Operations that run outside a repository need a target host, so `host` is added as an optional
field to `SourceControlRepositoryLookupInput`, `SourceControlCloneRepositoryInput`, and
`SourceControlPublishRepositoryInput`. It is ignored for every kind except `github-enterprise`,
where it is required.

Nothing persists a provider kind — it is computed at runtime from the git remote on every
request, and the only references outside runtime code are in `packages/contracts/src/git.ts` and
`packages/contracts/src/sourceControl.ts`. Adding a kind therefore needs no data migration, and
reclassifying `github.acme.com` breaks no stored rows.

### 2. Host detection

`detectSourceControlProviderFromRemoteUrl` is synchronous and has no process access, so it can
only classify hosts recognizable by name:

```ts
function isGitHubEnterpriseHost(host: string): boolean {
  return host !== "github.com" && (host.endsWith(".ghe.com") || host.includes("github"));
}
```

Resolution order: `github.com` → kind `github`. Then `*.ghe.com` or a hostname containing
`github` → kind `github-enterprise`, `name` = the hostname, `baseUrl` = `https://<host>`.
Everything else falls through unchanged to `unknown`.

This moves `github.acme.com` from kind `github` / name "GitHub Self-Hosted" to kind
`github-enterprise`. Intended, and safe per §1.

Arbitrary hostnames cannot be classified by name, so they resolve to `unknown` and are refined by
CLI probe. Add to the GitHub discovery spec:

```ts
function refineUnknownGitHubRemote(input: SourceControlUnknownRemoteRefinementInput) {
  const host = input.context.provider.name.toLowerCase();
  const account = parseGitHubAuthStatus(input.auth.stdout).accounts
    .find((entry) => entry.host === host && entry.authenticated);
  if (!account) return null;
  return { kind: "github-enterprise", name: host, baseUrl: input.context.provider.baseUrl } as const;
}
```

A GHES install on an arbitrary hostname is thus recognized once `gh auth login --hostname` has
been run for it — which is required for the connector to function at all, so this adds no burden.
`refineUnknownRemoteProvider` already runs specs in order and takes the first non-null result, and
the outcome is cached for 5 seconds (`SourceControlProviderRegistry.ts:29`).

A `refineUnknownRemote` hook returning a kind other than its own spec's kind is already permitted
by the signature — it returns a full `SourceControlProviderInfo`, not a kind-bound value. No
change to `SourceControlProviderDiscovery.ts`'s refinement path is needed.

### 3. Discovery — one `gh` probe, N rows

`discover` currently maps one spec to one item (`SourceControlProviderRegistry.ts:272`).
Enterprise needs one spec to produce N items, without spawning `gh --version` and
`gh auth status` twice to populate two sections.

The `gh` spec fans out. `SourceControlCliDiscoverySpec` gains an optional hook:

```ts
readonly expandInstances?: (input: SourceControlAuthProbeInput) => ReadonlyArray<{
  readonly kind: SourceControlProviderKind;
  readonly id: string;
  readonly host: string | null;
  readonly label: string;
  readonly auth: SourceControlProviderAuth;
}>;
```

`probeSourceControlProvider` returns `ReadonlyArray<SourceControlProviderDiscoveryItem>` and
`discover` flattens. Specs without `expandInstances` return a single-element array, leaving
GitLab, Bitbucket, and Azure DevOps behavior unchanged.

`expandInstances` is consulted only on the success path, after the auth probe runs. When it is
present it supersedes `parseAuth` for that spec — the `gh` spec keeps `parseAuth` only as the
fallback used by `refineUnknownRemote`, which receives a raw probe rather than expanded items. On
the failure paths — executable missing, or the auth probe itself erroring — the existing
single-item construction runs unchanged using the spec's own `kind`, so a missing `gh` still
yields exactly one `github` row.

The `gh` expansion reads `parseGitHubAuthStatus`, which already parses `hosts` as a record
(`gitHubAuthStatus.ts:44`), and emits:

- always one `github` item for `github.com`, auth from the github.com account — identical to
  today's row
- one `github-enterprise` item per other host, with `id: "github-enterprise:<host>"`,
  `label: <host>`, and auth from that host's account

When `gh` is missing: one `github` item with status `missing`, zero enterprise items. When `gh` is
present but no enterprise host is logged in: zero enterprise items. Enterprise rows exist only
when a connection exists.

Registry side: `github-enterprise` registers a provider (§4) but no discovery spec of its own, so
`SourceControlProviderRegistration.discovery` becomes optional and `discoverySpecs` filters nulls.

Settings groups the flattened list by kind, keys rows on `item.id`, and renders `item.host` as the
row subtitle so two enterprise connections are visually distinct.

### 4. Provider and `gh` host routing

`gh` resolves its target host from the repository's git remote, so every in-repo operation —
`pr list`, `pr view`, `pr create`, `pr checkout`, `repo view --json defaultBranchRef` — works
against an authenticated GHES host with no extra flags. Those paths need only registration.

Operations that run outside a repository do need targeting: `repo view owner/repo` and
`repo create`. Those `GitHubCli` methods gain an optional `host`, threaded into the `env` support
`VcsProcess` already exposes (`VcsProcess.ts:27`):

```ts
...(input.host ? { env: { ...process.env, GH_HOST: input.host } } : {}),
```

`GitHubSourceControlProvider.make` becomes parametrized by kind, since it currently hardcodes
`provider: "github"` in `toChangeRequest` and in every `SourceControlProviderError`:

```ts
export const makeProvider = (kind: "github" | "github-enterprise") => Effect.gen(...)
```

The registry registers both kinds against the same `GitHubCli` service — one binary, two routing
keys, no duplicated command logic.

This also fixes `GitHubCli.ts:279`: `deriveRepositoryCloneUrlsFromCreateOutput` hardcodes
`fallbackHost = "github.com"`, which on an enterprise host silently fabricates a `github.com` URL.
It takes the caller's host, defaulting to `github.com`.

### 5. Host-targeted operations and pickers

`PUBLISH_PROVIDER_OPTIONS` (`apps/web/src/components/GitActionsControl.tsx:158`) is a static list
of four hosted providers. It becomes that list plus one entry per discovered enterprise
connection:

```
GitHub            github.com
GitHub Enterprise git.corp.com
GitHub Enterprise acme.ghe.com
GitLab            gitlab.com
…
```

Selecting an enterprise entry sets `provider: "github-enterprise"` and `host: <host>` on the
publish input. `pathPlaceholder` stays `owner/repo`; `description` is the host. The clone and Add
Project repository pickers on web and mobile (`AddProjectRepositoryRoute.tsx`,
`AddProjectScreen.tsx`) take the same shape.

`SourceControlRepositoryService` threads `host` from those inputs into `getRepositoryCloneUrls`
and `createRepository`, which forward it as `GH_HOST` per §4. `ensureConcreteProvider`
(`SourceControlRepositoryService.ts:101`) additionally rejects `github-enterprise` with no host —
a kind that cannot be routed without one.

Icons: `SOURCE_CONTROL_PROVIDER_ICONS` (web) and `SourceControlIcon.tsx` (mobile) map
`github-enterprise` to the existing GitHub mark.

### 6. Presentation and reference parsing

`packages/shared/src/sourceControl.ts` gains `GITHUB_ENTERPRISE_CHANGE_REQUEST_PRESENTATION`,
identical to the GitHub one — PR / pull request / `gh pr checkout 123`, icon `github` — except
`providerName: "GitHub Enterprise"` and
`urlExample: "https://git.company.com/owner/repo/pull/42"`.

The `switch` in `resolveChangeRequestPresentation` is exhaustive over the literal union, so
TypeScript flags every other site needing the new case. That compiler output is the authoritative
checklist for the remaining web and mobile switches.

`apps/web/src/pullRequestReference.ts:2` pins the PR URL pattern to `github.com`, so an enterprise
PR URL is rejected. Widen it the way the GitLab pattern at line 3 already is:

```ts
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i;
```

Host-agnostic by shape (`/owner/repo/pull/N`), which is correct because the function only
normalizes a reference string for `gh pr view` — and `gh` resolves the host from the repository.
The pattern stays ordered after the Azure DevOps and GitLab patterns; those use `/_git/…
/pullrequest/` and `/-/merge_requests/` and cannot collide with `/pull/`, but the ordering keeps
the intent legible.

## Testing

Unit tests, following the existing per-file `.test.ts` convention:

- `packages/shared` — `detectSourceControlProviderFromRemoteUrl` over `github.com`,
  `acme.ghe.com`, `github.acme.com`, `git.corp.com`, and SSH-form remotes; the
  `github.acme.com` reclassification asserted explicitly as intended behavior
- `GitHubSourceControlProvider.test.ts` — `refineUnknownGitHubRemote` returns enterprise for an
  authenticated matching host and `null` for unauthenticated or non-matching hosts;
  `expandInstances` over a multi-host `gh auth status --json hosts` fixture covering zero, one,
  and two enterprise hosts, plus `gh` missing
- `GitHubCli.test.ts` — `GH_HOST` present when `host` is passed and absent otherwise; enterprise
  clone-url fallback derives the enterprise host, not `github.com`
- `SourceControlRepositoryService.test.ts` — `github-enterprise` without a host is rejected; with
  a host it routes and forwards correctly
- `SourceControlProviderRegistry.test.ts` — flattened multi-item discovery; registration with an
  absent discovery spec
- `pullRequestReference` — enterprise PR URL accepted; non-PR URLs still rejected

## Risks

Widening the PR URL pattern makes it structurally permissive: any `https://host/a/b/pull/N` now
parses. The function's contract is normalization, not validation — `gh pr view` rejects a
reference it cannot resolve — so the blast radius is a clearer downstream error rather than a
wrong action. Tests pin the non-PR rejection cases.

Detection for arbitrary-hostname GHES depends on `gh auth status` succeeding. If `gh` is
installed but the host is not logged in, the remote stays `unknown` and no PR features appear.
This is the same failure mode GitLab self-hosted has today, and the settings row makes the cause
visible.
