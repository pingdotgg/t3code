import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeTest from "node:test";
import { copyJson } from "@t3tools/extension-sdk/contracts";
import server from "./server.ts";
import {
  applyResourceReadEvent,
  collectResourceRead,
  compareTreeEntries,
  contentMatchSegments,
  createResourceReadAssembly,
  describeContentSearch,
  describeFileOpen,
  describeMediaLease,
  describePresentation,
  describeResourcePreview,
  describeResourceRead,
  describeRead,
  describeSaveState,
  describeSearch,
  describeSnapshot,
  editorSavePending,
  fileOpenFailed,
  filterEntries,
  isMarkdownPath,
  leasePreviewMode,
  MEDIA_LEASE_RENEWAL_SKEW_MS,
  mediaLeaseAssetFailed,
  mediaLeaseErrorState,
  mediaLeaseExpire,
  mediaLeaseFailed,
  mediaLeaseKindGate,
  MEDIA_LEASE_MIN_RENEWAL_DELAY_MS,
  mediaLeaseMinted,
  mediaLeaseRenewalDelay,
  mediaLeaseRenewing,
  mediaLeaseUrl,
  mediaPreviewNotice,
  parentPath,
  presentationPath,
  filesViewState,
  isFilesViewState,
  MAX_PERSISTED_EXPANDED,
  MAX_PERSISTED_EXPANDED_BYTES,
  restoredExpanded,
  restoredRenderMarkdown,
  restoredSelection,
  previewKind,
  selectMediaLease,
  sha256HexPortable,
  shouldHandleMutation,
  sortTreeEntries,
  toggleExpanded,
  visibleRows,
} from "./viewModel.ts";

const fixture = [
  { path: "src/lib", kind: "directory" },
  { path: "README.md", kind: "file" },
  { path: "src", kind: "directory" },
  { path: "src/lib/deep.ts", kind: "file" },
  { path: "src/app.ts", kind: "file" },
  { path: "docs", kind: "directory" },
  { path: "docs/guide.md", kind: "file" },
];

NodeTest.describe("files view model", () => {
  NodeTest.it("sorts directories before files within the same parent", () => {
    NodeAssert.deepEqual(
      sortTreeEntries([
        { path: "b.ts", kind: "file" },
        { path: "a", kind: "directory" },
        { path: "a.ts", kind: "file" },
      ]).map((entry) => entry.path),
      ["a", "a.ts", "b.ts"],
    );
    NodeAssert.ok(
      compareTreeEntries({ path: "z", kind: "directory" }, { path: "a", kind: "file" }) < 0,
    );
  });

  NodeTest.it("orders nested paths depth-first under their parent", () => {
    NodeAssert.deepEqual(
      sortTreeEntries(fixture).map((entry) => entry.path),
      ["docs", "docs/guide.md", "src", "src/lib", "src/lib/deep.ts", "src/app.ts", "README.md"],
    );
  });

  NodeTest.it("hides children of collapsed directories and reports depth", () => {
    const rows = visibleRows(fixture, new Set(["src"]));
    NodeAssert.deepEqual(
      rows.map((row) => [row.entry.path, row.depth]),
      [
        ["docs", 0],
        ["src", 0],
        ["src/lib", 1],
        ["src/app.ts", 1],
        ["README.md", 0],
      ],
    );
    NodeAssert.equal(rows.find((row) => row.entry.path === "src")?.expandable, true);
    NodeAssert.equal(rows.find((row) => row.entry.path === "README.md")?.expandable, false);
  });

  NodeTest.it("toggles expansion immutably", () => {
    const expanded = new Set(["src"]);
    const collapsed = toggleExpanded(expanded, "src");
    NodeAssert.equal(collapsed.has("src"), false);
    NodeAssert.equal(expanded.has("src"), true);
    NodeAssert.equal(toggleExpanded(expanded, "docs").has("docs"), true);
  });

  NodeTest.it("filter keeps matches plus ancestors and ignores expansion", () => {
    const keep = filterEntries(fixture, "deep");
    NodeAssert.deepEqual([...keep].sort(), ["src", "src/lib", "src/lib/deep.ts"]);
    const rows = visibleRows(fixture, new Set(), "DEEP");
    NodeAssert.deepEqual(
      rows.map((row) => row.entry.path),
      ["src", "src/lib", "src/lib/deep.ts"],
    );
  });

  NodeTest.it("parentPath climbs to the root", () => {
    NodeAssert.equal(parentPath("a/b/c.ts"), "a/b");
    NodeAssert.equal(parentPath("a"), null);
  });
});

NodeTest.describe("preview classification", () => {
  NodeTest.it("maps media extensions to media kinds, unknowns to text", () => {
    NodeAssert.equal(previewKind("src/app.ts"), "text");
    NodeAssert.equal(previewKind("README"), "text");
    NodeAssert.equal(previewKind(".gitignore"), "text");
    NodeAssert.equal(previewKind("docs/photo.PNG"), "image");
    NodeAssert.equal(previewKind("clip.mov"), "video");
    NodeAssert.equal(previewKind("song.MP3"), "audio");
    NodeAssert.equal(previewKind("font.woff2"), "font");
    NodeAssert.equal(previewKind("archive.tar.gz"), "binary");
    NodeAssert.equal(previewKind("module.wasm"), "binary");
    NodeAssert.equal(previewKind("data.unknownext"), "text");
  });
});

NodeTest.describe("describeRead", () => {
  NodeTest.it("reports a full read with the file byte length", () => {
    const described = describeRead({ contents: "hello\n", byteLength: 6, truncated: false });
    NodeAssert.equal(described.truncated, false);
    NodeAssert.equal(described.shownByteLength, 6);
    NodeAssert.equal(described.status, "File loaded — 6 bytes (read only)");
  });

  NodeTest.it("marks truncation honestly with shown vs true byte length", () => {
    const described = describeRead({
      contents: "a".repeat(48000),
      byteLength: 60_000,
      truncated: true,
    });
    NodeAssert.equal(described.truncated, true);
    NodeAssert.equal(described.shownByteLength, 48000);
    NodeAssert.equal(
      described.status,
      "File truncated — showing first 48,000 of 60,000 bytes (read only)",
    );
  });

  NodeTest.it("measures shown bytes in UTF-8, not chars", () => {
    const described = describeRead({ contents: "é".repeat(10), byteLength: 40, truncated: true });
    NodeAssert.equal(described.shownByteLength, 20);
    NodeAssert.match(described.status, /showing first 20 of 40 bytes/);
  });
});

NodeTest.describe("describeSearch", () => {
  NodeTest.it("is empty while the query is blank and pending before results land", () => {
    NodeAssert.equal(describeSearch(null, "  ", 100), "");
    NodeAssert.equal(describeSearch(null, "app", 100), "Searching for “app”");
  });

  NodeTest.it("reports no-match and exact-match states", () => {
    NodeAssert.equal(
      describeSearch({ entries: [], truncated: false }, "zzz", 100),
      "No matches for “zzz”",
    );
    NodeAssert.equal(
      describeSearch(
        { entries: [{ path: "src/app.ts", kind: "file" }], truncated: false },
        "app",
        100,
      ),
      "1 match for “app” (limit 100)",
    );
  });

  NodeTest.it("marks wire truncation honestly instead of claiming completeness", () => {
    const result = {
      entries: Array.from({ length: 100 }, (_, i) => ({
        path: `f${i}.ts`,
        kind: "file",
      })),
      truncated: true,
    };
    NodeAssert.equal(
      describeSearch(result, "f", 100),
      "100+ matches for “f” (limit 100) — showing first 100, refine the query",
    );
  });
});

NodeTest.describe("mediaPreviewNotice", () => {
  NodeTest.it("names the lease mint bound instead of faking a preview", () => {
    for (const kind of ["image", "video", "audio", "font", "binary"]) {
      NodeAssert.match(mediaPreviewNotice(kind), new RegExp(`^${kind} preview is not available`));
      NodeAssert.match(mediaPreviewNotice(kind), /does not mint this file type/);
    }
    // .bmp classifies as image but is outside the mintable set — the message
    // must not claim "images" are mintable wholesale.
    NodeAssert.match(mediaPreviewNotice("image"), /image preview is not available/);
  });
});

NodeTest.describe("media lease preview", () => {
  const minted = { url: "/api/assets/token/name.png", expiresAt: 4_000_000 };

  NodeTest.it("gates render mode by the host mint set, never fetch-and-hope", () => {
    for (const path of ["a.png", "dir/photo.JPG", "icon.svg", "x.webp", "y.avif", "z.ico"])
      NodeAssert.equal(leasePreviewMode(path), "image");
    NodeAssert.equal(leasePreviewMode("docs/spec.pdf"), "document");
    NodeAssert.equal(leasePreviewMode("docs/SPEC.PDF"), "document");
    // Mintable-by-the-host but intentionally not lease-previewed here:
    // browser documents stay on the text path (t3.browser's lane).
    NodeAssert.equal(leasePreviewMode("page.html"), null);
    for (const path of [
      "clip.mp4",
      "song.mp3",
      "font.woff2",
      "image.bmp",
      "archive.zip",
      "README.md",
    ])
      NodeAssert.equal(leasePreviewMode(path), null);
  });

  NodeTest.it("select: mintable kind + thread context mints; gaps are named", () => {
    NodeAssert.deepEqual(selectMediaLease({ path: "a.png", hasThread: true }), {
      status: "minting",
    });
    const unsupported = selectMediaLease({ path: "clip.mp4", hasThread: true });
    NodeAssert.equal(unsupported.status, "unsupported-kind");
    NodeAssert.match(unsupported.message, /video preview is not available/);
    const noThread = selectMediaLease({ path: "a.png", hasThread: false });
    NodeAssert.equal(noThread.status, "denied");
    NodeAssert.equal(noThread.reason, "context-missing");
  });

  NodeTest.it("capability gate: absent workspace-file kind is a named state", () => {
    NodeAssert.equal(mediaLeaseKindGate(["workspace-file", "project-favicon"]), null);
    const gated = mediaLeaseKindGate(["project-favicon"]);
    NodeAssert.equal(gated?.status, "unsupported-kind");
    NodeAssert.match(gated?.message ?? "", /cannot mint workspace-file leases/);
  });

  NodeTest.it("minted result lands ready with url and expiry", () => {
    NodeAssert.deepEqual(mediaLeaseMinted(minted), {
      status: "ready",
      url: minted.url,
      expiresAt: minted.expiresAt,
    });
  });

  NodeTest.it("every named mint denial maps to denied with its reason", () => {
    const cases = [
      ["ResourceLeaseGrantDeniedError: grant 't3.workspace/resources' is required", "grant-denied"],
      ["ResourceLeaseKindDeniedError: kind 'attachment'", "kind-denied"],
      ["AssetPreviewTypeValidationError: not previewable", "not-previewable"],
      ["AssetWorkspacePathValidationError: outside root", "outside-workspace"],
      ["AssetWorkspaceAssetNotFoundError: missing", "context-missing"],
      ["AssetWorkspaceContextNotFoundError: gone", "context-missing"],
      ["AssetWorkspaceContextResolutionError: db", "context-missing"],
      ["AssetWorkspaceRootNormalizationError: bad root", "context-missing"],
    ];
    for (const [detail, reason] of cases) {
      const state = mediaLeaseErrorState(new Error(detail));
      NodeAssert.equal(state.status, "denied", detail);
      NodeAssert.equal(state.reason, reason, detail);
      NodeAssert.ok(state.message.length > 0);
    }
  });

  NodeTest.it("unnamed and host-fault failures map to unavailable, not denied", () => {
    for (const detail of [
      "ResourceLeaseGrantCheckError: could not evaluate grant",
      "Resource lease authority is unavailable.",
      "socket hangup",
    ]) {
      const state = mediaLeaseErrorState(new Error(detail));
      NodeAssert.equal(state.status, "unavailable", detail);
    }
    NodeAssert.equal(mediaLeaseErrorState("boom").status, "unavailable");
    NodeAssert.equal(mediaLeaseErrorState(new Error("")).status, "unavailable");
  });

  NodeTest.it("renewal delay fires the skew before expiry and floors above zero", () => {
    NodeAssert.equal(
      mediaLeaseRenewalDelay(4_000_000, 1_000_000),
      4_000_000 - MEDIA_LEASE_RENEWAL_SKEW_MS - 1_000_000,
    );
    // A due-or-past renewal must still wait the floor — no tight mint loop.
    NodeAssert.equal(
      mediaLeaseRenewalDelay(4_000_000, 4_000_000 - MEDIA_LEASE_RENEWAL_SKEW_MS),
      MEDIA_LEASE_MIN_RENEWAL_DELAY_MS,
    );
    NodeAssert.equal(
      mediaLeaseRenewalDelay(4_000_000, 5_000_000),
      MEDIA_LEASE_MIN_RENEWAL_DELAY_MS,
    );
    NodeAssert.ok(MEDIA_LEASE_MIN_RENEWAL_DELAY_MS < MEDIA_LEASE_RENEWAL_SKEW_MS);
  });

  NodeTest.it("renewal keeps the live URL rendering while re-minting", () => {
    const ready = mediaLeaseMinted(minted);
    NodeAssert.deepEqual(mediaLeaseRenewing(ready), {
      status: "minting",
      url: minted.url,
      expiresAt: minted.expiresAt,
    });
    NodeAssert.equal(mediaLeaseRenewing({ status: "idle" }).status, "idle");
  });

  NodeTest.it("a failed renewal keeps the still-valid lease with the failure named", () => {
    const renewing = mediaLeaseRenewing(mediaLeaseMinted(minted));
    const next = mediaLeaseFailed(new Error("ResourceLeaseGrantDeniedError: revoked"), renewing);
    NodeAssert.equal(next.status, "ready");
    NodeAssert.equal(next.url, minted.url);
    NodeAssert.match(next.renewalError ?? "", /t3\.workspace\/resources grant/);
    // An initial mint has no lease to fall back to — the denial is the state.
    const initial = mediaLeaseFailed(new Error("ResourceLeaseGrantDeniedError: missing"), {
      status: "minting",
    });
    NodeAssert.equal(initial.status, "denied");
    NodeAssert.equal(initial.reason, "grant-denied");
  });

  NodeTest.it("asset load failure: pre-expiry names the origin gap, post-expiry is expired", () => {
    const ready = mediaLeaseMinted(minted);
    const early = mediaLeaseAssetFailed(ready, minted.expiresAt - 1);
    NodeAssert.equal(early.status, "unavailable");
    NodeAssert.match(early.message, /did not resolve on this origin/);
    NodeAssert.deepEqual(mediaLeaseAssetFailed(ready, minted.expiresAt), {
      status: "expired",
      url: minted.url,
    });
    NodeAssert.equal(mediaLeaseAssetFailed({ status: "idle" }, minted.expiresAt).status, "idle");
  });

  NodeTest.it("a live lease reaching its TTL goes expired; other states hold", () => {
    NodeAssert.deepEqual(mediaLeaseExpire(mediaLeaseMinted(minted)), {
      status: "expired",
      url: minted.url,
    });
    NodeAssert.equal(mediaLeaseExpire({ status: "minting" }).status, "minting");
    NodeAssert.equal(mediaLeaseExpire({ status: "idle" }).status, "idle");
  });

  NodeTest.it("only a live lease exposes a renderable URL", () => {
    NodeAssert.equal(mediaLeaseUrl(mediaLeaseMinted(minted)), minted.url);
    NodeAssert.equal(
      mediaLeaseUrl({ status: "minting", url: minted.url, expiresAt: minted.expiresAt }),
      minted.url,
    );
    NodeAssert.equal(mediaLeaseUrl({ status: "minting" }), null);
    NodeAssert.equal(mediaLeaseUrl({ status: "expired", url: minted.url }), null);
    NodeAssert.equal(
      mediaLeaseUrl({ status: "denied", reason: "grant-denied", message: "no" }),
      null,
    );
  });

  NodeTest.it("describes every state without relying on a broken element", () => {
    NodeAssert.equal(describeMediaLease({ status: "idle" }), "");
    NodeAssert.match(
      describeMediaLease({ status: "unsupported-kind", message: "named gap" }),
      /named gap/,
    );
    NodeAssert.match(describeMediaLease({ status: "minting" }), /minting a media lease/);
    NodeAssert.match(
      describeMediaLease({ status: "minting", url: minted.url, expiresAt: minted.expiresAt }),
      /renewing the media lease/,
    );
    NodeAssert.match(describeMediaLease(mediaLeaseMinted(minted)), /Preview ready/);
    NodeAssert.match(
      describeMediaLease({ status: "expired", url: minted.url }),
      /expired — renewing/,
    );
    NodeAssert.equal(
      describeMediaLease({ status: "denied", reason: "grant-denied", message: "denied note" }),
      "denied note",
    );
    NodeAssert.equal(
      describeMediaLease({ status: "unavailable", message: "unavailable note" }),
      "unavailable note",
    );
  });
});

NodeTest.describe("describeSnapshot", () => {
  NodeTest.it("opens editable snapshots with contents and revision", () => {
    NodeAssert.deepEqual(
      describeSnapshot({
        kind: "editable",
        contents: "hello\n",
        revision: "a".repeat(64),
      }),
      { editable: true, contents: "hello\n", revision: "a".repeat(64) },
    );
  });

  NodeTest.it(
    "names the 8 MiB workspace resource bound for oversized files — read-only, never silent truncation",
    () => {
      const open = describeSnapshot({ kind: "not-editable", reason: "oversized" });
      NodeAssert.equal(open.editable, false);
      NodeAssert.equal(open.reason, "oversized");
      NodeAssert.match(open.message, /8,388,608-byte workspace resource bound/);
      NodeAssert.match(open.message, /read only/);
    },
  );

  NodeTest.it("names binary and invalid-utf8 as read-only reasons", () => {
    NodeAssert.match(
      describeSnapshot({ kind: "not-editable", reason: "binary" }).message,
      /Binary file/,
    );
    NodeAssert.match(
      describeSnapshot({ kind: "not-editable", reason: "invalid-utf8" }).message,
      /not valid UTF-8/,
    );
  });
});

NodeTest.describe("describeSaveState", () => {
  NodeTest.it("labels every coordinator state", () => {
    NodeAssert.equal(describeSaveState({ kind: "clean" }), "No unsaved changes");
    NodeAssert.equal(describeSaveState({ kind: "dirty" }), "Unsaved changes");
    NodeAssert.equal(describeSaveState({ kind: "saving" }), "Saving");
    NodeAssert.equal(describeSaveState({ kind: "saved" }), "Saved");
    NodeAssert.match(describeSaveState({ kind: "conflict" }), /changed on disk/);
    NodeAssert.match(
      describeSaveState({ kind: "error", message: "io" }),
      /Save failed: io.*changes are kept/,
    );
  });
});

NodeTest.describe("contentMatchSegments", () => {
  NodeTest.it("splits a line into match and non-match segments", () => {
    NodeAssert.deepEqual(contentMatchSegments("foo bar foo", [{ start: 4, end: 7 }]), [
      { text: "foo ", match: false },
      { text: "bar", match: true },
      { text: " foo", match: false },
    ]);
  });

  NodeTest.it("returns the whole line unmatched when no ranges apply", () => {
    NodeAssert.deepEqual(contentMatchSegments("plain", []), [{ text: "plain", match: false }]);
  });

  NodeTest.it("clamps, sorts and merges out-of-bounds or overlapping ranges", () => {
    NodeAssert.deepEqual(
      contentMatchSegments("abcdef", [
        { start: 4, end: 99 },
        { start: 0, end: 2 },
        { start: 1, end: 3 },
        { start: 2, end: 2 },
        { start: -5, end: 1 },
      ]),
      [
        { text: "abc", match: true },
        { text: "d", match: false },
        { text: "ef", match: true },
      ],
    );
  });
});

NodeTest.describe("describeContentSearch", () => {
  const match = (path, lineNumber, extra = 0) => ({
    path,
    lineNumber,
    lineContent: "line",
    matchRanges: Array.from({ length: extra + 1 }, (_, i) => ({ start: i, end: i + 1 })),
  });

  NodeTest.it("reports pending, empty, success and truncated states", () => {
    NodeAssert.equal(describeContentSearch(null, "needle", 100), "Searching contents for “needle”");
    NodeAssert.equal(
      describeContentSearch({ matches: [], truncated: false }, "needle", 100),
      "No contents matches for “needle”",
    );
    NodeAssert.equal(
      describeContentSearch(
        { matches: [match("a.ts", 3), match("a.ts", 9), match("dir/b.ts", 1)], truncated: false },
        "needle",
        100,
      ),
      "3 matches in 2 files for “needle” (limit 100)",
    );
    NodeAssert.match(
      describeContentSearch({ matches: [match("a.ts", 1)], truncated: true }, "n", 100),
      /^1\+ matches in 1 file for “n” \(limit 100\) — showing first 1, refine the query$/,
    );
  });

  NodeTest.it("appends a regex fallback error verbatim", () => {
    NodeAssert.match(
      describeContentSearch(
        { matches: [match("a.ts", 1)], truncated: false, regexFallbackError: "regex unsupported" },
        "n",
        100,
      ),
      /— regex unsupported$/,
    );
  });
});

NodeTest.describe("open in presentation", () => {
  NodeTest.it("presentationPath rejects unsafe paths", () => {
    for (const bad of ["", "/abs/x", "a/../b", "a\\b", "a//b", ".."])
      NodeAssert.equal(presentationPath(bad), null, bad);
    NodeAssert.equal(presentationPath("src/a.ts"), "src/a.ts");
  });

  // The host's plain Files panel opens with an empty path; the restored view
  // must select nothing rather than read "" (a 400 from text-edits on mount).
  NodeTest.it("an empty-path open restores no selection", async () => {
    const open = server.apis[0].methods.find((method) => method.name === "open");
    const session = { signal: new AbortController().signal };
    const root = await open.invoke({ relativePath: "" }, session);
    NodeAssert.equal(restoredSelection(root.restoreState), null);
    const file = await open.invoke({ relativePath: "src/a.ts" }, session);
    NodeAssert.equal(restoredSelection(file.restoreState), "src/a.ts");
    for (const bad of [null, [], {}, { relativePath: 1 }])
      NodeAssert.equal(restoredSelection(bad), null);
  });

  NodeTest.it("view state round-trips selection, expansion and preview mode", () => {
    const saved = filesViewState("docs/guide.md", new Set(["src/lib", "docs", "src"]), true);
    NodeAssert.deepEqual(saved, {
      relativePath: "docs/guide.md",
      expanded: ["docs", "src", "src/lib"],
      renderMarkdown: true,
    });
    // What the host persists is JSON; restore reads the same record back.
    const restored = JSON.parse(JSON.stringify(saved));
    NodeAssert.equal(isFilesViewState(restored), true);
    NodeAssert.equal(restoredSelection(restored), "docs/guide.md");
    NodeAssert.deepEqual([...restoredExpanded(restored)], ["docs", "src", "src/lib"]);
    NodeAssert.equal(restoredRenderMarkdown(restored), true);
    // Expansion drives the rendered tree after restore.
    const paths = visibleRows(fixture, restoredExpanded(restored), "").map((row) => row.entry.path);
    NodeAssert.ok(paths.includes("src/lib/deep.ts"));
    NodeAssert.ok(paths.includes("docs/guide.md"));
    // No selection persists as the presentation "no file" record.
    const empty = filesViewState(null, new Set(["docs"]), false);
    NodeAssert.equal(empty.relativePath, "");
    NodeAssert.equal(restoredSelection(empty), null);
    NodeAssert.deepEqual([...restoredExpanded(empty)], ["docs"]);
  });

  NodeTest.it("legacy { relativePath } saves restore with defaults", () => {
    const legacy = { relativePath: "src/app.ts" };
    NodeAssert.equal(isFilesViewState(legacy), true);
    NodeAssert.equal(isFilesViewState(null), true);
    NodeAssert.deepEqual([...restoredExpanded(legacy)], []);
    NodeAssert.equal(restoredRenderMarkdown(legacy), false);
    NodeAssert.deepEqual([...restoredExpanded(null)], []);
    NodeAssert.equal(restoredRenderMarkdown(null), false);
  });

  NodeTest.it("malformed view state is rejected and restores nothing", () => {
    for (const bad of [
      [],
      {},
      "src/app.ts",
      { relativePath: 1 },
      { relativePath: "a", extra: true },
      { relativePath: "a", expanded: "docs" },
      { relativePath: "a", expanded: ["docs", 2] },
      { relativePath: "a", renderMarkdown: "yes" },
      { relativePath: "a", expanded: Array.from({ length: MAX_PERSISTED_EXPANDED + 1 }, String) },
    ]) {
      NodeAssert.equal(isFilesViewState(bad), false, JSON.stringify(bad).slice(0, 60));
      NodeAssert.deepEqual([...restoredExpanded(bad)], []);
      NodeAssert.equal(restoredRenderMarkdown(bad), false);
    }
  });

  NodeTest.it("persisted expansion is bounded and always restorable", () => {
    const many = new Set(Array.from({ length: MAX_PERSISTED_EXPANDED + 10 }, (_, i) => `d${i}`));
    const saved = filesViewState("a.ts", many, false);
    NodeAssert.equal(saved.expanded.length, MAX_PERSISTED_EXPANDED);
    NodeAssert.equal(isFilesViewState(saved), true);
  });

  NodeTest.it("deep expanded paths stay under the host's saved-state payload cap", () => {
    // 512 paths of ~200 bytes is ~100 KiB — past the host's 64 KiB cap, where
    // `session.save` throws instead of persisting.
    const deep = new Set(
      Array.from({ length: MAX_PERSISTED_EXPANDED }, (_, i) => `${"nested/".repeat(28)}d${i}`),
    );
    const saved = filesViewState("a.ts", deep, true);
    NodeAssert.ok(saved.expanded.length > 0 && saved.expanded.length < MAX_PERSISTED_EXPANDED);
    NodeAssert.ok(
      Buffer.byteLength(JSON.stringify(saved.expanded)) <= MAX_PERSISTED_EXPANDED_BYTES,
    );
    const restored = copyJson(saved);
    NodeAssert.equal(isFilesViewState(restored), true);
    NodeAssert.equal(restoredExpanded(restored).size, saved.expanded.length);
    NodeAssert.equal(restoredRenderMarkdown(restored), true);
  });

  NodeTest.it("describePresentation reports the resolved descriptor", () => {
    NodeAssert.equal(
      describePresentation({ surfaceId: "t3.files/view", placement: "side-panel" }),
      "opens in t3.files/view · side-panel",
    );
  });

  NodeTest.it("fileOpenFailed names the t3.file/open grant denial", () => {
    const state = fileOpenFailed(new Error("API capability denied: t3.file/open"));
    NodeAssert.equal(state.status, "denied");
    NodeAssert.match(state.message, /t3\.file\/open grant/);
  });

  NodeTest.it("fileOpenFailed maps resolution failures to unavailable", () => {
    NodeAssert.equal(
      fileOpenFailed(new Error("provider-selection-required")).status,
      "unavailable",
    );
    NodeAssert.match(
      fileOpenFailed(new Error("provider-selection-required")).message,
      /pick one for t3\.file\/presentation/,
    );
    NodeAssert.equal(fileOpenFailed(new Error("missing-api")).status, "unavailable");
    NodeAssert.equal(
      fileOpenFailed(new Error("selected-provider-unavailable")).status,
      "unavailable",
    );
  });

  NodeTest.it("fileOpenFailed reports generic errors with their detail", () => {
    const state = fileOpenFailed(new Error("disk gone"));
    NodeAssert.equal(state.status, "unavailable");
    NodeAssert.equal(state.message, "Open failed: disk gone");
    NodeAssert.match(fileOpenFailed("string failure").message, /Open failed: string failure/);
  });

  NodeTest.it("describeFileOpen labels every state", () => {
    NodeAssert.equal(describeFileOpen({ status: "idle" }), "");
    NodeAssert.equal(describeFileOpen({ status: "resolving" }), "Resolving presentation…");
    NodeAssert.equal(
      describeFileOpen({ status: "resolved", message: "opens in x · y" }),
      "opens in x · y",
    );
    NodeAssert.equal(describeFileOpen({ status: "denied", message: "nope" }), "nope");
  });
});

NodeTest.describe("isMarkdownPath", () => {
  NodeTest.it("matches the native isMarkdownPreviewFile extensions", () => {
    for (const yes of ["README.md", "docs/guide.MD", "x.mdx", "a/b.MDX"])
      NodeAssert.equal(isMarkdownPath(yes), true, yes);
    for (const no of ["x.txt", "md", "x.md.bak", "x.markdown"])
      NodeAssert.equal(isMarkdownPath(no), false, no);
  });
});
NodeTest.describe("editorSavePending", () => {
  NodeTest.it("latches dirty, saving, conflict and error — the states with local work", () => {
    for (const kind of ["dirty", "saving", "conflict", "error"])
      NodeAssert.equal(editorSavePending(kind), true, kind);
    for (const kind of ["clean", "saved"]) NodeAssert.equal(editorSavePending(kind), false, kind);
  });
});

NodeTest.describe("shouldHandleMutation", () => {
  NodeTest.it("fires once per mutationSeq bump", () => {
    NodeAssert.equal(shouldHandleMutation({ enabled: true, mutationSeq: 3, handledSeq: 2 }), true);
    NodeAssert.equal(shouldHandleMutation({ enabled: true, mutationSeq: 3, handledSeq: 3 }), false);
  });
  NodeTest.it("keeps a bump pending while the save latch holds, firing after it opens", () => {
    const bumped = { enabled: false, mutationSeq: 4, handledSeq: 3 };
    NodeAssert.equal(shouldHandleMutation(bumped), false);
    // The latch released: the same seq is still unhandled and now fires.
    NodeAssert.equal(shouldHandleMutation({ ...bumped, enabled: true }), true);
  });
  NodeTest.it("fires on the first observed nonzero seq — no baseline suppression", () => {
    // A mutation folded before this view subscribed still counts: the first
    // seq may post-date the initial tree/file reads, so it must refresh once.
    NodeAssert.equal(
      shouldHandleMutation({ enabled: true, mutationSeq: 3, handledSeq: null }),
      true,
    );
    // seq 0 is the empty fold — nothing mutated, nothing to re-read.
    NodeAssert.equal(
      shouldHandleMutation({ enabled: true, mutationSeq: 0, handledSeq: null }),
      false,
    );
  });
});

NodeTest.describe("resource read fold", () => {
  const sha256 = (text) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
  const utf8Length = (text) => Buffer.byteLength(text, "utf8");
  const manifest = (contents, overrides = {}) => ({
    kind: "manifest",
    relativePath: "doc",
    byteLength: utf8Length(contents),
    deliveredByteLength: utf8Length(contents),
    chunkCount: 1,
    truncated: false,
    ...overrides,
  });
  const stream = async function* (events) {
    for (const value of events) yield { value };
  };
  const signal = () => new AbortController().signal;

  NodeTest.it(
    "verifies a complete manifest/chunks/complete transfer into an editable read",
    async () => {
      const body = "x".repeat(30000);
      const chunks = [body.slice(0, 8192), body.slice(8192, 16384), body.slice(16384)];
      const events = [
        manifest(body, { chunkCount: 3 }),
        ...chunks.map((data, chunkIndex) => ({ kind: "chunk", chunkIndex, data })),
        { kind: "complete", sha256: sha256(body) },
      ];
      const read = await collectResourceRead(stream(events), signal());
      NodeAssert.equal(read.kind, "verified");
      NodeAssert.equal(read.read.contents, body);
      NodeAssert.equal(read.read.truncated, false);
      NodeAssert.equal(read.read.revision, sha256(body));
      // The verified read opens the editor with the terminal digest as revision.
      NodeAssert.deepEqual(describeResourceRead(read), {
        editable: true,
        contents: body,
        revision: sha256(body),
      });
    },
  );

  NodeTest.it("marks a truncated delivery verified but never editable", async () => {
    const body = "y".repeat(100);
    const events = [
      manifest(body.slice(0, 40), { byteLength: 100, truncated: true }),
      { kind: "chunk", chunkIndex: 0, data: body.slice(0, 40) },
      { kind: "complete", sha256: sha256(body.slice(0, 40)) },
    ];
    const read = await collectResourceRead(stream(events), signal());
    NodeAssert.equal(read.kind, "verified");
    NodeAssert.equal(read.read.revision, null);
    const open = describeResourceRead(read);
    NodeAssert.equal(open.editable, false);
    NodeAssert.equal(open.reason, "oversized");
    // The preview still renders the verified prefix with honest status.
    const preview = describeResourcePreview(read);
    NodeAssert.equal(preview.contents, body.slice(0, 40));
    NodeAssert.equal(preview.truncated, true);
    NodeAssert.match(preview.status, /showing first 40 of 100 bytes/);
  });

  NodeTest.it("surfaces a sole unavailable frame as the named reason", async () => {
    const read = await collectResourceRead(
      stream([{ kind: "unavailable", relativePath: "bin", reason: "binary" }]),
      signal(),
    );
    NodeAssert.deepEqual(read, { kind: "unavailable", reason: "binary" });
    NodeAssert.equal(describeResourceRead(read).reason, "binary");
    NodeAssert.match(describeResourcePreview(read).status, /Binary file/);
    // Upload-only reasons a nonconforming host emits degrade to io-error.
    const odd = await collectResourceRead(
      stream([{ kind: "unavailable", relativePath: "x", reason: "unknown-upload" }]),
      signal(),
    );
    NodeAssert.equal(describeResourceRead(odd).reason, "io-error");
  });

  NodeTest.it("rejects out-of-order, undeclared and post-terminal frames", () => {
    const cases = [
      // chunk before the manifest
      [{ kind: "chunk", chunkIndex: 0, data: "ab" }],
      // out-of-order chunk
      [manifest("abcd", { chunkCount: 2 }), { kind: "chunk", chunkIndex: 1, data: "cd" }],
      // undeclared chunk index
      [manifest("ab"), { kind: "chunk", chunkIndex: 1, data: "ab" }],
      // duplicate manifest
      [manifest("ab"), manifest("ab")],
      // anything after complete
      [
        manifest("ab"),
        { kind: "chunk", chunkIndex: 0, data: "ab" },
        { kind: "complete", sha256: sha256("ab") },
        { kind: "chunk", chunkIndex: 0, data: "ab" },
      ],
      // unavailable after the manifest
      [manifest("ab"), { kind: "unavailable", relativePath: "doc", reason: "not-found" }],
    ];
    for (const events of cases) {
      let assembly = createResourceReadAssembly();
      let failed = false;
      for (const event of events) {
        const next = applyResourceReadEvent(assembly, event);
        if (!next.ok) {
          failed = true;
          break;
        }
        assembly = next.assembly;
      }
      NodeAssert.equal(failed, true, JSON.stringify(events));
    }
  });

  NodeTest.it(
    "fails mismatched digests, lengths and incomplete streams before render",
    async () => {
      const body = "z".repeat(100);
      const good = [
        manifest(body),
        { kind: "chunk", chunkIndex: 0, data: body },
        { kind: "complete", sha256: sha256(body) },
      ];
      const cases = [
        // wrong terminal digest
        [...good.slice(0, 2), { kind: "complete", sha256: "0".repeat(64) }],
        // delivered bytes disagree with the manifest
        [manifest(body, { deliveredByteLength: 99 }), ...good.slice(1)],
        // declared chunk never arrives
        good.slice(0, 2),
        // stream ends before the complete frame
        good.slice(0, 1),
        // manifest claims complete but declares fewer delivered bytes
        [
          manifest(body, { deliveredByteLength: 99, byteLength: 100 }),
          { kind: "chunk", chunkIndex: 0, data: body.slice(0, 99) },
          { kind: "complete", sha256: sha256(body.slice(0, 99)) },
        ],
      ];
      const expected = ["mismatch", "mismatch", "incomplete", "incomplete", "mismatch"];
      for (const [index, events] of cases.entries()) {
        const read = await collectResourceRead(stream(events), signal());
        NodeAssert.equal(read.kind, expected[index], `case ${index}: ${JSON.stringify(read)}`);
        const open = describeResourceRead(read);
        NodeAssert.equal(open.editable, false);
        NodeAssert.equal(open.reason, "io-error");
      }
    },
  );

  NodeTest.it("cancels mid-stream without producing content", async () => {
    const controller = new AbortController();
    const body = "x".repeat(20000);
    const read = await collectResourceRead(
      (async function* () {
        yield { value: manifest(body, { chunkCount: 3 }) };
        controller.abort();
        yield { value: { kind: "chunk", chunkIndex: 0, data: body.slice(0, 8192) } };
        yield { value: { kind: "chunk", chunkIndex: 1, data: body.slice(8192, 16384) } };
        yield { value: { kind: "chunk", chunkIndex: 2, data: body.slice(16384) } };
        yield { value: { kind: "complete", sha256: sha256(body) } };
      })(),
      controller.signal,
    );
    NodeAssert.equal(read.kind, "cancelled");
  });

  NodeTest.it("matches node:crypto digests on the portable sha256 path", () => {
    const vectors = [
      "",
      "abc",
      "x".repeat(64),
      "x".repeat(65),
      "αβγ 😀 multi-byte\n",
      "y".repeat(30000),
    ];
    for (const text of vectors) {
      NodeAssert.equal(
        sha256HexPortable(new TextEncoder().encode(text)),
        sha256(text),
        JSON.stringify(text.slice(0, 20)),
      );
    }
  });

  NodeTest.it("surfaces a throwing verifier as mismatch, never a rejection", async () => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return; // non-secure-context runtimes already take the portable path
    const original = subtle.digest.bind(subtle);
    subtle.digest = () => Promise.reject(new Error("no subtle on this origin"));
    try {
      const body = "z".repeat(9000);
      const read = await collectResourceRead(
        stream([
          manifest(body, { chunkCount: 2 }),
          { kind: "chunk", chunkIndex: 0, data: body.slice(0, 8192) },
          { kind: "chunk", chunkIndex: 1, data: body.slice(8192) },
          { kind: "complete", sha256: sha256(body) },
        ]),
        signal(),
      );
      NodeAssert.equal(read.kind, "mismatch");
    } finally {
      subtle.digest = original;
    }
  });
});
