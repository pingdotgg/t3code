import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import {
  PRS_LIST_LIMIT,
  applyPrsDiffStreamEvent,
  binaryPathsFromPatch,
  changeTypeLabel,
  collectPrsDiffStream,
  createPrsDiffAssembly,
  displayPath,
  fileRows,
  fileStatLabel,
  formatRelativeTime,
  mergePrsDiffSegment,
  mergePrsEntries,
  prsActorLabel,
  prsChecksLabel,
  prsChecksSummary,
  prsDraftKey,
  prsGate,
  prsListHasMore,
  prsListInput,
  prsMergeabilityLabel,
  prsOmittedFilesLabel,
  prsProviderLabel,
  prsRefKey,
  prsRefreshClosedLabel,
  prsReviewLabel,
  prsReviewVerdict,
  prsReviewVerdictLabel,
  prsRowMeta,
  prsStackLabel,
  prsStateLabel,
  prsThreadAnchor,
  prsThreadMoreLabel,
  prsThreadStateLabel,
  prsUnavailableLabel,
  prsWriteActionLabel,
  prsWriteActionOffers,
  prsWriteGate,
  prsWriteUnavailableNote,
  prsWriteVerdictOptions,
  renderableFromPatch,
  resolveDiffPath,
  settlePrsDraft,
  verifyPrsDiffAssembly,
} from "./prsViewModel.ts";

const sha256Hex = async (text) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
const utf8Length = (text) => new TextEncoder().encode(text).length;

const operations = (supported = true) => ({
  "prs.list": supported,
  "prs.listStats": supported,
  "prs.summary": supported,
  "prs.detail": supported,
  "prs.activity": supported,
  "prs.threadComments": supported,
  "prs.linkedThreads": supported,
  "prs.stack": supported,
  "prs.reviewerCandidates": supported,
  "prs.labelCandidates": supported,
  "prs.invalidate": supported,
  "prs.streamDiff": supported,
  "prs.streamDiffFileContents": supported,
  "prs.subscribeRefreshes": supported,
});

const caps = (overrides = {}) => ({
  hosted: true,
  reason: null,
  detail: null,
  providers: [
    {
      host: "github.com",
      kind: "github",
      searchesOnHost: true,
      projectCount: 1,
      configured: true,
      detail: null,
    },
  ],
  operations: operations(),
  ...overrides,
});

const entry = (overrides = {}) => ({
  provider: "github",
  host: "github.com",
  projectId: "p1",
  projectTitle: "Project",
  repository: "pingdotgg/t3code",
  number: 42,
  title: "Add the thing",
  url: "https://github.com/pingdotgg/t3code/pull/42",
  author: { login: "octocat", name: null, avatarUrl: null },
  headBranch: "feat/thing",
  baseBranch: "main",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 10,
  deletions: 2,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  viewerReviewRequested: false,
  labels: [],
  ...overrides,
});

NodeTest.test("prsGate: loading before the probe answers", () => {
  NodeAssert.deepEqual(prsGate(null, null), { kind: "loading" });
});

NodeTest.test("prsGate: an invoke failure is an error, never an empty list", () => {
  const gate = prsGate(null, "capability denied: t3.prs/read");
  NodeAssert.equal(gate.kind, "error");
  NodeAssert.match(gate.detail, /t3\.prs\/read/);
});

NodeTest.test("prsGate: ready only when hosted with no reason", () => {
  const gate = prsGate(caps(), null);
  NodeAssert.equal(gate.kind, "ready");
  NodeAssert.equal(gate.operations["prs.streamDiff"], true);
});

NodeTest.test("prsGate: named unavailable states carry the contract reason", () => {
  for (const reason of ["cli-missing", "cli-unauthenticated", "provider-unsupported"]) {
    const gate = prsGate(caps({ reason, detail: `because ${reason}` }), null);
    NodeAssert.equal(gate.kind, "unavailable");
    NodeAssert.equal(gate.reason, reason);
    NodeAssert.equal(gate.detail, `because ${reason}`);
    NodeAssert.ok(prsUnavailableLabel(reason).length > 0);
  }
});

NodeTest.test("prsGate: an unhosted project names provider-unsupported", () => {
  const gate = prsGate(caps({ hosted: false, providers: [] }), null);
  NodeAssert.equal(gate.kind, "unavailable");
  NodeAssert.equal(gate.reason, "provider-unsupported");
});

NodeTest.test("prsProviderLabel names host, kind, and configuration", () => {
  NodeAssert.equal(
    prsProviderLabel({
      host: "github.com",
      kind: "github",
      searchesOnHost: true,
      projectCount: 2,
      configured: true,
      detail: null,
    }),
    "github.com · github · configured",
  );
  NodeAssert.match(
    prsProviderLabel({
      host: "dev.azure.com",
      kind: "azure-devops",
      searchesOnHost: false,
      projectCount: 1,
      configured: false,
      detail: "no token configured",
    }),
    /dev\.azure\.com · azure-devops · not configured — no token configured/,
  );
});

NodeTest.test("prsListInput: trims query, omits empties, passes cursors verbatim", () => {
  NodeAssert.deepEqual(prsListInput("open", "all", "   "), {
    state: "open",
    involvement: "all",
    limit: PRS_LIST_LIMIT,
  });
  NodeAssert.deepEqual(prsListInput("merged", "authored", "  fix crash  "), {
    state: "merged",
    involvement: "authored",
    limit: PRS_LIST_LIMIT,
    query: "fix crash",
  });
  const cursors = { p1: "abc" };
  NodeAssert.deepEqual(prsListInput("all", "reviewing", "", cursors).cursors, cursors);
  NodeAssert.equal(prsListInput("all", "all", "", {}).cursors, undefined);
});

NodeTest.test("prsRefKey: host + repository + number, stable and distinct", () => {
  const a = prsRefKey({ host: "github.com", repository: "o/r", number: 1 });
  NodeAssert.equal(a, prsRefKey({ host: "github.com", repository: "o/r", number: 1 }));
  NodeAssert.notEqual(a, prsRefKey({ repository: "o/r", number: 1 }));
  NodeAssert.notEqual(a, prsRefKey({ host: "github.com", repository: "o/r", number: 2 }));
  NodeAssert.notEqual(
    prsRefKey({ host: "gitlab.com", repository: "o/r", number: 1 }),
    prsRefKey({ host: "github.com", repository: "o/r", number: 1 }),
  );
});

NodeTest.test("mergePrsEntries: re-reads replace in place, pages append", () => {
  const first = [entry({ number: 1 }), entry({ number: 2 })];
  const reread = mergePrsEntries(first, [entry({ number: 2, title: "Renamed" })]);
  NodeAssert.equal(reread.length, 2);
  NodeAssert.equal(reread[1].title, "Renamed");
  const paged = mergePrsEntries(reread, [entry({ number: 3 }), entry({ number: 1, title: "T1" })]);
  NodeAssert.deepEqual(
    paged.map((e) => e.number),
    [1, 2, 3],
  );
  NodeAssert.equal(paged[0].title, "T1");
});

NodeTest.test("prsListHasMore follows nextCursors", () => {
  const result = {
    viewers: {},
    providers: [],
    entries: [],
    errors: [],
    truncated: false,
    nextCursors: {},
  };
  NodeAssert.equal(prsListHasMore(null), false);
  NodeAssert.equal(prsListHasMore(result), false);
  NodeAssert.equal(prsListHasMore({ ...result, nextCursors: { p1: "c" } }), true);
});

NodeTest.test("prsStateLabel: draft is a first-class open state", () => {
  NodeAssert.equal(prsStateLabel(entry()), "Open");
  NodeAssert.equal(prsStateLabel(entry({ isDraft: true })), "Draft");
  NodeAssert.equal(prsStateLabel(entry({ state: "merged" })), "Merged");
  NodeAssert.equal(prsStateLabel(entry({ state: "closed" })), "Closed");
});

NodeTest.test("row badges: review, checks, stack, meta", () => {
  NodeAssert.equal(prsReviewLabel("approved"), "Approved");
  NodeAssert.equal(prsReviewLabel("changes-requested"), "Changes requested");
  NodeAssert.equal(prsReviewLabel(undefined), null);
  NodeAssert.equal(prsChecksLabel("passing"), "Checks passing");
  NodeAssert.equal(prsChecksLabel(undefined), null);
  NodeAssert.equal(
    prsStackLabel({ number: 7, position: 2, size: 4, base: "main" }),
    "Stack 2/4 · main",
  );
  NodeAssert.equal(prsStackLabel(undefined), null);
  const meta = prsRowMeta(entry(), Date.parse("2026-01-02T01:00:00.000Z"));
  NodeAssert.match(meta, /pingdotgg\/t3code#42/);
  NodeAssert.match(meta, /octocat/);
  NodeAssert.match(meta, /\+10 −2/);
  NodeAssert.match(meta, /1h ago/);
});

NodeTest.test("formatRelativeTime: bounded recency then a date", () => {
  const now = Date.parse("2026-03-01T12:00:00.000Z");
  NodeAssert.equal(formatRelativeTime("2026-03-01T11:59:40.000Z", now), "just now");
  NodeAssert.equal(formatRelativeTime("2026-03-01T11:30:00.000Z", now), "30m ago");
  NodeAssert.equal(formatRelativeTime("2026-03-01T03:00:00.000Z", now), "9h ago");
  NodeAssert.equal(formatRelativeTime("2026-02-20T12:00:00.000Z", now), "9d ago");
  NodeAssert.match(formatRelativeTime("2025-01-01T00:00:00.000Z", now), /2025/);
  NodeAssert.equal(formatRelativeTime("not-a-date", now), "not-a-date");
});

NodeTest.test("detail projections: mergeability, checks, actors, threads", () => {
  NodeAssert.equal(prsMergeabilityLabel("conflicting"), "Has conflicts");
  NodeAssert.equal(prsMergeabilityLabel(undefined), "Mergeability unknown");
  NodeAssert.equal(prsChecksSummary([]), null);
  NodeAssert.equal(
    prsChecksSummary([
      { name: "a", status: "success", description: null, url: null },
      { name: "b", status: "success", description: null, url: null },
      { name: "c", status: "failure", description: null, url: null },
      { name: "d", status: "pending", description: null, url: null },
    ]),
    "2 passing · 1 failing · 1 pending",
  );
  NodeAssert.equal(
    prsActorLabel({ login: "octocat", name: "The Octocat", avatarUrl: null }),
    "The Octocat",
  );
  NodeAssert.equal(prsActorLabel({ login: "octocat", name: null, avatarUrl: null }), "octocat");
  NodeAssert.equal(prsActorLabel(null), "unknown");
  const thread = {
    id: "t1",
    path: "src/a.ts",
    line: 12,
    side: "right",
    isResolved: false,
    isOutdated: true,
    comments: [],
    commentCount: 5,
    nextCommentsCursor: "cur",
  };
  NodeAssert.equal(prsThreadAnchor(thread), "src/a.ts:12");
  NodeAssert.equal(prsThreadAnchor({ ...thread, side: "left" }), "src/a.ts:12 (removed side)");
  NodeAssert.equal(prsThreadAnchor({ ...thread, line: null }), "src/a.ts");
  NodeAssert.equal(prsThreadStateLabel(thread), "Outdated");
  NodeAssert.equal(prsThreadStateLabel({ ...thread, isResolved: true }), "Resolved");
  NodeAssert.equal(prsThreadMoreLabel(thread), "Show 5 more comments");
  NodeAssert.equal(prsThreadMoreLabel({ ...thread, nextCommentsCursor: undefined }), null);
  NodeAssert.equal(prsReviewVerdictLabel("CHANGES_REQUESTED"), "requested changes");
  NodeAssert.equal(prsReviewVerdictLabel(null), null);
});

NodeTest.test("prsRefreshClosedLabel names each close reason", () => {
  NodeAssert.match(prsRefreshClosedLabel("overflow"), /overflow/i);
  NodeAssert.match(prsRefreshClosedLabel("refresh-error"), /failed/i);
});

/* ---------------- streamDiff fold + verify ---------------- */

const manifestFor = async (patch, overrides = {}) => ({
  kind: "manifest",
  repository: "pingdotgg/t3code",
  number: 42,
  host: "github.com",
  diffHash: await sha256Hex(patch),
  diffByteLength: utf8Length(patch),
  chunkCount: 0,
  truncated: false,
  nextCursor: null,
  ...overrides,
});

const streamOf = async function* (events) {
  for (const event of events) yield { value: event };
};

NodeTest.test("collectPrsDiffStream: verified patch over ordered chunks", async () => {
  const patch = "diff --git a/x b/x\n+1\n";
  const manifest = await manifestFor(patch, { chunkCount: 2 });
  const events = [
    manifest,
    { kind: "chunk", chunkIndex: 0, data: patch.slice(0, 10) },
    { kind: "chunk", chunkIndex: 1, data: patch.slice(10) },
    { kind: "complete", payloadSha256: manifest.diffHash },
  ];
  const result = await collectPrsDiffStream(streamOf(events), new AbortController().signal);
  NodeAssert.equal(result.kind, "verified");
  NodeAssert.equal(result.patch, patch);
  NodeAssert.equal(result.manifest.truncated, false);
});

NodeTest.test("collectPrsDiffStream: out-of-order chunks are a protocol error", async () => {
  const manifest = await manifestFor("abcdef", { chunkCount: 2 });
  const events = [
    manifest,
    { kind: "chunk", chunkIndex: 1, data: "def" },
    { kind: "complete", payloadSha256: await sha256Hex("abcdef") },
  ];
  const result = await collectPrsDiffStream(streamOf(events), new AbortController().signal);
  NodeAssert.equal(result.kind, "protocol");
  NodeAssert.match(result.detail, /out-of-order chunk 1/);
});

NodeTest.test("applyPrsDiffStreamEvent: strict ordering rules", async () => {
  const manifest = await manifestFor("x", { chunkCount: 1 });
  let assembly = createPrsDiffAssembly();
  const early = applyPrsDiffStreamEvent(assembly, { kind: "chunk", chunkIndex: 0, data: "x" });
  NodeAssert.equal(early.ok, false);
  NodeAssert.match(early.detail, /before the manifest/);

  assembly = applyPrsDiffStreamEvent(assembly, manifest).assembly;
  const duplicate = applyPrsDiffStreamEvent(assembly, manifest);
  NodeAssert.equal(duplicate.ok, false);
  NodeAssert.match(duplicate.detail, /duplicate manifest/);

  const over = applyPrsDiffStreamEvent(assembly, { kind: "chunk", chunkIndex: 5, data: "y" });
  NodeAssert.equal(over.ok, false);
  NodeAssert.match(over.detail, /exceeds declared chunkCount/);

  assembly = applyPrsDiffStreamEvent(assembly, {
    kind: "chunk",
    chunkIndex: 0,
    data: "x",
  }).assembly;
  assembly = applyPrsDiffStreamEvent(assembly, {
    kind: "complete",
    payloadSha256: await sha256Hex("x"),
  }).assembly;
  const late = applyPrsDiffStreamEvent(assembly, { kind: "chunk", chunkIndex: 1, data: "z" });
  NodeAssert.equal(late.ok, false);
  NodeAssert.match(late.detail, /after the complete frame/);
});

NodeTest.test("verifyPrsDiffAssembly: hash and length mismatches produce nothing", async () => {
  const patch = "real patch bytes";
  const good = {
    manifest: await manifestFor(patch, { chunkCount: 1 }),
    chunks: [patch],
    complete: await sha256Hex(patch),
  };
  const verified = await verifyPrsDiffAssembly(good);
  NodeAssert.equal(verified.kind, "verified");

  const tampered = await verifyPrsDiffAssembly({ ...good, chunks: ["forged"] });
  NodeAssert.equal(tampered.kind, "mismatch");

  const missing = await verifyPrsDiffAssembly({ ...good, chunks: [] });
  NodeAssert.equal(missing.kind, "incomplete");
  NodeAssert.match(missing.detail, /0 of 1 declared chunks/);

  const noComplete = await verifyPrsDiffAssembly({ ...good, complete: null });
  NodeAssert.equal(noComplete.kind, "incomplete");
  NodeAssert.match(noComplete.detail, /complete frame/);

  const noManifest = await verifyPrsDiffAssembly(createPrsDiffAssembly());
  NodeAssert.equal(noManifest.kind, "incomplete");

  const wrongTerminal = await verifyPrsDiffAssembly({
    ...good,
    complete: await sha256Hex("something else"),
  });
  NodeAssert.equal(wrongTerminal.kind, "mismatch");
  NodeAssert.match(wrongTerminal.detail, /terminal checksum/);
});

NodeTest.test("collectPrsDiffStream: abort mid-stream is cancelled, not a failure", async () => {
  const controller = new AbortController();
  const manifest = await manifestFor("x", { chunkCount: 2 });
  const events = [
    manifest,
    { kind: "chunk", chunkIndex: 0, data: "x" },
    { kind: "chunk", chunkIndex: 1, data: "y" },
    { kind: "complete", payloadSha256: await sha256Hex("xy") },
  ];
  const stream = (async function* () {
    for (const event of events) {
      yield { value: event };
      controller.abort();
    }
  })();
  const result = await collectPrsDiffStream(stream, controller.signal);
  NodeAssert.equal(result.kind, "cancelled");
});

NodeTest.test(
  "mergePrsDiffSegment: verified segments concatenate, flags track the latest",
  async () => {
    const first = await manifestFor("aaa", { chunkCount: 1, truncated: true, nextCursor: "c1" });
    const second = await manifestFor("bbb", {
      chunkCount: 1,
      omittedFileStats: [{ path: "big.bin", additions: 0, deletions: 0 }],
    });
    let delivery = mergePrsDiffSegment(null, first, "aaa");
    NodeAssert.equal(delivery.truncated, true);
    NodeAssert.equal(delivery.nextCursor, "c1");
    delivery = mergePrsDiffSegment(delivery, second, "bbb");
    NodeAssert.equal(delivery.patch, "aaabbb");
    NodeAssert.equal(delivery.byteLength, 6);
    NodeAssert.equal(delivery.diffHashes.length, 2);
    NodeAssert.equal(delivery.truncated, false);
    NodeAssert.equal(delivery.nextCursor, null);
    NodeAssert.equal(delivery.omittedFileStats.length, 1);
    NodeAssert.match(prsOmittedFilesLabel(delivery.omittedFileStats), /1 file omitted/);
    NodeAssert.equal(prsOmittedFilesLabel([]), "");
  },
);

/* ---------------- patch → renderable ---------------- */

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " line one",
  "-line two",
  "+line 2",
  " line three",
  "+line four",
  "diff --git a/bin/logo.png b/bin/logo.png",
  "index 3333333..4444444 100644",
  "Binary files a/bin/logo.png and b/bin/logo.png differ",
  "",
].join("\n");

NodeTest.test("renderableFromPatch: files for a real patch, honest raw fallback otherwise", () => {
  const renderable = renderableFromPatch(PATCH);
  NodeAssert.equal(renderable.kind, "files");
  NodeAssert.equal(renderable.files.length, 2);
  const [source, binary] = renderable.files;
  NodeAssert.equal(source.path, "src/a.ts");
  NodeAssert.equal(source.changeType, "change");
  NodeAssert.equal(source.additions, 2);
  NodeAssert.equal(source.deletions, 1);
  NodeAssert.equal(binary.binary, true);
  NodeAssert.equal(binary.path, "bin/logo.png");
  NodeAssert.equal(fileStatLabel(binary), "");
  NodeAssert.match(fileStatLabel(source), /^\+2 −1$/);

  NodeAssert.equal(renderableFromPatch(""), null);
  NodeAssert.equal(renderableFromPatch(null), null);
  const raw = renderableFromPatch("not a patch at all");
  NodeAssert.equal(raw.kind, "raw");
  NodeAssert.match(raw.reason, /Unsupported diff format/);
});

NodeTest.test("binaryPathsFromPatch names only literal binary markers", () => {
  const paths = binaryPathsFromPatch(PATCH);
  NodeAssert.ok(paths.has("bin/logo.png"));
  NodeAssert.ok(!paths.has("src/a.ts"));
});

NodeTest.test("fileRows renders patch-faithful context, additions, deletions", () => {
  const renderable = renderableFromPatch(PATCH);
  const row = renderable.files[0];
  const rows = fileRows(row);
  NodeAssert.deepEqual(
    rows.map((r) => r.kind),
    ["context", "deletion", "addition", "context", "addition"],
  );
  NodeAssert.equal(rows[1].text, "line two");
  NodeAssert.equal(rows[1].oldLine, 2);
  NodeAssert.equal(rows[2].text, "line 2");
  NodeAssert.equal(rows[2].newLine, 2);
  NodeAssert.equal(rows[4].newLine, 4);
});

NodeTest.test("fileRows names elided regions as gap rows", () => {
  const renderable = renderableFromPatch(PATCH);
  const source = renderable.files[0];
  const gapped = {
    ...source,
    file: {
      ...source.file,
      hunks: [{ ...source.file.hunks[0], collapsedBefore: 40 }],
    },
  };
  const rows = fileRows(gapped);
  NodeAssert.equal(rows[0].kind, "gap");
  NodeAssert.equal(rows[0].count, 40);
});

NodeTest.test("paths and labels: prefixes stripped, renames shown, change types named", () => {
  NodeAssert.equal(resolveDiffPath("a/src/x.ts"), "src/x.ts");
  NodeAssert.equal(resolveDiffPath("src/x.ts"), "src/x.ts");
  NodeAssert.equal(changeTypeLabel("rename-changed"), "renamed, modified");
  NodeAssert.equal(changeTypeLabel("new"), "added");
  const rename = { prevPath: "old.ts", path: "new.ts" };
  NodeAssert.equal(displayPath(rename), "old.ts → new.ts");
  NodeAssert.equal(displayPath({ prevPath: null, path: "new.ts" }), "new.ts");
});

/* ---------------- writes (t3.prs/write) ---------------- */

const ALL_ACTIONS = [
  "merge",
  "ready",
  "draft",
  "close",
  "reopen",
  "update-branch",
  "enable-auto-merge",
  "disable-auto-merge",
  "revert",
  "approve-workflows",
];

const writeCaps = (overrides = {}) => ({
  hosted: true,
  reason: null,
  detail: null,
  operations: {
    "prs.runAction": true,
    "prs.update": true,
    "prs.comment": true,
    "prs.updateComment": true,
    "prs.submitReview": true,
    "prs.replyToThread": true,
    "prs.setThreadResolution": true,
    "prs.setReaction": true,
    "prs.requestReviewers": true,
    "prs.setLabels": true,
  },
  actions: ALL_ACTIONS,
  mergeMethods: ["merge", "squash", "rebase"],
  updateMethods: ["merge", "rebase"],
  verdicts: ["comment", "approve", "request-changes"],
  ...overrides,
});

NodeTest.test("prsWriteGate: loading, error, unavailable, ready", () => {
  NodeAssert.deepEqual(prsWriteGate(null, null), { kind: "loading" });
  NodeAssert.deepEqual(prsWriteGate(null, "API capability denied: t3.prs/write"), {
    kind: "error",
    detail: "API capability denied: t3.prs/write",
  });
  const unhosted = prsWriteGate(
    writeCaps({ hosted: false, reason: "cli-missing", detail: "gh not found" }),
    null,
  );
  NodeAssert.deepEqual(unhosted, {
    kind: "unavailable",
    reason: "cli-missing",
    detail: "gh not found",
  });
  const ready = prsWriteGate(writeCaps(), null);
  NodeAssert.equal(ready.kind, "ready");
  NodeAssert.deepEqual(ready.actions, ALL_ACTIONS);
  NodeAssert.deepEqual(ready.verdicts, ["comment", "approve", "request-changes"]);
});

NodeTest.test("prsWriteActionOffers: state decides, host declares", () => {
  const write = {
    actions: ALL_ACTIONS,
    mergeMethods: ["merge", "squash", "rebase"],
    updateMethods: ["merge", "rebase"],
  };
  const open = prsWriteActionOffers(
    { state: "open", isDraft: false, baseComparison: "behind", autoMergeEnabled: false },
    write,
  ).map((offer) => offer.action);
  NodeAssert.deepEqual(open, ["merge", "draft", "update-branch", "enable-auto-merge", "close"]);
  const draft = prsWriteActionOffers({ state: "open", isDraft: true }, write).map(
    (offer) => offer.action,
  );
  NodeAssert.deepEqual(draft, ["ready", "close"]);
  NodeAssert.deepEqual(
    prsWriteActionOffers({ state: "closed", isDraft: false }, write).map((o) => o.action),
    ["reopen"],
  );
  NodeAssert.deepEqual(
    prsWriteActionOffers({ state: "merged", isDraft: false }, write).map((o) => o.action),
    ["revert"],
  );
  NodeAssert.deepEqual(
    prsWriteActionOffers(
      { state: "open", isDraft: false, workflowApprovalsRequired: 2 },
      write,
    ).map((o) => o.action),
    ["merge", "draft", "close", "approve-workflows"],
  );
  // A host that declares nothing offers nothing — never a dead button.
  NodeAssert.deepEqual(
    prsWriteActionOffers(
      { state: "open", isDraft: false },
      {
        actions: [],
        mergeMethods: [],
        updateMethods: [],
      },
    ),
    [],
  );
  // The host's declared list wins over what state alone would suggest.
  NodeAssert.deepEqual(
    prsWriteActionOffers(
      { state: "open", isDraft: false },
      { actions: ["close"], mergeMethods: [], updateMethods: [] },
    ).map((o) => o.action),
    ["close"],
  );
});

NodeTest.test("prsWriteActionOffers: merge carries the declared methods", () => {
  const [merge] = prsWriteActionOffers(
    { state: "open", isDraft: false },
    { actions: ["merge"], mergeMethods: ["squash"], updateMethods: [] },
  );
  NodeAssert.deepEqual(merge.methods, ["squash"]);
});

NodeTest.test("prsWriteVerdictOptions: only declared verdicts, native order", () => {
  NodeAssert.deepEqual(
    prsWriteVerdictOptions(["comment", "approve", "request-changes"]).map((o) => o.value),
    ["comment", "approve", "request-changes"],
  );
  NodeAssert.deepEqual(
    prsWriteVerdictOptions(["approve"]).map((o) => o.value),
    ["approve"],
  );
  NodeAssert.deepEqual(prsWriteVerdictOptions([]), []);
});

NodeTest.test("prsWriteActionLabel and prsWriteUnavailableNote name the states", () => {
  NodeAssert.equal(prsWriteActionLabel("merge"), "Merge");
  NodeAssert.equal(prsWriteActionLabel("reopen"), "Reopen");
  NodeAssert.equal(prsWriteUnavailableNote({ kind: "ready" }), null);
  NodeAssert.match(
    prsWriteUnavailableNote({ kind: "error", detail: "API capability denied: t3.prs/write" }),
    /denied/,
  );
  NodeAssert.match(
    prsWriteUnavailableNote({ kind: "unavailable", reason: "cli-missing", detail: null }),
    /CLI/,
  );
});

NodeTest.test("prsDraftKey scopes a draft to its PR and composer", () => {
  NodeAssert.equal(prsDraftKey("github:o/r#1", "comment"), "github:o/r#1\ncomment");
  NodeAssert.notEqual(prsDraftKey("github:o/r#1", "review"), prsDraftKey("github:o/r#2", "review"));
  NodeAssert.equal(prsDraftKey(null, "comment"), "-\ncomment");
});

NodeTest.test("settlePrsDraft clears only the submitted version", () => {
  const drafts = {
    "pr1\ncomment": "posted comment",
    "pr1\nreview": "half-written review",
    "pr1\nreply:t7": "reply draft",
  };
  // A successful comment write drops ITS draft and leaves the rest —
  // this is the state a refresh reprobe must not have destroyed.
  const settled = settlePrsDraft(drafts, "pr1\ncomment", "posted comment");
  NodeAssert.deepEqual(settled, {
    "pr1\nreview": "half-written review",
    "pr1\nreply:t7": "reply draft",
  });
  // Edits typed while the request was in flight are newer work — the
  // success must not discard them.
  const edited = { ...drafts, "pr1\ncomment": "posted comment — and more" };
  NodeAssert.equal(settlePrsDraft(edited, "pr1\ncomment", "posted comment"), edited);
  // A failed or unrelated write never clears anything.
  NodeAssert.equal(settlePrsDraft(drafts, "pr1\ncomment", "different text"), drafts);
});

NodeTest.test("prsReviewVerdict keeps a stored pick across remounts", () => {
  const options = prsWriteVerdictOptions(["comment", "approve", "request-changes"]);
  // A "Request changes" pick survives the remount a refresh causes —
  // the bug this guards was a silent downgrade back to "comment".
  NodeAssert.equal(prsReviewVerdict("request-changes", options), "request-changes");
  // An unset draft defaults to the first declared option.
  NodeAssert.equal(prsReviewVerdict("", options), "comment");
  // A draft the host no longer declares can't come back through it.
  const approveOnly = prsWriteVerdictOptions(["approve"]);
  NodeAssert.equal(prsReviewVerdict("request-changes", approveOnly), "approve");
  NodeAssert.equal(prsReviewVerdict("", []), "comment");
});
