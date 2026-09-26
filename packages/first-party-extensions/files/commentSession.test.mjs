import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import React from "react";
import TestRenderer from "react-test-renderer";

import {
  LISTED_ANNOTATIONS_CAP,
  useCommentDraft,
  useCommentTransport,
  useEditorSelection,
  usePostedComments,
} from "./commentSession.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, create } = TestRenderer;
const e = React.createElement;

// Built (not literal) so every call yields a distinct string identity, the
// way a fresh readSnapshot does — identical literals would intern.
const makeContents = () => ["alpha", "beta", "gamma"].join("\n");

const editableSurface = (path, contents) => ({
  path,
  open: { editable: true },
  contents,
  saveState: { kind: "saved" },
});

NodeTest.describe("useEditorSelection", () => {
  let latest;
  function Probe(props) {
    const current = useEditorSelection(props.surface, props.selected);
    React.useEffect(() => {
      latest = current;
    });
    return null;
  }

  // Select L2–L3 in a.ts, open b.ts, reopen a.ts — the toolbar must not
  // re-offer the dead selection over whichever lines now sit at the old
  // offsets.
  NodeTest.it("a selection does not survive a file switch and back", async () => {
    let root;
    try {
      await act(async () => {
        root = create(
          e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", makeContents()) }),
        );
      });
      await act(async () => {
        latest.setSelection({ path: "a.ts", start: 6, end: 12 });
      });
      NodeAssert.deepEqual(latest.selectionRange, { startLine: 2, endLine: 3 });

      await act(async () => {
        root.update(
          e(Probe, {
            selected: "b.ts",
            surface: editableSurface("b.ts", ["other file"].join("\n")),
          }),
        );
      });
      NodeAssert.equal(latest.selectionRange, null);

      // Reopening a.ts re-reads it: fresh contents identity, so the stale
      // offsets from the first visit must not re-arm.
      await act(async () => {
        root.update(
          e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", makeContents()) }),
        );
      });
      NodeAssert.equal(latest.selectionRange, null);

      // The way back in is a real selection in the reopened buffer.
      await act(async () => {
        latest.setSelection({ path: "a.ts", start: 0, end: 5 });
      });
      NodeAssert.deepEqual(latest.selectionRange, { startLine: 1, endLine: 1 });
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  // Same-path half of the case above: an external sync or reload replaces the
  // buffer under a held selection — the offsets are dead even though the path
  // still matches.
  NodeTest.it("a selection does not survive replaced contents on the same file", async () => {
    let root;
    try {
      await act(async () => {
        root = create(
          e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", makeContents()) }),
        );
      });
      await act(async () => {
        latest.setSelection({ path: "a.ts", start: 6, end: 12 });
      });
      NodeAssert.notEqual(latest.selectionRange, null);

      const replacement = ["alpha", "beta edited", "gamma"].join("\n");
      await act(async () => {
        root.update(e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", replacement) }));
      });
      NodeAssert.equal(latest.selectionRange, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  // Select L2-3, sync to different bytes (dead at read), then sync back to
  // byte-identical contents — === is value equality, so a pin retired only on
  // path change would re-match here and re-arm offsets nobody is holding. The
  // pin must retire on EITHER input's mismatch.
  NodeTest.it(
    "a contents-invalidated selection stays dead on a byte-identical revert",
    async () => {
      let root;
      try {
        await act(async () => {
          root = create(
            e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", makeContents()) }),
          );
        });
        await act(async () => {
          latest.setSelection({ path: "a.ts", start: 6, end: 12 });
        });
        NodeAssert.deepEqual(latest.selectionRange, { startLine: 2, endLine: 3 });

        // Sync replaces the buffer under the held selection — dead at read,
        // and now retired in render rather than lingering.
        await act(async () => {
          root.update(
            e(Probe, {
              selected: "a.ts",
              surface: editableSurface("a.ts", ["alpha", "beta shifted", "gamma"].join("\n")),
            }),
          );
        });
        NodeAssert.equal(latest.selectionRange, null);

        // The revert: a fresh string with the same bytes. A lingering pin
        // would re-match its contents pin and resurrect the dead selection.
        await act(async () => {
          root.update(
            e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", makeContents()) }),
          );
        });
        NodeAssert.equal(latest.selectionRange, null);
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );

  // Same resurrection through the non-editable dip: the open path resolves
  // non-editable (surface contents ""), then a later open is editable again
  // with byte-identical contents — the pin must already be retired.
  NodeTest.it("a selection does not resurrect through a non-editable dip", async () => {
    let root;
    try {
      const contents = makeContents();
      await act(async () => {
        root = create(e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", contents) }));
      });
      await act(async () => {
        latest.setSelection({ path: "a.ts", start: 6, end: 12 });
      });
      NodeAssert.deepEqual(latest.selectionRange, { startLine: 2, endLine: 3 });

      await act(async () => {
        root.update(
          e(Probe, {
            selected: "a.ts",
            surface: {
              path: "a.ts",
              open: { editable: false },
              contents: "",
              saveState: { kind: "saved" },
            },
          }),
        );
      });
      NodeAssert.equal(latest.selectionRange, null);

      await act(async () => {
        root.update(
          e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", makeContents()) }),
        );
      });
      NodeAssert.equal(latest.selectionRange, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  // Re-selecting the open file's row keeps the same buffer; the view clears
  // through clearSelection there (select() fires with unchanged deps).
  NodeTest.it("clearSelection drops a held selection on an unchanged buffer", async () => {
    let root;
    try {
      const contents = makeContents();
      const surface = editableSurface("a.ts", contents);
      await act(async () => {
        root = create(e(Probe, { selected: "a.ts", surface }));
      });
      await act(async () => {
        latest.setSelection({ path: "a.ts", start: 6, end: 12 });
      });
      NodeAssert.notEqual(latest.selectionRange, null);
      await act(async () => {
        latest.clearSelection();
      });
      NodeAssert.equal(latest.selectionRange, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

NodeTest.describe("useCommentDraft", () => {
  let latest;
  function Probe(props) {
    const current = useCommentDraft(props.surface, props.selected);
    React.useEffect(() => {
      latest = current;
    });
    return null;
  }

  // Built per call — a reopened or re-synced file yields a fresh string with
  // the same bytes, which === still matches (value equality on primitives).
  const bigContents = (...extra) =>
    [...Array.from({ length: 80 }, (_, index) => `line ${index + 1}`), ...extra].join("\n");

  // Open a draft on L40-42, then let the buffer drift under it (typing or an
  // external sync). The captured offsets are dead at read — the form goes stale
  // and submit has nothing live to ship, so attachAnnotation can never receive
  // offsets captured against different bytes.
  NodeTest.it(
    "a draft whose buffer drifted goes stale instead of shipping stale offsets",
    async () => {
      let root;
      try {
        await act(async () => {
          root = create(
            e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", bigContents()) }),
          );
        });
        await act(async () => {
          latest.openDraft({ startLine: 40, endLine: 42 });
        });
        NodeAssert.equal(latest.draftStale, false);
        NodeAssert.equal(latest.draft?.path, "a.ts");
        NodeAssert.deepEqual(latest.draft?.range, { startLine: 40, endLine: 42 });
        NodeAssert.equal(latest.draft?.excerpt, "line 40\nline 41\nline 42");

        // The drift probe: appended lines leave 40-42 visually intact but the
        // pinned bytes no longer match the live buffer — the draft is stale.
        await act(async () => {
          root.update(
            e(Probe, {
              selected: "a.ts",
              surface: editableSurface("a.ts", bigContents("synced tail")),
            }),
          );
        });
        NodeAssert.equal(latest.draftStale, true);
        // Stale stays visible — the form keeps the user's text and names the
        // drift rather than vanishing.
        NodeAssert.equal(latest.draft?.path, "a.ts");

        // Cancel still works from the stale state.
        await act(async () => {
          latest.closeDraft();
        });
        NodeAssert.equal(latest.draft, null);
        NodeAssert.equal(latest.draftStale, false);
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );

  // Navigation: a draft dies with navigation the way a held selection does —
  // select() closes it, and the pin retires on a path change so an
  // away-and-back reopen on byte-identical contents cannot re-arm it.
  NodeTest.it("a draft does not survive navigation away and back", async () => {
    let root;
    try {
      await act(async () => {
        root = create(
          e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", bigContents()) }),
        );
      });
      await act(async () => {
        latest.openDraft({ startLine: 40, endLine: 42 });
      });
      NodeAssert.notEqual(latest.draft, null);

      await act(async () => {
        root.update(
          e(Probe, { selected: "b.ts", surface: editableSurface("b.ts", ["other"].join("\n")) }),
        );
      });
      NodeAssert.equal(latest.draft, null);
      NodeAssert.equal(latest.draftStale, false);

      // Reopening a.ts re-reads it: fresh string, byte-identical contents.
      // Without the render-phase retire the value-equal contents pin would
      // re-arm the dead draft over a buffer that may have changed in between.
      await act(async () => {
        root.update(
          e(Probe, { selected: "a.ts", surface: editableSurface("a.ts", bigContents()) }),
        );
      });
      NodeAssert.equal(latest.draft, null);
      NodeAssert.equal(latest.draftStale, false);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

NodeTest.describe("useEditorSelection memoization", () => {
  let latest;
  let renders;
  function Probe(props) {
    const current = useEditorSelection(props.surface, props.selected);
    React.useEffect(() => {
      renders += 1;
      latest = current;
    });
    return null;
  }

  // While a selection is held, unrelated re-renders (drag mousemove, theme
  // ticks, save-state flips) must not rescan the buffer — selectionLineRange
  // builds a fresh object per call, so a held reference across renders is the
  // observable proof the memo held.
  NodeTest.it("holds one line-range object across unrelated renders", async () => {
    renders = 0;
    const contents = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`).join("\n");
    const surface = {
      path: "big.ts",
      open: { editable: true },
      contents,
      saveState: { kind: "saved" },
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { selected: "big.ts", surface, bump: 0 }));
      });
      await act(async () => {
        latest.setSelection({ path: "big.ts", start: 90, end: 100 });
      });
      const held = latest.selectionRange;
      // Lines 1-9 are 7 chars ("line N\n"), line 10 on are 8: offset 90
      // sits on line 13, offset 99 on line 14.
      NodeAssert.deepEqual(held, { startLine: 13, endLine: 14 });

      // Same surface object, same selection — five unrelated re-renders.
      for (let bump = 1; bump <= 5; bump += 1) {
        await act(async () => {
          root.update(e(Probe, { selected: "big.ts", surface, bump }));
        });
        NodeAssert.ok(latest.selectionRange === held, `range identity broke at render ${bump}`);
      }
      NodeAssert.ok(renders > 5, "the probe actually re-rendered");

      // A real input change legitimately recomputes.
      await act(async () => {
        latest.setSelection({ path: "big.ts", start: 0, end: 8 });
      });
      NodeAssert.ok(latest.selectionRange !== held);
      NodeAssert.deepEqual(latest.selectionRange, { startLine: 1, endLine: 2 });
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

NodeTest.describe("useCommentTransport", () => {
  const session = {
    context: {
      resource: {
        namespace: "t3.extensions",
        id: "t3.files",
        environmentId: "env",
        projectId: "project",
        threadId: "thread",
      },
      client: "web",
      workspaceRevision: "rev",
    },
    signal: new AbortController().signal,
    restoring: false,
    visible: true,
    onVisibility: () => () => {},
    restoreState: null,
    publish: () => true,
    save: () => true,
    invoke: () => Promise.reject(new Error("no capabilities")),
    onDispose: () => {},
  };
  let latest;
  function Probe(props) {
    const current = useCommentTransport(props.host, session, props.threadId).reason;
    React.useEffect(() => {
      latest = current;
    });
    return null;
  }
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

  // A rejected capability probe must land as a named degraded transport reason,
  // not a "Checking…" state that outlives the probe.
  NodeTest.it("a rejected probe names the failure, never a permanent checking state", async () => {
    let failProbe;
    const host = {
      invokeApi(request) {
        NodeAssert.equal(request.method, "getCapabilities");
        // Held pending so the transient "Checking…" state is observable.
        return new Promise((_, reject) => {
          failProbe = () => reject(new Error("provider connection dropped"));
        });
      },
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a" }));
      });
      NodeAssert.equal(latest, "Checking comment support with the host…");
      await act(async () => {
        failProbe();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      NodeAssert.notEqual(latest, "Checking comment support with the host…");
      NodeAssert.equal(latest, "provider connection dropped");
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("a non-Error rejection still names a reason", async () => {
    const host = { invokeApi: () => Promise.reject("raw string") };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a" }));
      });
      await settle();
      NodeAssert.equal(latest, "Comment support could not be checked with the host.");
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it(
    "clears a ready client transport and forwards the host's unavailable detail",
    async () => {
      const ready = {
        invokeApi: () =>
          Promise.resolve({
            adapter: "host.messages",
            transport: "client",
            detail: null,
            operations: { attachAnnotation: true },
          }),
      };
      const down = {
        invokeApi: () =>
          Promise.resolve({
            adapter: "host.messages",
            transport: "unavailable",
            detail:
              "Composer draft state is client-local; no connected client hosts the composer provider.",
            operations: { attachAnnotation: false },
          }),
      };
      let root;
      try {
        await act(async () => {
          root = create(e(Probe, { host: ready, threadId: "thread-a" }));
        });
        await settle();
        NodeAssert.equal(latest, null);

        root.update(e(Probe, { host: down, threadId: "thread-a" }));
        await settle();
        NodeAssert.equal(
          latest,
          "Composer draft state is client-local; no connected client hosts the composer provider.",
        );
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );

  NodeTest.it("names a missing thread scope over a ready transport", async () => {
    const ready = {
      invokeApi: () =>
        Promise.resolve({
          adapter: "host.messages",
          transport: "client",
          detail: null,
          operations: { attachAnnotation: true },
        }),
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host: ready, threadId: undefined }));
      });
      await settle();
      NodeAssert.equal(
        latest,
        "This panel has no thread scope, so there is no draft to comment into.",
      );
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

NodeTest.describe("usePostedComments", () => {
  const session = {
    context: {
      resource: {
        namespace: "t3.extensions",
        id: "t3.files",
        environmentId: "env",
        projectId: "project",
        threadId: "thread",
      },
      client: "web",
      workspaceRevision: "rev",
    },
    signal: new AbortController().signal,
    restoring: false,
    visible: true,
    onVisibility: () => () => {},
    restoreState: null,
    publish: () => true,
    save: () => true,
    invoke: () => Promise.reject(new Error("no capabilities")),
    onDispose: () => {},
  };
  const v11 = {
    adapter: "host.messages",
    transport: "client",
    detail: null,
    operations: { attachAnnotation: true, listAnnotations: true, removeAnnotation: true },
  };
  const v10 = {
    adapter: "host.messages",
    transport: "client",
    detail: null,
    operations: { attachAnnotation: true, listAnnotations: false, removeAnnotation: false },
  };
  const listed = (annotationId, filePath, rangeLabel, kind = "file") => ({
    annotationId,
    kind,
    filePath,
    rangeLabel,
    sectionTitle: filePath,
  });

  /** A fake composer draft: list/remove answer from `draft` synchronously-resolved. */
  function draftHost(draft) {
    const calls = [];
    return {
      calls,
      invokeApi(request) {
        calls.push([request.method, request.input]);
        if (request.method === "listAnnotations")
          return Promise.resolve({
            annotations: draft
              .filter((entry) => entry.thread === request.input.threadId)
              .map(({ thread: _t, ...entry }) => entry),
          });
        if (request.method === "removeAnnotation") {
          const index = draft.findIndex(
            (entry) => entry.annotationId === request.input.annotationId,
          );
          if (index >= 0) draft.splice(index, 1);
          return Promise.resolve({ removed: index >= 0 });
        }
        return Promise.reject(new Error(`unexpected ${request.method}`));
      },
    };
  }

  let latest;
  function Probe(props) {
    const current = usePostedComments(
      props.host,
      session,
      props.threadId,
      props.capabilities,
      props.visible ?? true,
    );
    React.useEffect(() => {
      latest = current;
    });
    return null;
  }
  const flush = () => act(async () => {});
  const summary = () => latest.comments.map((c) => [c.annotationId, c.path, c.rangeLabel, c.text]);

  NodeTest.it(
    "lists the thread's draft, file annotations only, bodies from own attaches",
    async () => {
      const draft = [
        { thread: "thread-a", ...listed("a1", "src/a.ts", "L1 to L2") },
        { thread: "thread-a", ...listed("d1", "src/a.ts", "L3", "diff") },
        { thread: "thread-b", ...listed("b1", "src/b.ts", "L9") },
      ];
      const host = draftHost(draft);
      let root;
      try {
        await act(async () => {
          root = create(e(Probe, { host, threadId: "thread-a", capabilities: v11 }));
        });
        await flush();
        NodeAssert.deepEqual(summary(), [["a1", "src/a.ts", "L1 to L2", null]]);
        NodeAssert.equal(latest.listed, true);
        NodeAssert.equal(latest.removable, true);

        // Attach lands in the draft; the re-list keeps the body this view knows.
        draft.push({ thread: "thread-a", ...listed("a2", "src/a.ts", "L5") });
        await act(async () => {
          latest.recordAttached({
            annotationId: "a2",
            path: "src/a.ts",
            rangeLabel: "L5",
            text: "why?",
          });
        });
        await flush();
        NodeAssert.deepEqual(summary(), [
          ["a1", "src/a.ts", "L1 to L2", null],
          ["a2", "src/a.ts", "L5", "why?"],
        ]);

        // Switching threads lists the other thread's draft, no bleed.
        await act(async () =>
          root.update(e(Probe, { host, threadId: "thread-b", capabilities: v11 })),
        );
        await flush();
        NodeAssert.deepEqual(summary(), [["b1", "src/b.ts", "L9", null]]);
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );

  NodeTest.it("a chip removed in the composer drops out when the view is shown again", async () => {
    const draft = [{ thread: "thread-a", ...listed("a1", "src/a.ts", "L1") }];
    const host = draftHost(draft);
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a", capabilities: v11 }));
      });
      await flush();
      await act(async () => {
        latest.recordAttached({
          annotationId: "a1",
          path: "src/a.ts",
          rangeLabel: "L1",
          text: "x",
        });
      });
      await flush();
      NodeAssert.deepEqual(summary(), [["a1", "src/a.ts", "L1", "x"]]);

      draft.splice(0, 1); // user removed the chip in the composer
      await act(async () =>
        root.update(e(Probe, { host, threadId: "thread-a", capabilities: v11, visible: false })),
      );
      await act(async () =>
        root.update(e(Probe, { host, threadId: "thread-a", capabilities: v11, visible: true })),
      );
      await flush();
      // The locally known attach must not resurrect a chip the draft no longer holds.
      NodeAssert.deepEqual(summary(), []);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("remove goes through removeAnnotation and re-lists", async () => {
    const draft = [
      { thread: "thread-a", ...listed("a1", "src/a.ts", "L1") },
      { thread: "thread-a", ...listed("a2", "src/a.ts", "L2") },
    ];
    const host = draftHost(draft);
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a", capabilities: v11 }));
      });
      await flush();
      await act(async () => latest.remove("a1"));
      await flush();
      NodeAssert.deepEqual(
        host.calls.filter(([method]) => method === "removeAnnotation"),
        [["removeAnnotation", { threadId: "thread-a", annotationId: "a1" }]],
      );
      NodeAssert.deepEqual(summary(), [["a2", "src/a.ts", "L2", null]]);
      NodeAssert.equal(latest.error, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("names a failed remove and keeps the comment listed", async () => {
    const draft = [{ thread: "thread-a", ...listed("a1", "src/a.ts", "L1") }];
    const base = draftHost(draft);
    const host = {
      calls: base.calls,
      invokeApi(request) {
        if (request.method === "removeAnnotation")
          return Promise.reject(new Error("API capability denied: t3.messages/write"));
        return base.invokeApi(request);
      },
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a", capabilities: v11 }));
      });
      await flush();
      await act(async () => latest.remove("a1"));
      await flush();
      NodeAssert.equal(latest.error, "API capability denied: t3.messages/write");
      NodeAssert.deepEqual(summary(), [["a1", "src/a.ts", "L1", null]]);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("flags a listing at the op's cap", async () => {
    const draft = Array.from({ length: LISTED_ANNOTATIONS_CAP }, (_, i) => ({
      thread: "thread-a",
      ...listed(`a${i}`, "src/a.ts", `L${i + 1}`),
    }));
    let root;
    try {
      await act(async () => {
        root = create(
          e(Probe, { host: draftHost(draft), threadId: "thread-a", capabilities: v11 }),
        );
      });
      await flush();
      NodeAssert.equal(latest.capped, true);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it(
    "a 1.0 composer keeps this session's attaches per thread and never lists",
    async () => {
      const host = draftHost([]);
      let root;
      try {
        await act(async () => {
          root = create(e(Probe, { host, threadId: "thread-a", capabilities: v10 }));
        });
        await act(async () => {
          latest.recordAttached({
            annotationId: "a1",
            path: "src/a.ts",
            rangeLabel: "L1",
            text: "x",
          });
        });
        await flush();
        NodeAssert.deepEqual(summary(), [["a1", "src/a.ts", "L1", "x"]]);
        NodeAssert.equal(latest.listed, false);
        NodeAssert.equal(latest.removable, false);
        await act(async () => latest.remove("a1"));
        await act(async () =>
          root.update(e(Probe, { host, threadId: "thread-b", capabilities: v10 })),
        );
        NodeAssert.deepEqual(summary(), []);
        NodeAssert.deepEqual(host.calls, []);
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );
});
