# GitHub Enterprise Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `github-enterprise` source control provider kind that supports any number of GitHub Enterprise hosts simultaneously, at full parity with the existing GitHub connector.

**Architecture:** Enterprise hosts are derived from `gh auth status --json hosts` — no new settings schema. The single `gh` discovery spec fans out into one `github` row plus one `github-enterprise` row per authenticated non-`github.com` host. Remote-URL detection classifies `*.ghe.com` and `github.*` synchronously, and falls back to a CLI probe (the mechanism GitLab already uses) for arbitrary hostnames. All command execution reuses the existing `GitHubCli` service; only repo-less operations need host targeting, via `GH_HOST`.

**Tech Stack:** TypeScript, Effect (effect-smol), Effect/Schema contracts, React (web), React Native (mobile), `@effect/vitest`, vite-plus (`vp`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-30-github-enterprise-connector-design.md`. Read it before starting.
- Effect-heavy server code: read `.repos/effect-smol/LLMS.md` before writing Effect code. Never import from `.repos/`.
- Run only targeted checks: `vp test run <files>` for tests you touched, plus targeted lint/typecheck. **Never** run `vp check`, `vp run -r test`, or `vp run -r typecheck`.
- Test style varies by file and the file you are editing wins. `apps/server/src/sourceControl/*.test.ts` uses `@effect/vitest` (`it.effect` for Effect-returning tests, `Layer.mock(Service)({...})` for fakes). `packages/shared/src/sourceControl.test.ts`, `packages/client-runtime/src/operations/projects.test.ts`, and `apps/web/src/pullRequestReference.test.ts` use `vite-plus/test`. Check the first line of the file before writing; for a genuinely new file, copy its nearest sibling.
- **Every test file this plan touches already exists.** Merge new cases into the existing `describe` blocks — never overwrite a file, never add a parallel duplicate block, never delete existing coverage.
- `packages/contracts` holds Effect/Schema contracts plus small derived helpers — no heavy runtime logic. `packages/shared` has subpath exports and no barrel.
- Inferred types over annotations. `any` is the enemy.
- Branch is `feat/github-enterprise-connector`, already created and checked out. Commit after each task.
- Provider kind is never persisted — it is recomputed per request from the git remote. No migrations anywhere in this plan.

---

## File Structure

**Contracts**

- Modify `packages/contracts/src/sourceControl.ts` — new kind literal; `id`/`host` on the discovery item; optional `host` on three inputs.

**Shared**

- Modify `packages/shared/src/sourceControl.ts` — enterprise host classification, enterprise presentation.
- Create `packages/shared/src/sourceControl.test.ts` — detection + presentation tests (no test file exists for this module today).

**Server — discovery plumbing**

- Modify `apps/server/src/sourceControl/SourceControlProviderDiscovery.ts` — `expandInstances` hook; probe returns an array.
- Modify `apps/server/src/sourceControl/SourceControlProviderRegistry.ts` — optional discovery spec; flatten discovery; register `github-enterprise`.

**Server — GitHub**

- Modify `apps/server/src/sourceControl/GitHubSourceControlProvider.ts` — `refineUnknownRemote`, `expandInstances`, kind-parametrized provider factory.
- Modify `apps/server/src/sourceControl/GitHubCli.ts` — optional `host` → `GH_HOST`; host-aware clone-url fallback.
- Modify `apps/server/src/sourceControl/SourceControlRepositoryService.ts` — thread `host`; reject hostless `github-enterprise`.

**Web**

- Modify `apps/web/src/pullRequestReference.ts` — host-agnostic PR URL pattern.
- Modify `apps/web/src/components/settings/SourceControlSettings.tsx` — key rows on `id`, render `host`, enterprise icon.
- Modify `apps/web/src/components/GitActionsControl.tsx` — enterprise entries in the publish picker.

**Client runtime + mobile**

- Modify `packages/client-runtime/src/operations/projects.ts` — dynamic add-project sources keyed by discovery `id`.
- Modify `apps/mobile/src/features/projects/AddProjectScreen.tsx` and `AddProjectRepositoryRoute.tsx` — accept enterprise sources.

- Modify `apps/mobile/src/components/SourceControlIcon.tsx` — accept `github-enterprise`.

`apps/web/src/sourceControlPresentation.ts` switches on `presentation.icon`, not on kind. Because the enterprise presentation reuses `icon: "github"`, that file needs **no changes**. Do not edit it.

`SourceControlIcon` is different: `AddProjectScreen.tsx:389` passes the raw source (`kind={props.source}`), not `presentation.icon`, so its `SourceControlIconKind` union does need the new member. Task 12 covers it.

---

### Task 1: Contract — new kind and discovery identity

**Files:**

- Modify: `packages/contracts/src/sourceControl.ts:5-11`, `:52-104`, `:140-145`

**Interfaces:**

- Consumes: nothing.
- Produces: `SourceControlProviderKind` now includes `"github-enterprise"`. `SourceControlProviderDiscoveryItem` gains `id: string` and `host: Option.Option<string>`. `SourceControlRepositoryLookupInput`, `SourceControlCloneRepositoryInput`, and `SourceControlPublishRepositoryInput` each gain `host?: string`.

- [ ] **Step 1: Add the kind literal**

In `packages/contracts/src/sourceControl.ts`, replace the `SourceControlProviderKind` declaration:

```ts
export const SourceControlProviderKind = Schema.Literals([
  "github",
  "github-enterprise",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "unknown",
]);
```

- [ ] **Step 2: Add identity fields to the discovery item**

Replace the `SourceControlProviderDiscoveryItem` declaration:

```ts
export const SourceControlProviderDiscoveryItem = Schema.Struct({
  kind: SourceControlProviderKind,
  id: TrimmedNonEmptyString,
  host: Schema.Option(TrimmedNonEmptyString),
  ...SourceControlDiscoverySharedFields,
  auth: SourceControlProviderAuth,
});
```

`VcsDiscoveryItem` is untouched — it has no `id`, and consumers discriminate the two via the existing `isProviderDiscoveryItem` guard.

- [ ] **Step 3: Add `host` to the three repository inputs**

Add `host: Schema.optional(TrimmedNonEmptyString),` as a field to each of `SourceControlRepositoryLookupInput`, `SourceControlCloneRepositoryInput`, and `SourceControlPublishRepositoryInput`. For example:

```ts
export const SourceControlRepositoryLookupInput = Schema.Struct({
  provider: SourceControlProviderKind,
  repository: TrimmedNonEmptyString,
  host: Schema.optional(TrimmedNonEmptyString),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
```

- [ ] **Step 4: Typecheck the contracts package**

Run: `vp run --filter @t3tools/contracts typecheck`
Expected: PASS. Contracts are self-contained; downstream packages will not typecheck until later tasks and that is expected.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/sourceControl.ts
git commit -m "feat(contracts): add github-enterprise kind and discovery identity"
```

---

### Task 2: Shared — enterprise host detection and presentation

**Files:**

- Modify: `packages/shared/src/sourceControl.ts:24-33`, `:77-93`, `:170-232`
- Modify: `packages/shared/src/sourceControl.test.ts` (exists; uses `vite-plus/test`)

**Interfaces:**

- Consumes: `SourceControlProviderKind` from Task 1.
- Produces: `detectSourceControlProviderFromRemoteUrl` returns `kind: "github-enterprise"` for `*.ghe.com` and `github.*` hosts. `resolveChangeRequestPresentation` handles the new kind, returning `icon: "github"`.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/sourceControl.test.ts`:

```ts
import { describe, expect, it } from "@effect/vitest";

import {
  detectSourceControlProviderFromRemoteUrl,
  resolveChangeRequestPresentation,
} from "./sourceControl.ts";

describe("detectSourceControlProviderFromRemoteUrl", () => {
  it("classifies github.com as github", () => {
    expect(detectSourceControlProviderFromRemoteUrl("https://github.com/owner/repo.git")).toEqual({
      kind: "github",
      name: "GitHub",
      baseUrl: "https://github.com",
    });
  });

  it("classifies a ghe.com tenant as github-enterprise", () => {
    expect(detectSourceControlProviderFromRemoteUrl("https://acme.ghe.com/owner/repo.git")).toEqual(
      {
        kind: "github-enterprise",
        name: "acme.ghe.com",
        baseUrl: "https://acme.ghe.com",
      },
    );
  });

  // Previously classified as kind "github" / name "GitHub Self-Hosted".
  // Reclassification is intended; nothing persists the kind.
  it("classifies a github-prefixed corporate host as github-enterprise", () => {
    expect(detectSourceControlProviderFromRemoteUrl("git@github.acme.com:owner/repo.git")).toEqual({
      kind: "github-enterprise",
      name: "github.acme.com",
      baseUrl: "https://github.acme.com",
    });
  });

  it("leaves an arbitrary GHES hostname unknown for CLI refinement", () => {
    expect(detectSourceControlProviderFromRemoteUrl("https://git.corp.com/owner/repo.git")).toEqual(
      {
        kind: "unknown",
        name: "git.corp.com",
        baseUrl: "https://git.corp.com",
      },
    );
  });

  it("still classifies gitlab hosts as gitlab", () => {
    expect(
      detectSourceControlProviderFromRemoteUrl("https://gitlab.acme.com/group/project.git")?.kind,
    ).toBe("gitlab");
  });
});

describe("resolveChangeRequestPresentation", () => {
  it("presents github-enterprise with GitHub PR terminology and icon", () => {
    const presentation = resolveChangeRequestPresentation({
      kind: "github-enterprise",
      name: "git.corp.com",
      baseUrl: "https://git.corp.com",
    });

    expect(presentation.icon).toBe("github");
    expect(presentation.shortName).toBe("PR");
    expect(presentation.longName).toBe("pull request");
    expect(presentation.providerName).toBe("GitHub Enterprise");
    expect(presentation.checkoutCommandExample).toBe("gh pr checkout 123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run packages/shared/src/sourceControl.test.ts`
Expected: FAIL — enterprise cases return `kind: "github"` or `"unknown"`, and `resolveChangeRequestPresentation` has no `github-enterprise` case.

- [ ] **Step 3: Add the enterprise presentation**

In `packages/shared/src/sourceControl.ts`, after `GITHUB_CHANGE_REQUEST_PRESENTATION`:

```ts
const GITHUB_ENTERPRISE_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "github",
  providerName: "GitHub Enterprise",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "GitHub Enterprise pull request",
  checkoutCommandExample: "gh pr checkout 123",
  urlExample: "https://git.company.com/owner/repo/pull/42",
};
```

Add the case to `resolveChangeRequestPresentation`, immediately after the `"github"` / `undefined` case:

```ts
    case "github-enterprise":
      return GITHUB_ENTERPRISE_CHANGE_REQUEST_PRESENTATION;
```

- [ ] **Step 4: Add enterprise host classification**

Replace `isGitHubHost` and the GitHub branch of `detectSourceControlProviderFromRemoteUrl`:

```ts
function isGitHubHost(host: string): boolean {
  return host === "github.com";
}

function isGitHubEnterpriseHost(host: string): boolean {
  return host !== "github.com" && (host.endsWith(".ghe.com") || host.includes("github"));
}
```

In `detectSourceControlProviderFromRemoteUrl`, replace the existing GitHub block with:

```ts
if (isGitHubHost(hostname)) {
  return {
    kind: "github",
    name: "GitHub",
    baseUrl: toBaseUrl(host),
  };
}

if (isGitHubEnterpriseHost(hostname)) {
  return {
    kind: "github-enterprise",
    name: hostname,
    baseUrl: toBaseUrl(host),
  };
}
```

Leave the GitLab, Azure DevOps, Bitbucket, and `unknown` branches exactly as they are.

- [ ] **Step 5: Run test to verify it passes**

Run: `vp test run packages/shared/src/sourceControl.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/sourceControl.ts packages/shared/src/sourceControl.test.ts
git commit -m "feat(shared): detect and present GitHub Enterprise hosts"
```

---

### Task 3: Discovery plumbing — one spec, many rows

**Files:**

- Modify: `apps/server/src/sourceControl/SourceControlProviderDiscovery.ts:31-40`, `:203-268`
- Modify: `apps/server/src/sourceControl/SourceControlProviderRegistry.ts:31-35`, `:196-284`
- Test: `apps/server/src/sourceControl/SourceControlProviderRegistry.test.ts`

**Interfaces:**

- Consumes: `SourceControlProviderDiscoveryItem` from Task 1.
- Produces: `SourceControlCliDiscoverySpec` gains optional `expandInstances`. `probeSourceControlProvider` returns `Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>` (was a single item). `SourceControlProviderRegistration.discovery` becomes optional. `SourceControlProviderRegistry.discover` stays `Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>`, now flattened.

`expandInstances` has this exact shape:

```ts
export interface SourceControlDiscoveryInstance {
  readonly kind: SourceControlProviderKind;
  readonly id: string;
  readonly host: string | null;
  readonly label: string;
  readonly auth: SourceControlProviderAuth;
}
```

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/sourceControl/SourceControlProviderRegistry.test.ts`. Read the file's existing imports and helpers first and reuse them rather than duplicating; this test needs `Effect`, `Layer.mock`, `ChildProcessSpawner`, `VcsProcess`, `VcsDriverRegistry`, and `ServerConfig` wired the same way the existing tests do.

```ts
describe("SourceControlProviderRegistry.discover", () => {
  it.effect("flattens a spec that expands into multiple instances", () =>
    Effect.gen(function* () {
      const spec = {
        type: "cli",
        kind: "github",
        label: "GitHub",
        executable: "gh",
        versionArgs: ["--version"],
        authArgs: ["auth", "status"],
        parseAuth: () => providerAuth({ status: "unknown" }),
        expandInstances: () => [
          {
            kind: "github" as const,
            id: "github",
            host: "github.com",
            label: "GitHub",
            auth: providerAuth({ status: "authenticated", account: "octocat", host: "github.com" }),
          },
          {
            kind: "github-enterprise" as const,
            id: "github-enterprise:git.corp.com",
            host: "git.corp.com",
            label: "git.corp.com",
            auth: providerAuth({ status: "authenticated", account: "dev", host: "git.corp.com" }),
          },
        ],
        installHint: "Install gh.",
      } satisfies SourceControlCliDiscoverySpec;

      const registry = yield* SourceControlProviderRegistry.makeWithProviders([
        { kind: "github", provider: stubProvider("github"), discovery: spec },
        { kind: "github-enterprise", provider: stubProvider("github-enterprise") },
      ]);

      const items = yield* registry.discover;

      expect(items.map((item) => item.id)).toEqual(["github", "github-enterprise:git.corp.com"]);
      expect(items.map((item) => item.kind)).toEqual(["github", "github-enterprise"]);
      expect(Option.getOrNull(items[1]!.host)).toBe("git.corp.com");
      expect(items[1]!.label).toBe("git.corp.com");
    }),
  );
});
```

Add a local `stubProvider` helper in the test file if one does not already exist:

```ts
const stubProvider = (kind: SourceControlProviderKind) =>
  SourceControlProvider.SourceControlProvider.of({
    kind,
    listChangeRequests: () => Effect.succeed([]),
    getChangeRequest: () => Effect.die("unused"),
    createChangeRequest: () => Effect.die("unused"),
    getRepositoryCloneUrls: () => Effect.die("unused"),
    createRepository: () => Effect.die("unused"),
    getDefaultBranch: () => Effect.succeed(null),
    checkoutChangeRequest: () => Effect.die("unused"),
  });
```

The mocked `VcsProcess.run` must succeed for both the `--version` probe and the `auth status` probe so the expansion path runs.

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/sourceControl/SourceControlProviderRegistry.test.ts`
Expected: FAIL — `expandInstances` is not a known spec field, `discovery` is required on a registration, and `discover` yields one item per spec.

- [ ] **Step 3: Add the expansion hook to the spec type**

In `SourceControlProviderDiscovery.ts`, add the instance interface above `SourceControlDiscoverySpecBase`:

```ts
export interface SourceControlDiscoveryInstance {
  readonly kind: SourceControlProviderKind;
  readonly id: string;
  readonly host: string | null;
  readonly label: string;
  readonly auth: SourceControlProviderAuth;
}
```

Add the optional field to `SourceControlCliDiscoverySpec`, alongside `refineUnknownRemote`:

```ts
  readonly expandInstances?: (
    input: SourceControlAuthProbeInput,
  ) => ReadonlyArray<SourceControlDiscoveryInstance>;
```

- [ ] **Step 4: Return arrays from the probe**

Change `probeSourceControlProvider`'s return type to `Effect.Effect<ReadonlyArray<SourceControlProviderDiscoveryItem>>`.

The `api` branch wraps its single item in an array and sets identity fields:

```ts
if (input.spec.type === "api") {
  return input.spec.probeAuth.pipe(
    Effect.map((auth) => [
      {
        kind: input.spec.kind,
        id: input.spec.kind,
        host: Option.none<string>(),
        label: input.spec.label,
        status: "available" as const,
        version: Option.none<string>(),
        installHint: input.spec.installHint,
        detail: Option.none<string>(),
        auth,
      } satisfies SourceControlProviderDiscoveryItem,
    ]),
  );
}
```

In the `cli` branch, the missing-executable path returns a one-element array with `id: spec.kind` and `host: Option.none()`. On the auth-probe success path, consult `expandInstances`:

```ts
return input.process
  .run({
    /* unchanged auth probe arguments */
  })
  .pipe(
    Effect.map((result) => {
      const instances = spec.expandInstances?.(result);
      if (instances) {
        return instances.map(
          (instance) =>
            ({
              ...item,
              kind: instance.kind,
              id: instance.id,
              host: instance.host === null ? Option.none<string>() : Option.some(instance.host),
              label: instance.label,
              auth: instance.auth,
            }) satisfies SourceControlProviderDiscoveryItem,
        );
      }
      return [
        {
          ...item,
          id: spec.kind,
          host: Option.none<string>(),
          auth: spec.parseAuth(result),
        } satisfies SourceControlProviderDiscoveryItem,
      ];
    }),
    Effect.catch((cause) =>
      Effect.succeed([
        {
          ...item,
          id: spec.kind,
          host: Option.none<string>(),
          auth: unknownAuth(Option.getOrUndefined(detailFromCause(cause))),
        } satisfies SourceControlProviderDiscoveryItem,
      ]),
    ),
  );
```

`DiscoveryProbeResult` (the internal `probeCli` result) is unchanged — identity fields are attached here, not there.

- [ ] **Step 5: Make the registration's discovery spec optional and flatten**

In `SourceControlProviderRegistry.ts`, change the registration interface:

```ts
export interface SourceControlProviderRegistration {
  readonly kind: SourceControlProviderKind;
  readonly provider: SourceControlProvider.SourceControlProvider["Service"];
  readonly discovery?: SourceControlProviderDiscoverySpec;
}
```

Filter out registrations without a spec:

```ts
const discoverySpecs = registrations.flatMap((registration) =>
  registration.discovery ? [registration.discovery] : [],
);
```

Flatten the discovery result:

```ts
      discover: Effect.all(
        discoverySpecs.map((spec) =>
          probeSourceControlProvider({
            spec,
            process,
            cwd: config.cwd,
          }),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((results) => results.flat())),
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `vp test run apps/server/src/sourceControl/SourceControlProviderRegistry.test.ts apps/server/src/sourceControl/SourceControlDiscovery.test.ts`
Expected: PASS. If `SourceControlDiscovery.test.ts` asserts on discovery items, update its fixtures to include `id` and `host`.

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/sourceControl/SourceControlProviderDiscovery.ts apps/server/src/sourceControl/SourceControlProviderRegistry.ts apps/server/src/sourceControl/SourceControlProviderRegistry.test.ts apps/server/src/sourceControl/SourceControlDiscovery.test.ts
git commit -m "feat(server): let a discovery spec expand into multiple provider rows"
```

---

### Task 4: GitHub spec — enterprise expansion and unknown-remote refinement

**Files:**

- Modify: `apps/server/src/sourceControl/GitHubSourceControlProvider.ts:85-95`
- Test: `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`

**Interfaces:**

- Consumes: `SourceControlDiscoveryInstance` and the `expandInstances` hook from Task 3; `parseGitHubAuthStatus` / `findAuthenticatedGitHubAccount` from `./gitHubAuthStatus.ts` (unchanged).
- Produces: `discovery` gains `expandInstances: expandGitHubInstances` and `refineUnknownRemote: refineUnknownGitHubRemote`. Both are module-local functions, exported for test access.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`:

```ts
const authStatusJson = (
  hosts: Record<string, ReadonlyArray<{ login: string; state: string; active: boolean }>>,
) =>
  JSON.stringify({
    hosts: Object.fromEntries(
      Object.entries(hosts).map(([host, accounts]) => [
        host,
        accounts.map((account) => ({ ...account, host })),
      ]),
    ),
  });

const probe = (stdout: string) => ({
  stdout,
  stderr: "",
  exitCode: ChildProcessSpawner.ExitCode(0),
});

describe("expandGitHubInstances", () => {
  it("emits only a github row when no enterprise host is logged in", () => {
    const instances = GitHubSourceControlProvider.expandGitHubInstances(
      probe(
        authStatusJson({ "github.com": [{ login: "octocat", state: "success", active: true }] }),
      ),
    );

    expect(instances.map((instance) => instance.id)).toEqual(["github"]);
    expect(instances[0]!.kind).toBe("github");
    expect(instances[0]!.auth.status).toBe("authenticated");
  });

  it("emits one enterprise row per non-github.com host", () => {
    const instances = GitHubSourceControlProvider.expandGitHubInstances(
      probe(
        authStatusJson({
          "github.com": [{ login: "octocat", state: "success", active: true }],
          "git.corp.com": [{ login: "dev", state: "success", active: false }],
          "acme.ghe.com": [{ login: "dev2", state: "success", active: false }],
        }),
      ),
    );

    expect(instances.map((instance) => instance.id)).toEqual([
      "github",
      "github-enterprise:acme.ghe.com",
      "github-enterprise:git.corp.com",
    ]);
    expect(instances[1]!.kind).toBe("github-enterprise");
    expect(instances[1]!.label).toBe("acme.ghe.com");
    expect(instances[1]!.host).toBe("acme.ghe.com");
    expect(Option.getOrNull(instances[1]!.auth.account)).toBe("dev2");
  });

  it("still emits a github row when github.com is not logged in", () => {
    const instances = GitHubSourceControlProvider.expandGitHubInstances(
      probe(authStatusJson({ "git.corp.com": [{ login: "dev", state: "success", active: true }] })),
    );

    expect(instances[0]!.id).toBe("github");
    expect(instances[0]!.auth.status).toBe("unauthenticated");
    expect(instances).toHaveLength(2);
  });

  it("emits only an unauthenticated github row when output is unparseable", () => {
    const instances = GitHubSourceControlProvider.expandGitHubInstances(probe("not json"));

    expect(instances).toHaveLength(1);
    expect(instances[0]!.id).toBe("github");
  });
});

describe("refineUnknownGitHubRemote", () => {
  const context = {
    provider: { kind: "unknown" as const, name: "git.corp.com", baseUrl: "https://git.corp.com" },
    remoteName: "origin",
    remoteUrl: "https://git.corp.com/owner/repo.git",
  };

  it("claims a remote whose host is authenticated in gh", () => {
    const refined = GitHubSourceControlProvider.refineUnknownGitHubRemote({
      cwd: "/repo",
      context,
      auth: probe(
        authStatusJson({ "git.corp.com": [{ login: "dev", state: "success", active: true }] }),
      ),
    });

    expect(refined).toEqual({
      kind: "github-enterprise",
      name: "git.corp.com",
      baseUrl: "https://git.corp.com",
    });
  });

  it("does not claim a host that failed authentication", () => {
    expect(
      GitHubSourceControlProvider.refineUnknownGitHubRemote({
        cwd: "/repo",
        context,
        auth: probe(
          authStatusJson({ "git.corp.com": [{ login: "dev", state: "error", active: true }] }),
        ),
      }),
    ).toBeNull();
  });

  it("does not claim a host absent from gh auth status", () => {
    expect(
      GitHubSourceControlProvider.refineUnknownGitHubRemote({
        cwd: "/repo",
        context,
        auth: probe(
          authStatusJson({ "github.com": [{ login: "octocat", state: "success", active: true }] }),
        ),
      }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`
Expected: FAIL with "expandGitHubInstances is not a function".

- [ ] **Step 3: Implement expansion and refinement**

In `GitHubSourceControlProvider.ts`, add above the `discovery` export. Note `parseGitHubAuthStatus` already lowercases hosts (`gitHubAuthStatus.ts:53`), so no extra normalization is needed on parsed accounts.

```ts
function githubComAuth(status: ReturnType<typeof parseGitHubAuthStatus>) {
  const accounts = status.accounts.filter((account) => account.host === "github.com");
  const authenticated = findAuthenticatedGitHubAccount(accounts);
  if (authenticated) {
    return providerAuth({
      status: "authenticated",
      account: authenticated.account,
      host: "github.com",
    });
  }
  return providerAuth({
    status: "unauthenticated",
    host: "github.com",
    detail:
      accounts[0]?.error ??
      "Run `gh auth login` to authenticate GitHub CLI with an active account.",
  });
}

export function expandGitHubInstances(
  input: SourceControlAuthProbeInput,
): ReadonlyArray<SourceControlDiscoveryInstance> {
  const status = parseGitHubAuthStatus(input.stdout);
  if (!status.parsed) {
    return [
      {
        kind: "github",
        id: "github",
        host: "github.com",
        label: "GitHub",
        auth: parseGitHubAuth(input),
      },
    ];
  }

  const enterpriseHosts = [
    ...new Set(
      status.accounts.map((account) => account.host).filter((host) => host !== "github.com"),
    ),
  ].sort();

  return [
    {
      kind: "github",
      id: "github",
      host: "github.com",
      label: "GitHub",
      auth: githubComAuth(status),
    },
    ...enterpriseHosts.map((host) => {
      const accounts = status.accounts.filter((account) => account.host === host);
      const authenticated = findAuthenticatedGitHubAccount(accounts);
      return {
        kind: "github-enterprise" as const,
        id: `github-enterprise:${host}`,
        host,
        label: host,
        auth: authenticated
          ? providerAuth({ status: "authenticated", account: authenticated.account, host })
          : providerAuth({
              status: "unauthenticated",
              host,
              detail:
                accounts[0]?.error ?? `Run \`gh auth login --hostname ${host}\` to authenticate.`,
            }),
      };
    }),
  ];
}

export function refineUnknownGitHubRemote(input: SourceControlUnknownRemoteRefinementInput) {
  const host = input.context.provider.name.toLowerCase();
  const authenticated = parseGitHubAuthStatus(input.auth.stdout).accounts.some(
    (account) => account.host === host && account.authenticated,
  );

  if (!authenticated) {
    return null;
  }

  return {
    kind: "github-enterprise",
    name: host,
    baseUrl: input.context.provider.baseUrl,
  } as const;
}
```

Add `type SourceControlDiscoveryInstance` and `type SourceControlUnknownRemoteRefinementInput` to the existing import from `./SourceControlProviderDiscovery.ts`.

- [ ] **Step 4: Wire both hooks into the discovery spec**

```ts
export const discovery = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  expandInstances: expandGitHubInstances,
  refineUnknownRemote: refineUnknownGitHubRemote,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlCliDiscoverySpec;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `vp test run apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/sourceControl/GitHubSourceControlProvider.ts apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts
git commit -m "feat(server): expand gh auth hosts into enterprise connections"
```

---

### Task 5: GitHubCli — host targeting via `GH_HOST`

**Files:**

- Modify: `apps/server/src/sourceControl/GitHubCli.ts:199-248`, `:269-304`, `:306-453`
- Test: `apps/server/src/sourceControl/GitHubCli.test.ts`

**Interfaces:**

- Consumes: nothing from earlier tasks.
- Produces: `GitHubCli.execute`, `getRepositoryCloneUrls`, and `createRepository` accept an optional `host?: string`. When present, the spawned process env is `{ ...process.env, GH_HOST: host }`; when absent, no `env` key is passed at all. `deriveRepositoryCloneUrlsFromCreateOutput(stdout, repository, host)` takes the fallback host as its third parameter.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/sourceControl/GitHubCli.test.ts` (reuse the file's existing `mockRun`, `layer`, and `processOutput` helpers):

```ts
describe("GitHubCli host targeting", () => {
  it.effect("sets GH_HOST when a host is supplied", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              nameWithOwner: "owner/repo",
              url: "https://git.corp.com/owner/repo",
              sshUrl: "git@git.corp.com:owner/repo.git",
            }),
          ),
        ),
      );

      const cli = yield* GitHubCli.GitHubCli;
      yield* cli.getRepositoryCloneUrls({
        cwd: "/repo",
        repository: "owner/repo",
        host: "git.corp.com",
      });

      expect(mockRun.mock.calls[0]![0].env?.GH_HOST).toBe("git.corp.com");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("omits env entirely when no host is supplied", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify({
              nameWithOwner: "owner/repo",
              url: "https://github.com/owner/repo",
              sshUrl: "git@github.com:owner/repo.git",
            }),
          ),
        ),
      );

      const cli = yield* GitHubCli.GitHubCli;
      yield* cli.getRepositoryCloneUrls({ cwd: "/repo", repository: "owner/repo" });

      expect(mockRun.mock.calls[0]![0]).not.toHaveProperty("env");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("derives enterprise clone urls when repo create prints no url", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(Effect.succeed(processOutput("")));

      const cli = yield* GitHubCli.GitHubCli;
      const urls = yield* cli.createRepository({
        cwd: "/repo",
        repository: "owner/repo",
        visibility: "private",
        host: "git.corp.com",
      });

      expect(urls).toEqual({
        nameWithOwner: "owner/repo",
        url: "https://git.corp.com/owner/repo",
        sshUrl: "git@git.corp.com:owner/repo.git",
      });
    }).pipe(Effect.provide(layer)),
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/sourceControl/GitHubCli.test.ts`
Expected: FAIL — `host` is not an accepted property, and the create fallback yields `github.com` URLs.

- [ ] **Step 3: Thread `host` through the service type**

In the `GitHubCli` service declaration, add `readonly host?: string;` to the input objects of `execute`, `getRepositoryCloneUrls`, and `createRepository`. Leave the in-repo operations (`listOpenPullRequests`, `getPullRequest`, `createPullRequest`, `getDefaultBranch`, `checkoutPullRequest`) unchanged — `gh` resolves the host from the repository's git remote for those.

- [ ] **Step 4: Set `GH_HOST` in `execute`**

```ts
const execute: GitHubCli["Service"]["execute"] = (input) =>
  process
    .run({
      operation: "GitHubCli.execute",
      command: "gh",
      args: input.args,
      cwd: input.cwd,
      ...(input.host ? { env: { ...globalThis.process.env, GH_HOST: input.host } } : {}),
      timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    })
    .pipe(Effect.mapError((error) => fromVcsError({ command: "gh", cwd: input.cwd }, error)));
```

`globalThis.process` is required because `process` is shadowed by the `VcsProcess` service binding in this scope.

- [ ] **Step 5: Forward `host` from the two host-aware operations**

In `getRepositoryCloneUrls` and `createRepository`, add `...(input.host ? { host: input.host } : {})` to their `execute({...})` calls.

- [ ] **Step 6: Make the create fallback host-aware**

```ts
function deriveRepositoryCloneUrlsFromCreateOutput(
  stdout: string,
  repository: string,
  host: string = "github.com",
): GitHubRepositoryCloneUrls {
  const match = stdout.match(/https?:\/\/[^\s]+/);
  // ...unchanged URL-parsing block...
  return {
    nameWithOwner: repository,
    url: `https://${host}/${repository}`,
    sshUrl: `git@${host}:${repository}.git`,
  };
}
```

Remove the `const fallbackHost = "github.com";` line and update the call site in `createRepository` to pass `input.host`.

- [ ] **Step 7: Run test to verify it passes**

Run: `vp test run apps/server/src/sourceControl/GitHubCli.test.ts`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/sourceControl/GitHubCli.ts apps/server/src/sourceControl/GitHubCli.test.ts
git commit -m "feat(server): target enterprise hosts with GH_HOST in GitHubCli"
```

---

### Task 6: Kind-parametrized GitHub provider and registration

**Files:**

- Modify: `apps/server/src/sourceControl/GitHubSourceControlProvider.ts:23-43`, `:97-301`
- Modify: `apps/server/src/sourceControl/SourceControlProviderRegistry.ts:286-314`
- Test: `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`

**Interfaces:**

- Consumes: `host` on `GitHubCli` from Task 5; optional `discovery` on registrations from Task 3.
- Produces: `makeProvider(kind: "github" | "github-enterprise")` returns the provider effect. `make` is kept as `makeProvider("github")` so existing importers (including `layer`) keep working. `SourceControlProvider.getRepositoryCloneUrls` and `createRepository` accept an optional `host?: string` in their input, forwarded to `GitHubCli`.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`:

```ts
describe("makeProvider", () => {
  it.effect("tags change requests and errors with the enterprise kind", () =>
    Effect.gen(function* () {
      mockRun.mockReturnValueOnce(
        Effect.succeed(
          processOutput(
            // @effect-diagnostics-next-line preferSchemaOverJson:off
            JSON.stringify([
              {
                number: 7,
                title: "Add widget",
                url: "https://git.corp.com/owner/repo/pull/7",
                baseRefName: "main",
                headRefName: "feature",
                state: "OPEN",
              },
            ]),
          ),
        ),
      );

      const provider = yield* GitHubSourceControlProvider.makeProvider("github-enterprise");
      const requests = yield* provider.listChangeRequests({
        cwd: "/repo",
        headSelector: "feature",
        state: "open",
      });

      expect(provider.kind).toBe("github-enterprise");
      expect(requests[0]!.provider).toBe("github-enterprise");
    }).pipe(Effect.provide(cliLayer)),
  );
});
```

Reuse the file's existing `GitHubCli` mock layer; name it `cliLayer` if the file does not already expose one.

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts`
Expected: FAIL with "makeProvider is not a function".

- [ ] **Step 3: Parametrize the provider factory**

Introduce a kind alias and thread it through. Change `toChangeRequest` to take the kind:

```ts
type GitHubProviderKind = "github" | "github-enterprise";

function toChangeRequest(
  kind: GitHubProviderKind,
  summary: GitHubCli.GitHubPullRequestSummary,
): ChangeRequest {
  return {
    provider: kind,
    // ...remaining fields unchanged...
  };
}
```

Rename `export const make = Effect.gen(function* () { ... })` to:

```ts
export const makeProvider = (kind: GitHubProviderKind) =>
  Effect.gen(function* () {
    // ...existing body...
  });

export const make = makeProvider("github");
```

Inside the body, replace every literal `provider: "github"` in `SourceControlProviderError` constructions with `provider: kind`, replace `kind: "github"` in `SourceControlProvider.SourceControlProvider.of({...})` with `kind`, and update the two `toChangeRequest` call sites plus the `.map(toChangeRequest)` to `.map((summary) => toChangeRequest(kind, summary))`. The `GitHubChangeRequestListDecodeError` keeps `command: "gh"` — that field names the executable, not the provider.

Forward `host` in the two host-aware operations:

```ts
    getRepositoryCloneUrls: (input) =>
      github
        .getRepositoryCloneUrls({
          cwd: input.cwd,
          repository: input.repository,
          ...(input.host ? { host: input.host } : {}),
        })
        .pipe(/* unchanged error mapping */),
```

and the same pattern for `createRepository`.

- [ ] **Step 4: Add `host` to the provider interface**

In `apps/server/src/sourceControl/SourceControlProvider.ts`, add `readonly host?: string;` to the input types of `getRepositoryCloneUrls` and `createRepository`. `bindProviderContext` in the registry spreads `...input`, so `host` flows through untouched.

- [ ] **Step 5: Register the enterprise kind**

In `SourceControlProviderRegistry.ts`'s `make`:

```ts
export const make = Effect.gen(function* () {
  const github = yield* GitHubSourceControlProvider.makeProvider("github");
  const githubEnterprise = yield* GitHubSourceControlProvider.makeProvider("github-enterprise");
  const gitlab = yield* GitLabSourceControlProvider.make;
  const bitbucket = yield* BitbucketSourceControlProvider.make;
  const bitbucketDiscovery = yield* BitbucketSourceControlProvider.makeDiscovery;
  const azureDevOps = yield* AzureDevOpsSourceControlProvider.make;
  return yield* makeWithProviders([
    {
      kind: "github",
      provider: github,
      discovery: GitHubSourceControlProvider.discovery,
    },
    {
      // Rows come from the `gh` spec's expandInstances; no spec of its own.
      kind: "github-enterprise",
      provider: githubEnterprise,
    },
    // ...gitlab, azure-devops, bitbucket unchanged...
  ]);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `vp test run apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts apps/server/src/sourceControl/SourceControlProviderRegistry.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/sourceControl/GitHubSourceControlProvider.ts apps/server/src/sourceControl/SourceControlProvider.ts apps/server/src/sourceControl/SourceControlProviderRegistry.ts apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts
git commit -m "feat(server): register github-enterprise provider on the gh CLI"
```

---

### Task 7: Repository service — host threading and validation

**Files:**

- Modify: `apps/server/src/sourceControl/SourceControlRepositoryService.ts:97-127`, `:180-232`
- Test: `apps/server/src/sourceControl/SourceControlRepositoryService.test.ts`

**Interfaces:**

- Consumes: `host` on the three contract inputs (Task 1); `host` on provider operations (Task 6).
- Produces: `lookupRepository`, `cloneRepository`, and `publishRepository` forward `input.host`. `ensureConcreteProvider` gains a `host` parameter and fails when `provider === "github-enterprise"` and no host is present.

- [ ] **Step 1: Write the failing test**

Append to `apps/server/src/sourceControl/SourceControlRepositoryService.test.ts` (reuse the file's existing service layer and provider mocks):

```ts
describe("github-enterprise host requirement", () => {
  it.effect("rejects an enterprise lookup with no host", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const error = yield* service
        .lookupRepository({ provider: "github-enterprise", repository: "owner/repo" })
        .pipe(Effect.flip);

      expect(error.detail).toBe("Choose a GitHub Enterprise host before continuing.");
    }),
  );

  it.effect("forwards the host to the provider", () =>
    Effect.gen(function* () {
      const service = yield* SourceControlRepositoryService.SourceControlRepositoryService;
      yield* service.lookupRepository({
        provider: "github-enterprise",
        repository: "owner/repo",
        host: "git.corp.com",
      });

      expect(getRepositoryCloneUrls.mock.calls[0]![0].host).toBe("git.corp.com");
    }),
  );
});
```

`getRepositoryCloneUrls` is the `vi.fn` backing the mocked provider; add it to the file's existing mock setup if it is not already a spy.

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/server/src/sourceControl/SourceControlRepositoryService.test.ts`
Expected: FAIL — the hostless lookup succeeds instead of failing, and `host` never reaches the provider.

- [ ] **Step 3: Validate the host**

```ts
const ensureConcreteProvider = (input: {
  readonly operation: string;
  readonly provider: SourceControlProviderKind;
  readonly host?: string | undefined;
}) => {
  if (input.provider === "unknown") {
    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a source control provider before continuing.",
      }),
    );
  }

  if (input.provider === "github-enterprise" && !input.host?.trim()) {
    return Effect.fail(
      new SourceControlRepositoryError({
        operation: input.operation,
        provider: input.provider,
        detail: "Choose a GitHub Enterprise host before continuing.",
      }),
    );
  }

  return Effect.succeed(input.provider);
};
```

- [ ] **Step 4: Forward the host at all three call sites**

In `lookupRepository`:

```ts
const providerKind =
  yield *
  ensureConcreteProvider({
    operation: "lookupRepository",
    provider: input.provider,
    host: input.host,
  });
const provider = yield * providers.get(providerKind);
const urls =
  yield *
  provider.getRepositoryCloneUrls({
    cwd: input.cwd ?? config.cwd,
    repository: input.repository.trim(),
    ...(input.host ? { host: input.host } : {}),
  });
```

In `cloneRepository`, add `...(input.host ? { host: input.host } : {})` to the inner `lookupRepository({...})` call.

In `publishRepository`, pass `host: input.host` to `ensureConcreteProvider` and add `...(input.host ? { host: input.host } : {})` to the `provider.createRepository({...})` call.

- [ ] **Step 5: Run test to verify it passes**

Run: `vp test run apps/server/src/sourceControl/SourceControlRepositoryService.test.ts`
Expected: PASS

- [ ] **Step 6: Typecheck the server**

Run: `vp run --filter t3-server typecheck` (confirm the package name with `grep '"name"' apps/server/package.json` and use whatever it reports)
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/sourceControl/SourceControlRepositoryService.ts apps/server/src/sourceControl/SourceControlRepositoryService.test.ts
git commit -m "feat(server): route repository operations to an enterprise host"
```

---

### Task 8: Web — accept enterprise pull request URLs

**Files:**

- Modify: `apps/web/src/pullRequestReference.ts:1-2`
- Test: `apps/web/src/pullRequestReference.test.ts` (exists; uses `vite-plus/test`)

**Interfaces:**

- Consumes: nothing.
- Produces: `parsePullRequestReference` accepts `https://<any-host>/<owner>/<repo>/pull/<n>`.

- [ ] **Step 1: Write the failing test**

Merge these cases into the existing `apps/web/src/pullRequestReference.test.ts` (it already imports `describe`/`expect`/`it` from `vite-plus/test` and `parsePullRequestReference` from `./pullRequestReference`). Fold them into the existing describe blocks where one fits; do not overwrite the file or duplicate existing assertions:

```ts
describe("parsePullRequestReference enterprise hosts", () => {
  it("accepts an enterprise pull request url", () => {
    expect(parsePullRequestReference("https://git.corp.com/owner/repo/pull/42")).toBe(
      "https://git.corp.com/owner/repo/pull/42",
    );
  });

  it("accepts a ghe.com pull request url", () => {
    expect(parsePullRequestReference("https://acme.ghe.com/owner/repo/pull/7")).toBe(
      "https://acme.ghe.com/owner/repo/pull/7",
    );
  });

  it("still accepts github.com urls and bare numbers", () => {
    expect(parsePullRequestReference("https://github.com/owner/repo/pull/1")).toBe(
      "https://github.com/owner/repo/pull/1",
    );
    expect(parsePullRequestReference("#12")).toBe("12");
  });

  it("still rejects a non pull request url", () => {
    expect(parsePullRequestReference("https://git.corp.com/owner/repo/issues/42")).toBeNull();
    expect(parsePullRequestReference("https://git.corp.com/owner/repo")).toBeNull();
  });

  it("still unwraps a gh cli checkout command", () => {
    expect(parsePullRequestReference("gh pr checkout https://git.corp.com/owner/repo/pull/9")).toBe(
      "https://git.corp.com/owner/repo/pull/9",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run apps/web/src/pullRequestReference.test.ts`
Expected: FAIL — enterprise URLs return `null`.

- [ ] **Step 3: Widen the pattern**

```ts
const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i;
```

Leave the GitLab and Azure DevOps patterns and the evaluation order in `parsePullRequestReference` exactly as they are.

- [ ] **Step 4: Run test to verify it passes**

Run: `vp test run apps/web/src/pullRequestReference.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/pullRequestReference.ts apps/web/src/pullRequestReference.test.ts
git commit -m "fix(web): accept enterprise pull request urls"
```

---

### Task 9: Web settings — one row per connection

**Files:**

- Modify: `apps/web/src/components/settings/SourceControlSettings.tsx:64-69`, `:565-575`, `:266-300`

**Interfaces:**

- Consumes: `id` and `host` on `SourceControlProviderDiscoveryItem` (Task 1).
- Produces: no exports; UI only.

- [ ] **Step 1: Map the enterprise icon**

```ts
const SOURCE_CONTROL_PROVIDER_ICONS: Partial<Record<SourceControlProviderKind, Icon>> = {
  github: GitHubIcon,
  "github-enterprise": GitHubIcon,
  gitlab: GitLabIcon,
  "azure-devops": AzureDevOpsIcon,
  bitbucket: BitbucketIcon,
};
```

- [ ] **Step 2: Key rows on the item id**

```tsx
{
  result.sourceControlProviders.map((item) => (
    <DiscoveryItemRow key={`provider:${item.id}`} item={item} />
  ));
}
```

Two enterprise connections previously collided on `kind` and React would have warned about duplicate keys.

- [ ] **Step 3: Show the host beside the label**

In `DiscoveryItemRow`, next to the `{item.label}` span, render the host when the item is a provider item, has a host, and the host differs from the label (so the `github` row does not read "GitHub github.com" and an enterprise row does not repeat its own hostname):

```tsx
const host = isProviderDiscoveryItem(item) ? optionLabel(item.host) : null;
```

```tsx
{
  host && host !== item.label ? (
    <code className="text-xs text-muted-foreground">{host}</code>
  ) : null;
}
```

- [ ] **Step 4: Typecheck the web app**

Run: `vp run --filter @t3tools/web typecheck` (confirm the package name with `grep '"name"' apps/web/package.json`)
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/settings/SourceControlSettings.tsx
git commit -m "feat(web): list each GitHub Enterprise connection in settings"
```

---

### Task 10: Web — publish to an enterprise host

**Files:**

- Modify: `apps/web/src/components/GitActionsControl.tsx:158-198` and the publish submit path

**Interfaces:**

- Consumes: discovery `id`/`host` (Task 1); `host` on `SourceControlPublishRepositoryInput` (Task 1); server-side validation (Task 7).
- Produces: no exports; UI only.

- [ ] **Step 1: Make the option list discovery-aware**

Keep `PUBLISH_PROVIDER_OPTIONS` as the static list of the four hosted providers, then derive the rendered list. Add an `id` and `host` to the option shape:

```ts
interface PublishProviderOption {
  readonly id: string;
  readonly value: PublishProviderKind;
  readonly label: string;
  readonly description: string;
  readonly host: string;
  readonly pathPlaceholder: string;
  readonly Icon: typeof GitHubIcon;
}
```

Give each static entry an `id` equal to its `value` (`"github"`, `"gitlab"`, `"bitbucket"`, `"azure-devops"`), matching the discovery ids from Task 4.

- [ ] **Step 2: Append one entry per enterprise connection**

`GitActionsControl.tsx:379` already runs `sourceControlEnvironment.discovery({ environmentId, input: {} })` via `useEnvironmentQuery` — reuse that result rather than adding a second query. Insert enterprise entries directly after the `github` entry so related options stay adjacent:

```ts
const enterpriseOptions: ReadonlyArray<PublishProviderOption> = discovery.sourceControlProviders
  .filter((item) => item.kind === "github-enterprise" && item.status === "available")
  .flatMap((item) => {
    const host = Option.getOrNull(item.host);
    if (!host) return [];
    return [
      {
        id: item.id,
        value: "github-enterprise" as const,
        label: "GitHub Enterprise",
        description: host,
        host,
        pathPlaceholder: "owner/repo",
        Icon: GitHubIcon,
      },
    ];
  });
```

Select the active option by `id`, not by `value` — two enterprise entries share the same `value`.

- [ ] **Step 3: Send the host on publish**

Where the publish command is dispatched, include the selected option's host for enterprise only:

```ts
  provider: selectedOption.value,
  ...(selectedOption.value === "github-enterprise" ? { host: selectedOption.host } : {}),
```

- [ ] **Step 4: Widen `PublishProviderKind`**

Find its declaration (`grep -rn "PublishProviderKind" apps/web/src packages`) and add `"github-enterprise"` so the union covers the new value.

- [ ] **Step 5: Typecheck and lint the web app**

Run: `vp run --filter @t3tools/web typecheck && vp lint apps/web/src/components/GitActionsControl.tsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/GitActionsControl.tsx
git commit -m "feat(web): publish repositories to a GitHub Enterprise host"
```

---

### Task 11: Client runtime — add-project sources per connection

**Files:**

- Modify: `packages/client-runtime/src/operations/projects.ts:25-172`
- Test: `packages/client-runtime/src/operations/projects.test.ts`

**Interfaces:**

- Consumes: discovery `id`/`host` (Task 1), enterprise discovery rows (Task 4).
- Produces:
  - `AddProjectRemoteSource` stays `AddProjectRemoteProviderKind | "url"`, unchanged.
  - New `AddProjectRemoteTarget = { readonly id: string; readonly source: AddProjectRemoteSource; readonly host: string | null }`.
  - New `buildAddProjectRemoteTargets(discovery: SourceControlDiscoveryResult | null): ReadonlyArray<AddProjectRemoteTarget>` — always includes `{ id: "url", source: "url", host: null }` first, then one target per discovery provider row, enterprise rows carrying their host.
  - `AddProjectRemoteSourceReadiness` becomes `ReadonlyMap<string, { ready: boolean; hint: string | null }>` keyed by target `id`.
  - `sortAddProjectProviderSources(readiness, targets)` returns `ReadonlyArray<AddProjectRemoteTarget>` excluding the `url` target.
  - `addProjectRemoteTargetLabel(target)` returns the existing static labels, or the host for an enterprise target.

- [ ] **Step 1: Write the failing test**

Append to `packages/client-runtime/src/operations/projects.test.ts` (reuse the file's existing discovery fixture builder; if it builds items inline, extend it with `id` and `host`):

```ts
describe("buildAddProjectRemoteTargets", () => {
  it("returns url plus one target per discovered connection", () => {
    const targets = buildAddProjectRemoteTargets(
      discoveryResult([
        providerItem({ kind: "github", id: "github", host: "github.com" }),
        providerItem({
          kind: "github-enterprise",
          id: "github-enterprise:git.corp.com",
          host: "git.corp.com",
          label: "git.corp.com",
        }),
      ]),
    );

    expect(targets.map((target) => target.id)).toEqual([
      "url",
      "github",
      "github-enterprise:git.corp.com",
    ]);
    expect(targets[2]!.host).toBe("git.corp.com");
    expect(targets[2]!.source).toBe("github-enterprise");
  });

  it("labels an enterprise target with its host", () => {
    expect(
      addProjectRemoteTargetLabel({
        id: "github-enterprise:git.corp.com",
        source: "github-enterprise",
        host: "git.corp.com",
      }),
    ).toBe("git.corp.com");
  });

  it("keys readiness by target id", () => {
    const discovery = discoveryResult([
      providerItem({
        kind: "github-enterprise",
        id: "github-enterprise:git.corp.com",
        host: "git.corp.com",
        auth: { status: "unauthenticated", detail: "Run gh auth login." },
      }),
    ]);

    const readiness = buildAddProjectRemoteSourceReadiness(discovery);

    expect(readiness.get("github-enterprise:git.corp.com")).toEqual({
      ready: false,
      hint: "Run gh auth login.",
    });
    expect(readiness.get("url")).toEqual({ ready: true, hint: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `vp test run packages/client-runtime/src/operations/projects.test.ts`
Expected: FAIL with "buildAddProjectRemoteTargets is not defined".

- [ ] **Step 3: Add the target type and builder**

```ts
export type AddProjectRemoteProviderKind = Extract<
  SourceControlProviderKind,
  "github" | "github-enterprise" | "gitlab" | "bitbucket" | "azure-devops"
>;
export type AddProjectRemoteSource = AddProjectRemoteProviderKind | "url";

export interface AddProjectRemoteTarget {
  readonly id: string;
  readonly source: AddProjectRemoteSource;
  readonly host: string | null;
}

const URL_TARGET: AddProjectRemoteTarget = { id: "url", source: "url", host: null };

export function buildAddProjectRemoteTargets(
  discovery: SourceControlDiscoveryResult | null,
): ReadonlyArray<AddProjectRemoteTarget> {
  if (!discovery) return [URL_TARGET];
  return [
    URL_TARGET,
    ...discovery.sourceControlProviders.flatMap((provider) =>
      provider.kind === "unknown"
        ? []
        : [{ id: provider.id, source: provider.kind, host: Option.getOrNull(provider.host) }],
    ),
  ];
}
```

- [ ] **Step 4: Add the enterprise label and path hint**

Add `case "github-enterprise": return "GitHub Enterprise";` to `addProjectRemoteSourceLabel` and `case "github-enterprise": return "owner/repo";` to `addProjectRemoteSourcePathHint`. Then add the target-aware label:

```ts
export function addProjectRemoteTargetLabel(target: AddProjectRemoteTarget): string {
  if (target.source === "github-enterprise" && target.host) {
    return target.host;
  }
  return addProjectRemoteSourceLabel(target.source);
}
```

- [ ] **Step 5: Rekey readiness by target id**

```ts
export type AddProjectRemoteSourceReadiness = ReadonlyMap<
  string,
  { readonly ready: boolean; readonly hint: string | null }
>;

export function buildAddProjectRemoteSourceReadiness(
  discovery: SourceControlDiscoveryResult | null,
): AddProjectRemoteSourceReadiness {
  const readiness = new Map<string, { ready: boolean; hint: string | null }>([
    ["url", { ready: true, hint: null }],
  ]);
  if (!discovery) return readiness;

  for (const provider of discovery.sourceControlProviders) {
    if (provider.kind === "unknown") continue;
    if (provider.status !== "available") {
      readiness.set(provider.id, { ready: false, hint: provider.installHint });
      continue;
    }
    if (provider.auth.status === "unauthenticated") {
      readiness.set(provider.id, {
        ready: false,
        hint:
          Option.getOrNull(provider.auth.detail) ??
          `${provider.label} is not authenticated. Open Source Control settings for setup guidance.`,
      });
      continue;
    }
    readiness.set(provider.id, { ready: true, hint: null });
  }
  return readiness;
}
```

The previous "Provider status unavailable" fallback now applies to any target id missing from the map; consumers read it via a helper:

```ts
export function addProjectRemoteTargetReadiness(
  readiness: AddProjectRemoteSourceReadiness,
  targetId: string,
): { readonly ready: boolean; readonly hint: string | null } {
  return (
    readiness.get(targetId) ?? {
      ready: false,
      hint: "Provider status unavailable. Open Source Control settings and rescan.",
    }
  );
}
```

- [ ] **Step 6: Sort targets instead of source literals**

```ts
export function sortAddProjectProviderSources(
  readinessBySource: AddProjectRemoteSourceReadiness,
  targets: ReadonlyArray<AddProjectRemoteTarget>,
): ReadonlyArray<AddProjectRemoteTarget> {
  return Arr.sort(
    targets.filter((target) => target.source !== "url"),
    Order.mapInput(
      Order.Struct({
        ready: Order.flip(Order.Boolean),
        label: Order.String,
      }),
      (target: AddProjectRemoteTarget) => ({
        ready: addProjectRemoteTargetReadiness(readinessBySource, target.id).ready,
        label: addProjectRemoteTargetLabel(target),
      }),
    ),
  );
}
```

Delete `ADD_PROJECT_REMOTE_SOURCES` and `ADD_PROJECT_REMOTE_PROVIDER_SOURCES` — targets now come from discovery.

- [ ] **Step 7: Update the existing tests in the file**

The existing assertion `expect(sortAddProjectProviderSources(readiness)[0]).toBe("github")` (line 99) now needs the targets argument and compares `.id`:

```ts
expect(sortAddProjectProviderSources(readiness, targets)[0]!.id).toBe("github");
```

Update every other call site in the test file the same way.

- [ ] **Step 8: Run test to verify it passes**

Run: `vp test run packages/client-runtime/src/operations/projects.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add packages/client-runtime/src/operations/projects.ts packages/client-runtime/src/operations/projects.test.ts
git commit -m "feat(client-runtime): derive add-project sources from discovered connections"
```

---

### Task 12: Consumers — web command palette and mobile add project

**Files:**

- Modify: `apps/web/src/components/CommandPalette.tsx:179-230`
- Modify: `apps/mobile/src/features/projects/AddProjectScreen.tsx:95-106`, `:371-390`, `:505-515`, `:605-640`
- Modify: `apps/mobile/src/features/projects/AddProjectRepositoryRoute.tsx:15-24`
- Modify: `apps/mobile/src/components/SourceControlIcon.tsx:3-16`

**Interfaces:**

- Consumes: `AddProjectRemoteTarget`, `buildAddProjectRemoteTargets`, `addProjectRemoteTargetLabel`, `addProjectRemoteTargetReadiness`, and the new `sortAddProjectProviderSources` signature from Task 11.
- Produces: no exports; UI only.

- [ ] **Step 1: Update the web command palette**

`CommandPalette.tsx` declares its own local `AddProjectRemoteSource` alias and a static `REMOTE_PROJECT_SOURCES` array. Replace both with targets from `buildAddProjectRemoteTargets(discovery)`, render `addProjectRemoteTargetLabel(target)`, use `addProjectRemoteSourcePathHint(target.source)` for the hint, and carry `target.host` into the navigation params it dispatches.

- [ ] **Step 2: Carry host through mobile route params**

In `AddProjectRepositoryRoute.tsx`, add `host` to `AddProjectRepositoryRouteParams` and replace the hardcoded source check with a target-aware title:

```tsx
const source = Array.isArray(params.source) ? params.source[0] : params.source;
const host = Array.isArray(params.host) ? params.host[0] : params.host;
const title =
  source === "github" ||
  source === "github-enterprise" ||
  source === "gitlab" ||
  source === "bitbucket" ||
  source === "azure-devops"
    ? addProjectRemoteTargetLabel({ id: source, source, host: host ?? null })
    : "Git URL";
```

- [ ] **Step 3: Accept the enterprise source in mobile param parsing**

In `AddProjectScreen.tsx`, add `source === "github-enterprise" ||` to the `sourceFromParam` guard, and thread a `host: string | null` alongside `source` through the screen's props and navigation calls.

- [ ] **Step 4: Render targets in the mobile picker**

Replace the `["url", ...sortAddProjectProviderSources(readiness)]` mapping at line 509 with targets:

```tsx
{[
  { id: "url", source: "url", host: null } as AddProjectRemoteTarget,
  ...sortAddProjectProviderSources(readiness, targets),
].map((target) => (
  // key on target.id, label with addProjectRemoteTargetLabel(target),
  // readiness via addProjectRemoteTargetReadiness(readiness, target.id)
))}
```

- [ ] **Step 5: Send the host on lookup**

In `lookupRepository` (line ~608), include the host:

```ts
const result = await lookupRepositoryQuery({
  environmentId: environment.environmentId,
  input: {
    provider,
    repository: repositoryInput.trim(),
    ...(host ? { host } : {}),
  },
});
```

- [ ] **Step 6: Accept the enterprise kind in the mobile icon**

`AddProjectScreen.tsx:389` renders `<SourceControlIcon kind={props.source} …>`, passing the raw source rather than a presentation icon, so the union must widen. In `apps/mobile/src/components/SourceControlIcon.tsx`:

```tsx
export type SourceControlIconKind =
  | "github"
  | "github-enterprise"
  | "gitlab"
  | "bitbucket"
  | "azure-devops";
```

Then make the existing GitHub arm serve both by replacing `case "github":` with:

```tsx
    case "github":
    case "github-enterprise":
```

Leave the SVG body untouched — enterprise reuses the GitHub mark.

- [ ] **Step 7: Typecheck web and mobile**

Run: `vp run --filter @t3tools/web typecheck && vp run --filter @t3tools/mobile typecheck` (confirm both package names from their `package.json` files)
Expected: PASS

- [ ] **Step 8: Run the touched test files**

Run: `vp test run packages/client-runtime/src/operations/projects.test.ts packages/shared/src/sourceControl.test.ts apps/web/src/pullRequestReference.test.ts apps/server/src/sourceControl/`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/CommandPalette.tsx apps/mobile/src/features/projects/AddProjectScreen.tsx apps/mobile/src/features/projects/AddProjectRepositoryRoute.tsx apps/mobile/src/components/SourceControlIcon.tsx
git commit -m "feat(web,mobile): offer GitHub Enterprise connections when adding a project"
```

---

## Manual verification

After Task 12, on a machine with `gh` authenticated against an enterprise host (`gh auth login --hostname <host>`):

1. Open Source Control settings. Expect a `GitHub` row plus one row per enterprise host, each showing its own account.
2. Open a repository cloned from the enterprise host. Expect PR list, PR view, and create-PR to work and to say "pull request".
3. Paste an enterprise PR URL into the PR reference field. Expect it to be accepted.
4. Add Project → expect the enterprise host listed as its own source; look up `owner/repo` against it.

Ask before launching a dev server or browser. If asked to verify in a real client, use the `test-t3-app` skill for web and `test-t3-mobile` for mobile.

## Notes for the implementer

- `parseGitHubAuthStatus` lowercases hosts already (`gitHubAuthStatus.ts:53`). Compare hosts lowercased everywhere else.
- `gh auth status --json hosts` is only available on newer `gh`. The existing code already tolerates unparseable output by falling back to `parseGitHubAuth`; Task 4's `status.parsed` check preserves that path — do not remove it.
- Provider-context detection is cached for 5 seconds (`SourceControlProviderRegistry.ts:29`). When manually testing detection changes, wait that long or restart the server.
