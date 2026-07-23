# Native Auto-Review System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a default-off native auto-reviewer that polls open GitHub PRs for SurgeCode projects, runs a structured model review, posts a real GitHub PR review, and optionally auto-prompts the origin thread to fix blocking/important findings.

**Architecture:** Server-owned structured pipeline (not agent-tool free-form). `AutoReviewPoller` discovers work via `gh`; `AutoReviewJobStore` persists idempotent jobs keyed by `(projectId, prNumber, headSha)`; `AutoReviewRunner` fetches diff → `generateAutoReviewFindings` → `submitPullRequestReview` → optional `thread.turn.start` on a linked origin thread. Settings live on `ServerSettings.autoReview` with per-project overrides.

**Tech Stack:** Effect + TypeScript (server, contracts, shared), SQLite migrations, GitHub CLI (`gh`), Vite+ tests (`vp test` / package scripts), SwiftUI macOS settings/status, existing orchestration dispatch path.

**Spec:** `docs/superpowers/specs/2026-07-23-native-auto-review-system-design.md`  
**Issue:** SER-141

## Global Constraints

- Default `autoReview.enabled = false` (no surprise token spend or GitHub posts).
- GitHub only in v1; non-GitHub projects skip silently.
- Server owns GitHub posting; model returns structured findings only.
- Idempotency key: `(projectId, prNumber, headSha)` for `queued|running|succeeded`.
- Origin auto-fix only for `blocking`/`important` findings when a thread can be linked; never invent a new thread.
- Posts as authenticated `gh` user with footer: `SergeCode auto-review · model=… · head=…`.
- Never open PRs against `pingdotgg/t3code`; only `SergeSerb2/SergeCode`.
- Before task completion: `vp check` and `vp run typecheck` must pass for touched packages; `vp run lint:mobile` only if mobile is touched.
- Do not change `apps/mac/version.json` unless the user explicitly chooses a version bump.

## File map

| Path | Role |
|---|---|
| `packages/contracts/src/autoReview.ts` | Settings, findings, job schemas + types |
| `packages/contracts/src/settings.ts` | Wire `autoReview` into `ServerSettings` / patch |
| `packages/contracts/src/rpc.ts` | `autoReview.listJobs` / `autoReview.getJob` methods |
| `packages/shared/src/autoReview.ts` | Pure resolve policy, eligibility, decision mapping, footer, mention match |
| `apps/server/src/sourceControl/GitHubCli.ts` | List repo open PRs (with head SHA), comments, submit review, PR diff |
| `apps/server/src/textGeneration/*` | `generateAutoReviewFindings` + prompts across providers |
| `apps/server/src/autoReview/*` | Job store, runner, poller, origin linker, RPC handlers |
| `apps/server/src/persistence/Migrations/038_AutoReviewJobs.ts` | Durable job + watermark tables |
| `apps/mac/Sources/T3Kit/ServerModels.swift` | Decode `autoReview` settings |
| `apps/mac/Sources/T3Kit/ServerMetaRpc.swift` | Patch encoding for autoReview |
| `apps/mac/Sources/SergeCodeMac/**` | Settings UI + lightweight job status |

---

### Task 1: Contracts — AutoReview settings, findings, jobs

**Files:**
- Create: `packages/contracts/src/autoReview.ts`
- Modify: `packages/contracts/src/settings.ts`
- Modify: `packages/contracts/src/rpc.ts` (method name constants only if group is wired later; prefer defining schemas here and RPC in Task 6)
- Modify: contracts package export index if required by package layout
- Test: `packages/contracts/src/autoReview.test.ts`
- Test: `packages/contracts/src/settings.test.ts` (extend)

**Interfaces:**
- Produces: `AutoReviewMode`, `AutoReviewSettings`, `AutoReviewProjectOverride`, `AutoReviewFindings`, `AutoReviewJob`, `AutoReviewJobStatus`, `DEFAULT_AUTO_REVIEW_SETTINGS`

- [ ] **Step 1: Write failing settings decode tests**

```ts
// packages/contracts/src/autoReview.test.ts
import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  AutoReviewFindings,
  AutoReviewSettings,
  DEFAULT_AUTO_REVIEW_SETTINGS,
} from "./autoReview.ts";
import { ServerSettings } from "./settings.ts";

const decodeAutoReview = Schema.decodeUnknownSync(AutoReviewSettings);
const decodeServer = Schema.decodeUnknownSync(ServerSettings);
const decodeFindings = Schema.decodeUnknownSync(AutoReviewFindings);

describe("AutoReviewSettings", () => {
  it("defaults to disabled auto mode with surgecode mention handle", () => {
    const settings = decodeAutoReview({});
    expect(settings.enabled).toBe(false);
    expect(settings.mode).toBe("auto");
    expect(settings.mentionHandle).toBe("surgecode");
    expect(settings.autoFixOriginThread).toBe(true);
    expect(settings.concurrency).toBe(1);
    expect(settings.projects).toEqual({});
    expect(settings).toEqual(DEFAULT_AUTO_REVIEW_SETTINGS);
  });

  it("is nested on ServerSettings by default", () => {
    expect(decodeServer({}).autoReview.enabled).toBe(false);
  });
});

describe("AutoReviewFindings", () => {
  it("decodes a minimal valid findings payload", () => {
    const findings = decodeFindings({
      summary: "Looks good overall.",
      decision: "comment",
      comments: [
        {
          path: "apps/server/src/foo.ts",
          line: 12,
          side: "RIGHT",
          severity: "important",
          body: "Null check missing.",
        },
      ],
    });
    expect(findings.comments[0]?.severity).toBe("important");
  });
});
```

- [ ] **Step 2: Run tests and confirm failure**

```bash
cd packages/contracts && vp test src/autoReview.test.ts
```

Expected: FAIL — module `./autoReview.ts` not found (or `autoReview` missing on `ServerSettings`).

- [ ] **Step 3: Implement schemas**

Create `packages/contracts/src/autoReview.ts`:

```ts
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelSelection, DEFAULT_GIT_TEXT_GENERATION_MODEL } from /* existing model selection exports — use same defaults as textGenerationModelSelection */;
import { ProviderInstanceId } from "./providerInstance.ts";
import { ThreadId } from /* existing thread id export */;

export const AutoReviewMode = Schema.Literals(["auto", "mention"]);
export type AutoReviewMode = typeof AutoReviewMode.Type;

export const AutoReviewProjectOverride = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  mode: Schema.optional(AutoReviewMode),
  modelSelection: Schema.optional(ModelSelection),
  autoFixOriginThread: Schema.optional(Schema.Boolean),
  mentionHandle: Schema.optional(TrimmedNonEmptyString),
});
export type AutoReviewProjectOverride = typeof AutoReviewProjectOverride.Type;

export const DEFAULT_AUTO_REVIEW_POLL_INTERVAL = Duration.seconds(60);
export const DEFAULT_AUTO_REVIEW_MAX_DIFF_BYTES = 400_000;

export const AutoReviewSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  mode: AutoReviewMode.pipe(Schema.withDecodingDefault(Effect.succeed("auto" as const))),
  modelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        instanceId: ProviderInstanceId.make("codex"),
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
      }),
    ),
  ),
  mentionHandle: TrimmedNonEmptyString.pipe(
    Schema.withDecodingDefault(Effect.succeed("surgecode")),
  ),
  pollInterval: Schema.DurationFromMillis.pipe(
    Schema.withDecodingDefault(
      Effect.succeed(Duration.toMillis(DEFAULT_AUTO_REVIEW_POLL_INTERVAL)),
    ),
  ),
  autoFixOriginThread: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  maxDiffBytes: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_AUTO_REVIEW_MAX_DIFF_BYTES)),
  ),
  concurrency: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(1))),
  projects: Schema.Record(ProjectId, AutoReviewProjectOverride).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type AutoReviewSettings = typeof AutoReviewSettings.Type;
export const DEFAULT_AUTO_REVIEW_SETTINGS: AutoReviewSettings =
  Schema.decodeSync(AutoReviewSettings)({});

export const AutoReviewSeverity = Schema.Literals([
  "blocking",
  "important",
  "nit",
  "info",
]);
export type AutoReviewSeverity = typeof AutoReviewSeverity.Type;

export const AutoReviewDiffSide = Schema.Literals(["LEFT", "RIGHT"]);
export type AutoReviewDiffSide = typeof AutoReviewDiffSide.Type;

export const AutoReviewDecision = Schema.Literals([
  "comment",
  "request_changes",
  "approve",
]);
export type AutoReviewDecision = typeof AutoReviewDecision.Type;

export const AutoReviewInlineComment = Schema.Struct({
  path: TrimmedNonEmptyString,
  line: Schema.NullOr(PositiveInt),
  side: Schema.NullOr(AutoReviewDiffSide),
  severity: AutoReviewSeverity,
  body: Schema.String,
});
export type AutoReviewInlineComment = typeof AutoReviewInlineComment.Type;

export const AutoReviewFindings = Schema.Struct({
  summary: Schema.String,
  decision: AutoReviewDecision,
  comments: Schema.Array(AutoReviewInlineComment),
});
export type AutoReviewFindings = typeof AutoReviewFindings.Type;

export const AutoReviewJobStatus = Schema.Literals([
  "queued",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);
export type AutoReviewJobStatus = typeof AutoReviewJobStatus.Type;

export const AutoReviewTrigger = Schema.Literals(["open_or_push", "mention"]);
export type AutoReviewTrigger = typeof AutoReviewTrigger.Type;

export const AutoReviewJobId = TrimmedNonEmptyString;
export type AutoReviewJobId = typeof AutoReviewJobId.Type;

export const AutoReviewJob = Schema.Struct({
  id: AutoReviewJobId,
  projectId: ProjectId,
  prNumber: PositiveInt,
  headSha: TrimmedNonEmptyString,
  trigger: AutoReviewTrigger,
  commentId: Schema.optional(Schema.NullOr(TrimmedString)),
  status: AutoReviewJobStatus,
  modelSelection: ModelSelection,
  findingsCount: Schema.optional(Schema.NullOr(NonNegativeInt)),
  reviewUrl: Schema.optional(Schema.NullOr(Schema.String)),
  githubReviewId: Schema.optional(Schema.NullOr(TrimmedString)),
  originThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  autoFixEnqueued: Schema.Boolean,
  error: Schema.optional(Schema.NullOr(Schema.String)),
  skipReason: Schema.optional(Schema.NullOr(TrimmedString)),
  createdAt: Schema.String, // IsoDateTime — use project IsoDateTime helper if exported
  updatedAt: Schema.String,
});
export type AutoReviewJob = typeof AutoReviewJob.Type;
```

Wire into `ServerSettings` and `ServerSettingsPatch`:

```ts
// settings.ts — add field
autoReview: AutoReviewSettings.pipe(
  Schema.withDecodingDefault(Effect.succeed(DEFAULT_AUTO_REVIEW_SETTINGS)),
),

// ServerSettingsPatch
autoReview: Schema.optionalKey(AutoReviewSettingsPatch),
```

Define `AutoReviewSettingsPatch` with all keys optional (nested `projects` whole-map replace is fine for v1, matching `customInstructions` style if simpler).

Export new module from the contracts package public surface the same way `review.ts` / `settings.ts` are exported.

- [ ] **Step 4: Re-run tests**

```bash
cd packages/contracts && vp test src/autoReview.test.ts src/settings.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts
git commit -m "feat(contracts): add auto-review settings and findings schemas"
```

---

### Task 2: Pure policy helpers (shared)

**Files:**
- Create: `packages/shared/src/autoReview.ts`
- Create: `packages/shared/src/autoReview.test.ts`
- Modify: `packages/shared/package.json` exports if needed (`@t3tools/shared/autoReview`)

**Interfaces:**
- Consumes: contract types from Task 1
- Produces:
  - `resolveAutoReviewPolicy(global, projectId) → ResolvedAutoReviewPolicy`
  - `shouldEnqueueAutoReviewJob(input) → boolean | { reason }`
  - `matchAutoReviewMention(body, handle) → boolean`
  - `mapFindingsToDecision(comments) → AutoReviewDecision` (enforce server-side override of model decision)
  - `shouldAutoFixOriginThread(findings) → boolean`
  - `buildAutoReviewFooter({ modelSelection, headSha }) → string`
  - `parseAutoReviewFooter(body) → { headSha } | null`
  - `buildOriginFixPrompt({ prNumber, prUrl, headSha, findings }) → string`
  - `clampAutoReviewPollIntervalMs(ms) → number` (15_000…600_000)

- [ ] **Step 1: Write failing pure-function tests**

```ts
import { describe, expect, it } from "vite-plus/test";
import {
  matchAutoReviewMention,
  mapFindingsToDecision,
  resolveAutoReviewPolicy,
  shouldAutoFixOriginThread,
  shouldEnqueueAutoReviewJob,
  buildAutoReviewFooter,
  parseAutoReviewFooter,
} from "./autoReview.ts";
import { DEFAULT_AUTO_REVIEW_SETTINGS } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";

describe("resolveAutoReviewPolicy", () => {
  it("project can opt out while global is enabled", () => {
    const policy = resolveAutoReviewPolicy(
      {
        ...DEFAULT_AUTO_REVIEW_SETTINGS,
        enabled: true,
        projects: {
          "proj_1": { enabled: false },
        },
      },
      "proj_1",
    );
    expect(policy.enabled).toBe(false);
  });

  it("inherits model and mode from global when project omits them", () => {
    const policy = resolveAutoReviewPolicy(
      { ...DEFAULT_AUTO_REVIEW_SETTINGS, enabled: true, mode: "mention" },
      "proj_1",
    );
    expect(policy.enabled).toBe(true);
    expect(policy.mode).toBe("mention");
  });
});

describe("matchAutoReviewMention", () => {
  it("matches @surgecode case-insensitively", () => {
    expect(matchAutoReviewMention("please @SurgeCode review", "surgecode")).toBe(true);
    expect(matchAutoReviewMention("no mention here", "surgecode")).toBe(false);
  });
});

describe("mapFindingsToDecision", () => {
  it("maps blocking to request_changes", () => {
    expect(
      mapFindingsToDecision([{ severity: "blocking" }, { severity: "nit" }]),
    ).toBe("request_changes");
  });
  it("maps only nits to comment", () => {
    expect(mapFindingsToDecision([{ severity: "nit" }])).toBe("comment");
  });
});

describe("shouldEnqueueAutoReviewJob", () => {
  it("skips when a succeeded job already exists for the head sha", () => {
    expect(
      shouldEnqueueAutoReviewJob({
        mode: "auto",
        existingStatus: "succeeded",
        trigger: "open_or_push",
      }),
    ).toBe(false);
  });
  it("allows mention re-review when comment id is new even if succeeded", () => {
    expect(
      shouldEnqueueAutoReviewJob({
        mode: "mention",
        existingStatus: "succeeded",
        trigger: "mention",
        isNewMentionComment: true,
      }),
    ).toBe(true);
  });
});

describe("footer", () => {
  it("round-trips head sha", () => {
    const footer = buildAutoReviewFooter({
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      headSha: "abcdef1234567890",
    });
    expect(parseAutoReviewFooter(footer)?.headSha.startsWith("abcdef1")).toBe(true);
  });
});

describe("shouldAutoFixOriginThread", () => {
  it("is true only for blocking or important", () => {
    expect(shouldAutoFixOriginThread({ comments: [{ severity: "nit" }] })).toBe(false);
    expect(shouldAutoFixOriginThread({ comments: [{ severity: "important" }] })).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

```bash
cd packages/shared && vp test src/autoReview.test.ts
```

- [ ] **Step 3: Implement pure helpers** in `packages/shared/src/autoReview.ts` to satisfy tests. Keep functions free of I/O.

`resolveAutoReviewPolicy` logic:

```ts
export function resolveAutoReviewPolicy(
  settings: AutoReviewSettings,
  projectId: string,
): ResolvedAutoReviewPolicy {
  const override = settings.projects[projectId as ProjectId] ?? {};
  const projectEnabled = override.enabled ?? true;
  return {
    enabled: settings.enabled && projectEnabled,
    mode: override.mode ?? settings.mode,
    modelSelection: override.modelSelection ?? settings.modelSelection,
    autoFixOriginThread: override.autoFixOriginThread ?? settings.autoFixOriginThread,
    mentionHandle: (override.mentionHandle ?? settings.mentionHandle).replace(/^@/, ""),
    maxDiffBytes: settings.maxDiffBytes,
    concurrency: settings.concurrency,
  };
}
```

Mention regex: word-boundary `@` + handle, case-insensitive.

Footer format (exact):

```text
---
SergeCode auto-review · model=<instanceId>/<model> · head=<first 12 of sha>
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): add auto-review policy helpers"
```

---

### Task 3: GitHub CLI — list open PRs, comments, diff, submit review

**Files:**
- Modify: `apps/server/src/sourceControl/GitHubCli.ts`
- Modify: `apps/server/src/sourceControl/GitHubCli.test.ts`
- Optionally extend: `GitHubSourceControlProvider.ts` if provider facade should expose submit (runner may call `GitHubCli` directly for v1)

**Interfaces:**
- Produces:
  - `listRepositoryOpenPullRequests({ cwd, limit? }) → ReadonlyArray<GitHubPullRequestSummary & { headRefOid: string }>`
  - `listPullRequestIssueComments({ cwd, reference, limit? }) → ReadonlyArray<{ id: string; body: string; createdAt: string; authorLogin: string }>`
  - `getPullRequestDiff({ cwd, reference }) → string`
  - `submitPullRequestReview({ cwd, reference, body, event, comments }) → { reviewId: string; url: string }`
- Extend `GitHubPullRequestSummary` with optional `headRefOid` / required when listing for auto-review

- [ ] **Step 1: Write failing CLI unit tests** with mocked `execute` (follow existing `GitHubCli.test.ts` patterns)

Cover:
1. `listRepositoryOpenPullRequests` calls `gh pr list --state open --json number,title,url,baseRefName,headRefName,headRefOid,state,isDraft,...` **without** `--head`.
2. `listPullRequestIssueComments` parses issue comments for a PR number.
3. `submitPullRequestReview` builds the GraphQL or `gh api` payload for summary + inline comments; invalid comments can still be tested at mapping layer in Task 5.

- [ ] **Step 2: Run tests — expect FAIL** (methods missing)

```bash
cd apps/server && vp test src/sourceControl/GitHubCli.test.ts
```

- [ ] **Step 3: Implement methods**

Preferred submit path (stable, scriptable):

```bash
gh api graphql -f query='...' 
# or multi-step:
# 1) create pending review
# 2) add comments
# 3) submit review
```

If GraphQL is too heavy for v1, acceptable alternative:

```bash
gh pr review <n> --comment|--request-changes|--approve --body-file ...
```

plus separate inline comments via:

```bash
gh api repos/{owner}/{repo}/pulls/{n}/comments -f ...
```

Document the chosen approach in a short comment on `submitPullRequestReview`. Prefer one atomic review with inline comments when possible (`pulls/{n}/reviews` REST: `event` + `comments[]` with `path`, `line`, `side`, `body`).

```ts
// REST shape
{
  commit_id: headSha,
  body: summaryWithFooter,
  event: "COMMENT" | "REQUEST_CHANGES" | "APPROVE",
  comments: [{ path, body, line, side }]
}
```

`getPullRequestDiff`:

```bash
gh pr diff <reference>
```

- [ ] **Step 4: Run tests — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/sourceControl
git commit -m "feat(server): github CLI support for auto-review list and submit"
```

---

### Task 4: Text generation — structured auto-review findings

**Files:**
- Modify: `apps/server/src/textGeneration/TextGeneration.ts`
- Modify: `apps/server/src/textGeneration/TextGenerationPrompts.ts`
- Modify: `apps/server/src/textGeneration/TextGenerationPrompts.test.ts`
- Modify: `apps/server/src/textGeneration/CodexTextGeneration.ts`
- Modify: `apps/server/src/textGeneration/ClaudeTextGeneration.ts`
- Modify: `apps/server/src/textGeneration/GrokTextGeneration.ts`
- Modify: corresponding `*.test.ts` stubs
- Any other providers that implement `TextGeneration["Service"]` (search for `generatePrContent:` and update all)

**Interfaces:**
- Produces:

```ts
generateAutoReviewFindings(input: {
  cwd: string;
  prNumber: number;
  prTitle: string;
  prBody: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  diffPatch: string;
  truncated: boolean;
  modelSelection: ModelSelection;
}): Effect<AutoReviewFindings, TextGenerationError>
```

- [ ] **Step 1: Write prompt unit tests**

```ts
// TextGenerationPrompts.test.ts
it("buildAutoReviewFindingsPrompt asks for JSON findings and severity rules", () => {
  const { prompt, outputSchema } = buildAutoReviewFindingsPrompt({
    prNumber: 12,
    prTitle: "Fix bug",
    prBody: "",
    baseBranch: "main",
    headBranch: "feat",
    headSha: "abc",
    diffPatch: "diff --git a/x b/x\n...",
    truncated: true,
  });
  expect(prompt).toContain("blocking");
  expect(prompt).toContain("truncated");
  expect(prompt).toContain("Return a JSON object");
  // outputSchema must decode AutoReviewFindings shape
});
```

- [ ] **Step 2: Implement `buildAutoReviewFindingsPrompt`** in `TextGenerationPrompts.ts`

Rules in prompt (must match spec):
- Focus on correctness, security, regressions, missing tests, API breaks
- Few high-signal comments
- Paths relative to repo root; lines on RIGHT side of new file when possible
- If truncated, say so in summary
- Return JSON: `summary`, `decision`, `comments[]`

Use `limitSection(diffPatch, …)` consistent with PR content prompts.

- [ ] **Step 3: Wire `generateAutoReviewFindings` through registry + each provider**

Mirror `generatePrContent`: resolve instance → call provider structured JSON generation with `outputSchema`.

After model returns, **server-side** re-map decision via `mapFindingsToDecision` so a model cannot approve when blocking findings exist (do this in runner Task 5, or here — prefer runner so providers stay dumb).

- [ ] **Step 4: Update test stubs** that die on unknown methods

- [ ] **Step 5: Run tests**

```bash
cd apps/server && vp test src/textGeneration/TextGenerationPrompts.test.ts src/textGeneration/TextGeneration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/textGeneration
git commit -m "feat(server): structured auto-review findings generation"
```

---

### Task 5: Job store, origin linker, and runner

**Files:**
- Create: `apps/server/src/persistence/Migrations/038_AutoReviewJobs.ts`
- Modify: `apps/server/src/persistence/Migrations.ts` (register migration 38)
- Create: `apps/server/src/autoReview/AutoReviewJobStore.ts`
- Create: `apps/server/src/autoReview/AutoReviewJobStore.test.ts`
- Create: `apps/server/src/autoReview/AutoReviewOriginLinker.ts`
- Create: `apps/server/src/autoReview/AutoReviewOriginLinker.test.ts`
- Create: `apps/server/src/autoReview/AutoReviewRunner.ts`
- Create: `apps/server/src/autoReview/AutoReviewRunner.test.ts`
- Create: `apps/server/src/autoReview/reviewPayload.ts` (map findings → gh comments; drop unanchorable)
- Create: `apps/server/src/autoReview/reviewPayload.test.ts`

**Interfaces:**
- Consumes: GitHubCli (Task 3), TextGeneration (Task 4), shared policy (Task 2), orchestration dispatch
- Produces:
  - `AutoReviewJobStore.enqueue|claimNext|update|list|get|requeueRunning`
  - `linkOriginThread({ projectId, prNumber, headBranch }) → ThreadId | null`
  - `AutoReviewRunner.runJob(jobId)`

#### Schema (migration 038)

```sql
CREATE TABLE IF NOT EXISTS auto_review_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL,
  trigger TEXT NOT NULL,
  comment_id TEXT,
  status TEXT NOT NULL,
  model_selection_json TEXT NOT NULL,
  findings_count INTEGER,
  review_url TEXT,
  github_review_id TEXT,
  origin_thread_id TEXT,
  auto_fix_enqueued INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  skip_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS auto_review_jobs_idempotency
  ON auto_review_jobs(project_id, pr_number, head_sha)
  WHERE status IN ('queued', 'running', 'succeeded');
-- Note: SQLite partial unique indexes: if dialect issues arise, enforce idempotency in store logic instead.

CREATE TABLE IF NOT EXISTS auto_review_comment_watermarks (
  project_id TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  last_comment_id TEXT,
  last_seen_at TEXT,
  PRIMARY KEY (project_id, pr_number)
);
```

If partial unique indexes are painful, implement `enqueue` with a transaction that selects existing active jobs and returns the existing id.

- [ ] **Step 1: Write job store tests** (enqueue dedupe, claim, requeue running)

- [ ] **Step 2: Implement migration + store** until store tests pass

- [ ] **Step 3: Write origin linker tests**

Inputs are pure thread snapshots:

```ts
type ThreadLinkCandidate = {
  threadId: string;
  projectId: string;
  deletedAt: string | null;
  updatedAt: string;
  status: "idle" | "busy" | string;
  prNumber: number | null;
  prState: "open" | "closed" | "merged" | null;
  branch: string | null;
};

linkOriginThread({
  projectId,
  prNumber,
  headBranch,
  candidates,
}) // first: matching prNumber+open; else matching branch; prefer newest; prefer idle
```

- [ ] **Step 4: Implement linker**

In production, load candidates from projection threads + latest VCS status the server already computes for threads (reuse existing VCS status sources used by mac sidebar; if only available client-side, query git status per active thread cwd — prefer existing projection fields if present). If VCS is only computed on refresh, linker may call the same status helper Git workflow uses for a thread’s cwd.

- [ ] **Step 5: Write runner tests with fakes**

Cases:
1. Happy path: diff → findings → submit → auto-fix enqueued when important finding + origin linked.
2. Model failure → status `failed`, **submit not called**.
3. Empty diff → `skipped` / `empty_diff`.
4. Existing footer for same head SHA → success without re-post (unless mention re-request).
5. Only nits → submit, `autoFixEnqueued = false`.

- [ ] **Step 6: Implement runner**

```ts
// Pseudo-order inside runJob
1. mark running
2. getPullRequest + getPullRequestDiff
3. if empty → skipped
4. truncate if > maxDiffBytes
5. generateAutoReviewFindings
6. decision = mapFindingsToDecision(comments)
7. partition comments into anchorable vs summary-only
8. body = summary + unanchored section + buildAutoReviewFooter
9. if parseAutoReviewFooter matches existing review for headSha && !mention re-request → skip submit
10. submitPullRequestReview
11. origin = linkOriginThread(...)
12. if autoFix && shouldAutoFixOriginThread && origin:
      dispatch thread.turn.start with buildOriginFixPrompt(...)
13. mark succeeded
```

**Orchestration dispatch:** inject `OrchestrationEngine` (or the same service `ws.ts` uses) and dispatch:

```ts
{
  type: "thread.turn.start",
  commandId: newCommandId(),
  threadId: originThreadId,
  message: {
    messageId: newMessageId(),
    role: "user",
    text: buildOriginFixPrompt(...),
    attachments: [],
  },
  // omit modelSelection to use thread default; or use thread's model
  createdAt: nowIso,
}
```

If dispatch rejects because a turn is active, rely on orchestration queue behavior (same as client send). If there is no queue and command rejects, leave `autoFixEnqueued=false` and set a soft error note on the job — do not fail the whole review.

- [ ] **Step 7: Run all autoReview + migration tests — expect PASS**

```bash
cd apps/server && vp test src/autoReview src/persistence/Migrations
```

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/autoReview apps/server/src/persistence
git commit -m "feat(server): auto-review job store and runner"
```

---

### Task 6: Poller, server wiring, and listJobs RPC

**Files:**
- Create: `apps/server/src/autoReview/AutoReviewPoller.ts`
- Create: `apps/server/src/autoReview/AutoReviewPoller.test.ts`
- Create: `apps/server/src/autoReview/AutoReviewRpc.ts` (or handlers colocated)
- Modify: `packages/contracts/src/rpc.ts` — add methods + Rpc definitions
- Modify: `apps/server/src/server.ts` / runtime layer composition to provide poller + RPC
- Modify: `apps/server/src/ws.ts` if WS method map needs new entries
- Wire layers next to other long-running services (similar to VCS status broadcaster / provider maintenance)

**Interfaces:**
- Produces: poller fiber that ticks every `pollInterval`; RPC `autoReview.listJobs`, `autoReview.getJob`

- [ ] **Step 1: Write poller unit tests with fake clock / manual `tick()`**

Cases:
1. Global disabled → no list calls.
2. Mode auto + new head SHA → enqueue once; second tick no duplicate.
3. Mode mention + new comment body `@surgecode` → enqueue; watermark advances; same comment no re-enqueue.
4. Non-github project → skip without throw.
5. One project throws → other projects still scanned.

- [ ] **Step 2: Implement poller**

```ts
// each tick
const settings = yield* serverSettings.getSettings
if (!settings.autoReview.enabled) return
const projects = yield* listActiveProjects()
const pollMs = clampAutoReviewPollIntervalMs(Duration.toMillis(settings.autoReview.pollInterval))

for (const project of projects) {
  const policy = resolveAutoReviewPolicy(settings.autoReview, project.id)
  if (!policy.enabled) continue
  // resolve github handle for project.workspaceRoot; skip if not github
  const prs = yield* github.listRepositoryOpenPullRequests({ cwd: project.workspaceRoot })
  for (const pr of prs) {
    if (policy.mode === "auto") {
      yield* jobStore.enqueue({..., trigger: "open_or_push", headSha: pr.headRefOid })
    } else {
      const comments = yield* github.listPullRequestIssueComments(...)
      const watermark = yield* jobStore.getWatermark(project.id, pr.number)
      const fresh = comments filter after watermark
      for (const c of fresh) {
        if (matchAutoReviewMention(c.body, policy.mentionHandle)) {
          yield* jobStore.enqueue({..., trigger: "mention", commentId: c.id, headSha: pr.headRefOid })
        }
      }
      yield* jobStore.setWatermark(...)
    }
  }
}
// drain up to concurrency jobs via runner
```

On startup: `jobStore.requeueRunning()` then start interval.

- [ ] **Step 3: Add RPC**

```ts
// contracts rpc method names
autoReviewListJobs: "autoReview.listJobs",
autoReviewGetJob: "autoReview.getJob",
```

Payloads:

```ts
ListAutoReviewJobsInput = { projectId?: ProjectId; limit?: number }
ListAutoReviewJobsResult = { jobs: AutoReviewJob[] }
GetAutoReviewJobInput = { id: AutoReviewJobId }
GetAutoReviewJobResult = { job: AutoReviewJob | null }
```

- [ ] **Step 4: Wire into server runtime** so poller starts with the server and stops on shutdown.

- [ ] **Step 5: Run server tests for poller + a smoke import test**

```bash
cd apps/server && vp test src/autoReview
```

- [ ] **Step 6: Commit**

```bash
git add packages/contracts apps/server
git commit -m "feat(server): auto-review poller and job RPC"
```

---

### Task 7: macOS settings UI + job status

**Files:**
- Modify: `apps/mac/Sources/T3Kit/ServerModels.swift` — decode `autoReview`
- Modify: `apps/mac/Sources/T3Kit/ServerMetaRpc.swift` — `ServerSettingsPatch` fields for autoReview
- Modify: `apps/mac/Sources/SergeCodeMac/Model/LiveBackend.swift` — map settings into app model
- Modify: settings UI views (locate via search for `textGenerationModelSelection` / server settings form; add Auto-Review section)
- Create/modify: small status view or toolbar badge when any job is `running` for the selected project
- Test: Swift tests for decode defaults if patterns exist; otherwise logic tests for view model mapping

**Interfaces:**
- Consumes: `ServerSettings.autoReview`, `autoReview.listJobs`
- Produces: user can enable/mode/model/auto-fix/per-project override; sees “Reviewing PR #N…”

- [ ] **Step 1: Extend Swift `ServerSettings` decode**

```swift
public struct AutoReviewSettings: Decodable, Sendable {
    public var enabled: Bool
    public var mode: String // "auto" | "mention"
    public var modelSelection: ModelSelection
    public var mentionHandle: String
    public var pollIntervalMs: Double
    public var autoFixOriginThread: Bool
    public var maxDiffBytes: Int
    public var concurrency: Int
    // projects: decode as JSONValue or [String: AutoReviewProjectOverride]
}
```

Defaults must match contracts when keys missing (`enabled = false`, etc.).

- [ ] **Step 2: Settings patch encoder** for the fields the UI edits (at minimum: `enabled`, `mode`, `modelSelection`, `autoFixOriginThread`, `mentionHandle`, `projects`).

- [ ] **Step 3: UI**

Add an “Auto Review” section in the existing server/settings surface:
- Toggle: Enabled
- Picker: Mode (Auto on open/push / Only when @mentioned)
- Model picker: reuse existing provider/model controls if available; otherwise show current `modelSelection` text + note to set via same control as text generation for v1
- Toggle: Auto-fix origin thread
- Text field: Mention handle
- Per-project: simple list of projects with enable override (inherit / on / off)

- [ ] **Step 4: Status**

Poll `autoReview.listJobs` periodically or on settings refresh while a project is selected; if any job `running`, show subtle status text in toolbar or PR panel.

- [ ] **Step 5: Build/test**

```bash
# from repo root — follow apps/mac test docs
vp run typecheck
# native tests if added
```

- [ ] **Step 6: Commit**

```bash
git add apps/mac packages/contracts
git commit -m "feat(mac): auto-review settings and status"
```

---

### Task 8: End-to-end hardening and verification

**Files:**
- Any gaps found in Tasks 1–7
- Optional: `docs/integrations/` short note that auto-review exists (only if project docs already cover GitHub features; keep brief)

- [ ] **Step 1: Spec coverage pass**

Manually check design acceptance criteria against code:
- [ ] enable global + per-project
- [ ] auto mode on open/push
- [ ] mention mode
- [ ] GitHub post with footer
- [ ] origin auto-fix for blocking/important
- [ ] no origin → still posts
- [ ] SHA dedupe
- [ ] poller isolation on errors
- [ ] focused tests exist

- [ ] **Step 2: Run full verification**

```bash
vp check
vp run typecheck
```

If mobile was not touched, skip `lint:mobile`.

- [ ] **Step 3: Manual smoke (local)**

1. Enable auto-review on a test project with a throwaway PR.
2. Confirm one GitHub review posts with footer.
3. Confirm second poll does not duplicate for same SHA.
4. Push a commit → new review for new SHA.
5. With origin thread linked and an `important` finding → fix prompt appears.
6. Disable feature → no new jobs.

- [ ] **Step 4: Final commit if fixes landed**

```bash
git commit -m "fix(auto-review): hardening from verification pass"
```

---

## Self-review (plan vs spec)

| Spec requirement | Task |
|---|---|
| Settings global + per-project | 1, 2, 7 |
| Poll discovery via gh | 3, 6 |
| Mode auto / mention | 2, 6 |
| Structured findings + model selection | 1, 4 |
| Server-owned GitHub post | 3, 5 |
| Origin thread auto-fix | 2, 5 |
| Idempotency by head SHA | 2, 5, 6 |
| Job status for clients | 1, 5, 6, 7 |
| Default off | 1 |
| Tests + vp check | each task + 8 |
| No webhooks / GitHub-only / no invent thread | enforced in 5–6 |

**Out of plan (explicit non-goals):** webhooks, multi-SCM, GitHub App identity, mobile settings UI, create-fix-thread-when-missing, manual enqueue button (optional follow-up).

## Execution notes

- Keep feature default-off until Task 6 is merged so incomplete runners cannot post.
- Prefer fakes over live `gh`/network in unit tests.
- When adding migration 38, if another migration lands first on `main`, renumber accordingly.
- Read `.repos/effect-smol/LLMS.md` before large Effect service layers if patterns are unclear.
