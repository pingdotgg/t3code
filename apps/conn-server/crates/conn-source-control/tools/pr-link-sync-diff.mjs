// Pull request link sync differential check. T3's own `PullRequestSyncReactor` and
// `ThreadPullRequestService` (apps/server/src/orchestration-v2) run on stub services and a
// test clock; ours (`src/pull_requests/link_sync.rs` and the engine's deciders, through
// `crates/conn-engine/examples/pr_link_sync_cases.rs`) run the same cases. A case is a set of
// threads and minute-by-minute host answers. Both sides sweep once a minute and feed their own
// commands forward (T3's side applies its commands as its decider does, below), so the reads
// (which pull requests and branches each sweep asks the host for), the commands, and the
// threads at the end must be equal.
//
// It also runs T3's own `BackgroundPolicy` (`shouldRunOpportunisticWork`, which gates the
// periodic branch lookup) and ours (`crates/conn-server/examples/background_gate.rs`) on the
// same settings and client activity reports.
//
//   node crates/conn-source-control/tools/pr-link-sync-diff.mjs <examples/pr_link_sync_cases> <examples/background_gate>
import * as NodeChildProcess from "node:child_process";

import { importSource, packageImporter } from "../../../tools/monorepo.mjs";
import { sealedEnvTemp } from "../../../tools/sealed-env.mjs";

const [binary, gateBinary] = process.argv.slice(2);
if (!binary || !gateBinary) {
  throw new Error("usage: pr-link-sync-diff.mjs <examples/pr_link_sync_cases> <examples/background_gate>");
}

const server = packageImporter("apps/server");
const Effect = await server("effect/Effect");
const Layer = await server("effect/Layer");
const Queue = await server("effect/Queue");
const Stream = await server("effect/Stream");
const Option = await server("effect/Option");
const DateTime = await server("effect/DateTime");
const SecureRandom = await server("effect/crypto/SecureRandom");
const { TestClock } = await server("effect/testing");
const References = await server("effect/References");
const Schema = await server("effect/Schema");
const Contracts = await importSource("packages/contracts/src/index.ts");
const NodeServices = await server("@effect/platform-node/NodeServices");
const src = (path) => importSource(`apps/server/src/${path}`);
const [
  Reactor, BranchService, Orchestrator, ProjectionStore, ProjectStore, PullRequestService,
  GitManager, RepositoryIdentityResolver, BackgroundPolicy, ServerActivation,
] = await Promise.all([
  src("orchestration-v2/PullRequestSyncReactor.ts"),
  src("orchestration-v2/ThreadPullRequestService.ts"),
  src("orchestration-v2/Orchestrator.ts"),
  src("orchestration-v2/ProjectionStore.ts"),
  src("orchestration-v2/ProjectStore.ts"),
  src("pullRequest/PullRequestService.ts"),
  src("git/GitManager.ts"),
  src("project/RepositoryIdentityResolver.ts"),
  src("background/BackgroundPolicy.ts"),
  src("serverActivation.ts"),
]);
const [HostPowerMonitor, ServerSettings] = await Promise.all([
  src("background/HostPowerMonitor.ts"),
  src("serverSettings.ts"),
]);

// ---- Inputs ------------------------------------------------------------------------------

const MIN = 60_000;
const START = Date.parse("2027-01-15T09:00:00.000Z");
const ago = (minutes) => new Date(START - minutes * MIN).toISOString();
const PROJECT = "project-1";
const prUrl = (n) => `https://github.com/o/r/pull/${n}`;
const key = (n) => `github.com/o/r#${n}`;

const summary = (n, extra = {}) => ({
  provider: "github", projectId: PROJECT, repository: "o/r", number: n,
  title: `Change ${n}`, url: prUrl(n), state: "open", headBranch: `b${n}`, baseBranch: "main",
  isDraft: false, updatedAt: ago(5), closedAt: null, mergedAt: null,
  author: { login: "nick", name: "Nick", avatarUrl: "https://github.com/nick.png?size=80" },
  additions: 10, deletions: 2, changedFiles: 1, reviewDecision: "review-required",
  checksState: "failing", mergeability: "mergeable", stack: null, ...extra,
});
const snapshotOf = (s) => ({
  state: s.state, title: s.title, headBranch: s.headBranch, baseBranch: s.baseBranch,
  isDraft: s.isDraft, updatedAt: s.updatedAt, closedAt: s.closedAt, mergedAt: s.mergedAt,
  author: s.author, additions: s.additions, deletions: s.deletions, changedFiles: s.changedFiles,
  reviewDecision: s.reviewDecision, checksState: s.checksState, mergeability: s.mergeability,
  syncedAt: ago(60),
});
const link = (n, snapshot = null, extra = {}) => ({
  host: "github.com", repository: "o/r", number: n, url: prUrl(n), source: "manual",
  linkedAt: ago(120), snapshot, stack: null, ...extra,
});
const thread = (id, extra = {}) => ({
  id, projectId: PROJECT, branch: null, worktreePath: null, pullRequests: [],
  createdAt: ago(600), updatedAt: ago(10), archivedAt: null, settledOverride: null,
  settledAt: null, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  ...extra,
});
const answers = (entries, extra = {}) => ({ summaries: Object.fromEntries(entries), ...extra });

const quiet = summary(2, { updatedAt: ago(120) });
const stackOf = (layers) => ({
  id: "77", number: 77, url: "https://github.com/o/r/stacks/77", base: "main",
  layers: layers.map((n) => ({ number: n, headBranch: `b${n}`, state: "open" })),
});

const linkCases = [
  { name: "a new link is read, then read each minute while active, and synced on change",
    threads: [thread("t1", { pullRequests: [link(1)] })],
    steps: [
      { minutes: 3, ...answers([[key(1), summary(1)]]) },
      { minutes: 2, ...answers([[key(1), summary(1, { checksState: "passing", updatedAt: ago(1) })]]) },
    ] },
  { name: "a quiet open pull request is read every five minutes",
    threads: [thread("t1", { pullRequests: [link(2, snapshotOf(quiet))] })],
    steps: [{ minutes: 11, ...answers([[key(2), quiet]]) }] },
  { name: "a merged one is final; a request reads it again",
    threads: [thread("t1", { pullRequests: [link(3, snapshotOf(summary(3, { state: "merged", mergedAt: ago(30) })))] })],
    steps: [
      { minutes: 3, ...answers([[key(3), summary(3, { state: "merged", mergedAt: ago(30), title: "Renamed" })]]) },
      { request: [key(3)], ...answers([[key(3), summary(3, { state: "merged", mergedAt: ago(30), title: "Renamed" })]]) },
    ] },
  { name: "a missing pull request waits for the slow cadence",
    threads: [thread("t1", { pullRequests: [link(4)] })],
    steps: [{ minutes: 31, ...answers([[key(4), { error: "missing" }]]) }] },
  { name: "failed reads back off, doubling",
    threads: [thread("t1", { pullRequests: [link(5)] })],
    steps: [
      { minutes: 12, ...answers([[key(5), { error: "failed" }]]) },
      { minutes: 2, ...answers([[key(5), summary(5)]]) },
    ] },
  { name: "unknown mergeability with the same update time keeps the known one",
    threads: [thread("t1", { pullRequests: [link(6, snapshotOf(summary(6)))] })],
    steps: [{ minutes: 2, ...answers([[key(6), summary(6, { mergeability: "unknown", checksState: "pending" })]]) }] },
  { name: "a settled thread is not swept; a request reads it",
    threads: [thread("t1", { settledAt: ago(5), pullRequests: [link(7)] })],
    steps: [
      { minutes: 2, ...answers([[key(7), summary(7)]]) },
      { request: [key(7)], ...answers([[key(7), summary(7)]]) },
    ] },
  { name: "a stack is read and its new layers are linked and synced",
    threads: [thread("t1", { pullRequests: [link(8)] })],
    steps: [{ minutes: 2, ...answers(
      [[key(8), summary(8, { stack: { number: 77 } })], [key(9), summary(9, { stack: { number: 77 } })]],
      { stacks: { [key(8)]: stackOf([8, 9]), [key(9)]: stackOf([8, 9]) } },
    ) }] },
  { name: "a stack read that finds a new layer makes the older members read theirs again",
    threads: [thread("t1", { pullRequests: [
      link(40, snapshotOf(summary(40)), { stack: { kind: "native", ...stackOf([40, 41]) } }),
      link(41, snapshotOf(summary(41)), { stack: { kind: "native", ...stackOf([40, 41]) } }),
    ] })],
    steps: [{ minutes: 2, ...answers(
      [[key(40), summary(40, { title: "Renamed", stack: { number: 77 } })],
       [key(41), summary(41, { stack: { number: 77 } })],
       [key(42), summary(42, { stack: { number: 77 } })]],
      { stacks: { [key(40)]: stackOf([40, 41, 42]), [key(41)]: stackOf([40, 41, 42]), [key(42)]: stackOf([40, 41, 42]) } },
    ) }] },
  { name: "one read serves two threads",
    threads: [thread("t1", { pullRequests: [link(10)] }), thread("t2", { pullRequests: [link(10)] })],
    steps: [{ minutes: 1, ...answers([[key(10), summary(10)]]) }] },
  { name: "a pull request closed a day ago is final; closed recently is read slowly",
    threads: [thread("t1", { pullRequests: [
      link(11, snapshotOf(summary(11, { state: "closed", closedAt: ago(2000), updatedAt: ago(2000) }))),
      link(12, snapshotOf(summary(12, { state: "closed", closedAt: ago(30), updatedAt: ago(30) }))),
    ] })],
    steps: [{ minutes: 16, ...answers([
      [key(11), summary(11, { state: "closed", closedAt: ago(2000), updatedAt: ago(2000) })],
      [key(12), summary(12, { state: "closed", closedAt: ago(30), updatedAt: ago(30), title: "Closed" })],
    ]) }] },
  { name: "a dismissed stack member is not read",
    threads: [thread("t1", { pullRequests: [link(13, null, { source: "stack-dismissed" })] })],
    steps: [{ minutes: 1, ...answers([[key(13), summary(13)]]) }] },
];

const reference = (n) => ({ projectId: PROJECT, repository: "o/r", number: n, url: prUrl(n) });
const detected = (n, extra = {}) => ({
  number: n, title: `Change ${n}`, url: prUrl(n), baseBranch: "main", headBranch: "fix",
  state: "open", closedAt: null, mergedAt: null, headSha: null, repositoryKey: "github.com/o/r",
  ...extra,
});
const branchCases = [
  { name: "a branch's open pull request is saved, then looked up each minute",
    threads: [thread("t1", { branch: "fix" })], detected: { fix: detected(20) },
    steps: [{ minutes: 2 }] },
  { name: "a branch without a pull request is looked up again only after 30 minutes",
    threads: [thread("t1", { branch: "fix", updatedAt: ago(1) })], detected: { fix: null },
    steps: [{ minutes: 31 }] },
  { name: "a pull request merged before the thread was made is not taken",
    threads: [thread("t1", { branch: "fix", createdAt: ago(60) })],
    detected: { fix: detected(21, { state: "merged", mergedAt: ago(120) }) },
    steps: [{ minutes: 1 }] },
  { name: "unless T3 checked it out onto the branch",
    threads: [thread("t1", { branch: "fix", createdAt: ago(60) })],
    detected: { fix: detected(22, { state: "merged", mergedAt: ago(120) }) },
    checkedOut: { fix: prUrl(22) },
    steps: [{ minutes: 1 }] },
  { name: "a new pull request replaces the saved one",
    threads: [thread("t1", { branch: "fix", branchPullRequest: reference(23) })],
    detected: { fix: detected(24) },
    steps: [{ minutes: 1 }] },
  { name: "a settled thread's own event looks its branch up",
    threads: [thread("t1", { branch: "fix", settledAt: ago(5) })], detected: { fix: detected(25) },
    steps: [{ minutes: 1 }, { thread: "t1" }] },
  { name: "a thread without a worktree keeps its merged pull request when none is found",
    threads: [
      thread("t1", { branch: "fix", branchPullRequest: reference(26) }),
      thread("t2", { branch: "gone", branchPullRequest: reference(27) }),
    ],
    detected: { fix: null, gone: null },
    previous: {
      [prUrl(26)]: summary(26, { headBranch: "fix", state: "merged", mergedAt: ago(30) }),
      [prUrl(27)]: summary(27, { headBranch: "gone", state: "open" }),
    },
    steps: [{ minutes: 1 }] },
  { name: "a candidate that predates the thread checks the saved pull request first",
    threads: [thread("t1", { branch: "fix", createdAt: ago(60), branchPullRequest: reference(30) })],
    detected: { fix: detected(31, { state: "merged", mergedAt: ago(120) }) },
    previous: { [prUrl(30)]: summary(30, { headBranch: "fix", state: "merged", mergedAt: ago(90) }) },
    steps: [{ minutes: 1 }] },
  { name: "a saved pull request that cannot be read stays",
    threads: [thread("t1", { branch: "gone", branchPullRequest: reference(32) })],
    detected: { gone: null },
    steps: [{ minutes: 1 }] },
  { name: "subagent threads wait for their own events",
    threads: [thread("t1", { branch: "fix", lineage: { parentThreadId: "t0", relationshipToParent: "subagent", rootThreadId: "t0" } })],
    detected: { fix: detected(28) },
    steps: [{ minutes: 1 }, { thread: "t1" }] },
];

// ---- T3 ----------------------------------------------------------------------------------

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(1));
const keysEqual = (a, b) =>
  a.host.toLowerCase() === b.host.toLowerCase() &&
  a.repository.toLowerCase() === b.repository.toLowerCase() &&
  a.number === b.number;
const keyOf = (l) => `${l.host.toLowerCase()}/${l.repository.toLowerCase()}#${l.number}`;
const strip = ({ commandId: _, ...rest }) => rest;
const iso = (ms) => new Date(ms).toISOString();

// T3's decider for the commands these services send (Orchestrator.ts, the
// `thread.pull-request.link | unlink | -link.sync` and `thread.pull-request.sync` cases), for
// the cases' shapes: no older single link, no tombstone lifted.
function applyT3(threads, command, nowMs) {
  return threads.map((t) => {
    if (t.id !== command.threadId) return t;
    const links = t.pullRequests ?? [];
    if (command.type === "thread.pull-request-link.sync") {
      if (!links.some((l) => keysEqual(l, command))) return t;
      return { ...t, linkedPullRequest: t.linkedPullRequest ? t.linkedPullRequest : null,
        pullRequests: links.map((l) => keysEqual(l, command) ? { ...l, snapshot: command.snapshot, stack: command.stack } : l) };
    }
    if (command.type === "thread.pull-request.link") {
      if (links.some((l) => keysEqual(l, command))) return t;
      const { host, repository, number, url, source } = command;
      return { ...t, linkedPullRequest: t.linkedPullRequest ? t.linkedPullRequest : null, updatedAt: iso(nowMs),
        pullRequests: [...links, { host: host.toLowerCase(), repository: repository.toLowerCase(), number, url, source, linkedAt: iso(nowMs), snapshot: null, stack: null }] };
    }
    if (command.type === "thread.pull-request.sync") return { ...t, branchPullRequest: command.branchPullRequest };
    return t;
  });
}

const failureOf = (answer, operation) =>
  answer.error === "missing"
    ? new Contracts.PullRequestOperationError({ operation, detail: "Pull request not found", reason: "not-found" })
    : new Contracts.PullRequestOperationError({ operation, detail: "GitHub failed" });

async function t3Links(c) {
  let threads = structuredClone(c.threads);
  let step = c.steps[0];
  let now = START;
  let reads = [];
  let commands = [];
  const out = [];
  const program = Effect.gen(function* () {
    const sweeps = yield* Queue.unbounded();
    const layer = Reactor.layer.pipe(Layer.provide(Layer.mergeAll(
      Layer.mock(PullRequestService.PullRequestService)({
        withSharedProjectReads: (effect) => effect,
        batchesReads: () => Effect.succeed(true),
        invalidate: () => Effect.void,
        subscribeStateChanges: Effect.succeed(Stream.empty),
        summary: (ref) => Effect.suspend(() => {
          const k = keyOf({ host: "github.com", ...ref });
          reads.push(k);
          const answer = step.summaries[k];
          return answer.error ? Effect.fail(failureOf(answer, "summary")) : Effect.succeed(answer);
        }),
        stack: (ref) => Effect.suspend(() => {
          const k = keyOf({ host: "github.com", ...ref });
          reads.push(`stack ${k}`);
          const answer = step.stacks?.[k] ?? null;
          if (answer?.error === "rate-limited") {
            return Effect.fail(new Contracts.PullRequestOperationError({ operation: "stack", detail: "limited",
              cause: new (Contracts.PullRequestProviderError ?? Error)({ provider: "github", operation: "stack", reason: "rate-limited", detail: "limited" }) }));
          }
          return answer?.error ? Effect.fail(failureOf(answer, "stack")) : Effect.succeed(answer);
        }),
      }),
      Layer.mock(GitManager.GitManager)({ subscribePullRequestStateChanges: Effect.succeed(Stream.empty) }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadsWithPullRequests: (threadId) => Queue.offer(sweeps, undefined).pipe(Effect.as(
          threads.filter((t) => (threadId === undefined || t.id === threadId) && t.archivedAt === null && t.pullRequests.length > 0)
            .map((t) => ({ id: t.id, projectId: t.projectId, lineage: t.lineage, settledOverride: t.settledOverride,
              settledAt: t.settledAt === null ? null : DateTime.makeUnsafe(t.settledAt), pullRequests: t.pullRequests })),
        )),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        dispatch: (command) => Effect.sync(() => {
          commands.push(strip(command));
          threads = applyT3(threads, command, now);
          return { sequence: 1, storedEvents: [] };
        }),
        streamDomainEvents: Stream.empty,
      }),
      Layer.succeed(ServerActivation.ServerActivation, undefined),
      Layer.succeed(SecureRandom.SecureRandom, testCrypto),
    )));
    yield* Effect.gen(function* () {
      const reactor = yield* Reactor.PullRequestSyncReactor;
      const record = () => {
        out.push({ at: now, reads: [...reads].sort(), commands: sortCommands(commands) });
        reads = [];
        commands = [];
      };
      yield* reactor.start();
      yield* Queue.take(sweeps);
      yield* reactor.drain;
      record();
      for (const s of c.steps) {
        step = s;
        if (s.request) {
          for (const k of s.request) {
            const [host, rest] = [k.slice(0, k.indexOf("/")), k.slice(k.indexOf("/") + 1)];
            const [repository, number] = rest.split("#");
            yield* reactor.requestSync({ host, repository, number: Number(number) });
          }
          yield* Queue.take(sweeps);
          yield* reactor.drain;
          record();
          continue;
        }
        for (let i = 0; i < s.minutes; i++) {
          now += MIN;
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          yield* reactor.drain;
          record();
        }
      }
    }).pipe(Effect.provide(layer));
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* program;
    }).pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      // The services log skipped reads; the comparison is the output.
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );
  return { steps: out, threads };
}

async function t3Branches(c) {
  let threads = structuredClone(c.threads);
  let now = START;
  let lookups = [];
  let commands = [];
  const out = [];
  const project = {
    id: PROJECT, title: "Project", workspaceRoot: "/nonexistent/project", defaultModelSelection: null,
    scripts: [], createdAt: ago(1000), updatedAt: ago(1000),
  };
  const identity = { canonicalKey: "github.com/o/r", locator: { source: "git-remote", remoteName: "origin", remoteUrl: "https://github.com/o/r.git" },
    provider: "github", owner: "o", name: "r" };
  const program = Effect.gen(function* () {
    const sweeps = yield* Queue.unbounded();
    const events = yield* Queue.unbounded();
    const services = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getPullRequestSnapshot: (input) => Queue.offer(sweeps, undefined).pipe(Effect.as({
          snapshotSequence: 5,
          threads: threads
            .filter((t) => input.threadId !== undefined ? t.id === input.threadId
              : !input.unsettledOnly || (t.settledOverride !== "settled" && t.settledAt === null))
            .map((t) => ({ ...t, createdAt: DateTime.makeUnsafe(t.createdAt), updatedAt: DateTime.makeUnsafe(t.updatedAt),
              settledAt: t.settledAt === null ? null : DateTime.makeUnsafe(t.settledAt) })),
        })),
        dispatch: (command) => Effect.sync(() => {
          commands.push(strip(command));
          threads = applyT3(threads, command, now);
          return { sequence: 6, storedEvents: [] };
        }),
        streamDomainEvents: Stream.fromQueue(events),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () => Effect.succeed([project]),
        getShell: () => Effect.succeed(Option.some(project)),
      }),
      Layer.mock(GitManager.GitManager)({
        branchPullRequest: ({ branch }, options) => Effect.sync(() => {
          if (!options?.freshGitState) lookups.push(branch);
          return c.detected[branch] ?? null;
        }),
        checkedOutPullRequest: ({ branch, url }) => Effect.succeed(c.checkedOut?.[branch] === url),
      }),
      Layer.mock(PullRequestService.PullRequestService)({
        summary: (ref) => Effect.suspend(() => {
          const answer = c.previous?.[ref.url];
          return answer ? Effect.succeed(answer) : Effect.fail(failureOf({ error: "missing" }, "summary"));
        }),
        notifyLinkedThreadsChanged: Effect.void,
      }),
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(identity),
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({ shouldRunOpportunisticWork: Effect.succeed(true) }),
      Layer.succeed(ServerActivation.ServerActivation, undefined),
      Layer.succeed(SecureRandom.SecureRandom, testCrypto),
      NodeServices.layer,
    );
    yield* Effect.gen(function* () {
      const service = yield* BranchService.make;
      const record = () => {
        out.push({ at: now, lookups: [...lookups].sort(), commands: sortCommands(commands) });
        lookups = [];
        commands = [];
      };
      yield* service.start();
      yield* Queue.take(sweeps);
      yield* service.drain;
      record();
      for (const s of c.steps) {
        if (s.thread) {
          yield* Queue.offer(events, { type: "checkpoint.captured", threadId: s.thread, payload: {} });
          yield* Queue.take(sweeps);
          yield* service.drain;
          record();
          continue;
        }
        for (let i = 0; i < s.minutes; i++) {
          now += MIN;
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(sweeps);
          yield* service.drain;
          record();
        }
      }
    }).pipe(Effect.provide(services));
  });
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(START);
      yield* program;
    }).pipe(
      Effect.scoped,
      Effect.provide(TestClock.layer()),
      // The services log skipped reads; the comparison is the output.
      Effect.provideService(References.MinimumLogLevel, "Error"),
    ),
  );
  return { steps: out, threads };
}

// ---- Compare -----------------------------------------------------------------------------

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => [k, canonical(value[k])]))
      : value;
const sortCommands = (commands) =>
  commands.map((c) => JSON.stringify(canonical(c))).sort().map((c) => JSON.parse(c));
// The shell fields both sides keep; T3's test threads carry DateTime values.
const threadView = (t) => ({ id: t.id, branchPullRequest: t.branchPullRequest ?? null,
  pullRequests: (t.pullRequests ?? []).map((l) => ({ ...l, linkedAt: l.source === "stack" ? "(sweep time)" : l.linkedAt })) });
const view = (answer) => ({
  steps: answer.steps.map((s) => ({ ...s, ...(s.reads ? { reads: [...s.reads].sort() } : {}),
    ...(s.lookups ? { lookups: [...s.lookups].sort() } : {}), commands: sortCommands(s.commands) })),
  threads: answer.threads.map(threadView),
});

const cases = [
  ...linkCases.map((c) => ({ kind: "links", start: START, ...c })),
  ...branchCases.map((c) => ({ kind: "branch", start: START, snapshotSequence: 5, project: {
    id: PROJECT, workspaceRoot: "/nonexistent/project", repository: "o/r" }, ...c })),
];
const expected = [];
for (const c of cases) expected.push(c.kind === "branch" ? await t3Branches(c) : await t3Links(c));
const result = NodeChildProcess.spawnSync(binary, [], {
  input: JSON.stringify(cases),
  env: sealedEnvTemp(),
  maxBuffer: 64 * 1024 * 1024,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  console.error(result.stderr.toString());
  throw new Error(`${binary} exited ${result.status}`);
}
const actual = JSON.parse(result.stdout.toString());
let failures = 0;
let steps = 0;
let commandCount = 0;
cases.forEach((c, index) => {
  const want = view(expected[index]);
  const got = view(actual[index]);
  steps += want.steps.length;
  commandCount += want.steps.reduce((n, s) => n + s.commands.length, 0);
  const w = JSON.stringify(canonical(want));
  const g = JSON.stringify(canonical(got));
  if (w !== g) {
    failures += 1;
    console.error(`case ${index} (${c.kind}: ${c.name}) differs\n  T3:   ${w}\n  ours: ${g}`);
  }
});

// ---- The client-activity gate --------------------------------------------------------------

const report = (extra = {}) => ({
  clientId: "web-1", clientKind: "web", visible: true, focused: true, recentlyInteracted: false,
  scopes: [], ...extra,
});
const custom = (baseProfile, overrides = {}) => ({
  backgroundActivity: { schemaVersion: 1, profile: "custom", ...(baseProfile ? { baseProfile } : {}), overrides },
});
const lowPower = report({ lowPowerMode: "true" });
const gateCases = [
  { settings: {}, reports: [] },
  { settings: {}, reports: [report()] },
  { settings: {}, reports: [report({ focused: false })] },
  { settings: {}, reports: [report({ focused: false, recentlyInteracted: true })] },
  { settings: {}, reports: [report({ visible: false })] },
  { settings: {}, reports: [lowPower] },
  { settings: {}, reports: [report({ lowPowerMode: "false" })] },
  { settings: {}, reports: [report({ lowPowerMode: "unknown" })] },
  { settings: { backgroundActivity: { schemaVersion: 1, profile: "performance", overrides: {} } }, reports: [lowPower] },
  { settings: { backgroundActivity: { schemaVersion: 1, profile: "battery-saver", overrides: {} } }, reports: [lowPower] },
  { settings: { backgroundActivity: { schemaVersion: 1, profile: "battery-saver", overrides: {} } }, reports: [report()] },
  { settings: custom("performance"), reports: [lowPower] },
  { settings: custom("battery-saver"), reports: [lowPower] },
  { settings: custom(undefined), reports: [lowPower] },
  { settings: custom("balanced", { pauseWhenClientLowPower: false }), reports: [lowPower] },
  { settings: custom("performance", { pauseWhenClientLowPower: true }), reports: [lowPower] },
  { settings: { backgroundActivityProfile: "performance" }, reports: [lowPower] },
  { settings: { backgroundActivityProfile: "battery-saver" }, reports: [lowPower] },
  { settings: { backgroundActivityProfile: "performance", backgroundActivity: { schemaVersion: 1, profile: "battery-saver", overrides: {} } }, reports: [lowPower] },
  { settings: {}, reports: [lowPower, report({ clientId: "web-2" })] },
  { settings: {}, reports: [report(), report({ visible: false })] },
];
const decodeSettings = Schema.decodeUnknownSync(Schema.toCodecJson(Contracts.ServerSettings));
const t3Gate = (c) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const policy = yield* BackgroundPolicy.make();
      for (const r of c.reports) yield* policy.reportClientActivity("session-1", "rpc-1", r);
      return yield* policy.shouldRunOpportunisticWork;
    }).pipe(
      Effect.provide(Layer.mergeAll(
        Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make()),
        Layer.mock(ServerSettings.ServerSettingsService)({ getSettings: Effect.succeed(decodeSettings(c.settings)) }),
      )),
      Effect.scoped,
    ),
  );
const gateExpected = [];
for (const c of gateCases) gateExpected.push(await t3Gate(c));
const gate = NodeChildProcess.spawnSync(gateBinary, [], {
  input: JSON.stringify(gateCases), env: sealedEnvTemp(), maxBuffer: 1024 * 1024,
});
if (gate.error) throw gate.error;
if (gate.status !== 0) throw new Error(`${gateBinary} exited ${gate.status}: ${gate.stderr}`);
const gateActual = JSON.parse(gate.stdout.toString());
gateCases.forEach((c, index) => {
  if (gateExpected[index] !== gateActual[index]) {
    failures += 1;
    console.error(`gate case ${index} differs: T3 ${gateExpected[index]}, ours ${gateActual[index]}: ${JSON.stringify(c)}`);
  }
});
if (!gateExpected.includes(true) || !gateExpected.includes(false)) {
  failures += 1;
  console.error("gate cases must cover both answers");
}

if (failures > 0) {
  console.error(`pr-link-sync-diff: ${failures} of ${cases.length + gateCases.length} cases differ`);
  process.exit(1);
}
console.log(`pr-link-sync-diff: ${cases.length} cases (${steps} sweeps, ${commandCount} commands) and ${gateCases.length} activity gate cases agree with T3`);
