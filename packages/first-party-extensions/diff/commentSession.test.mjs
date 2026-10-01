import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import React from "react";
import TestRenderer from "react-test-renderer";

import {
  useCommentBlockReason,
  useCommentTarget,
  useDiffCommentDraft,
  useLineSelection,
  usePostedComments,
} from "./commentSession.ts";
import { fileRows, renderableFromPatch } from "./viewModel.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, create } = TestRenderer;
const e = React.createElement;

const PATCH = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " line1",
  "-old",
  "+new",
  "+newer",
  " line3",
].join("\n");

const fileRow = renderableFromPatch(PATCH).files[0];
const rows = fileRows(fileRow);
const ordinalOf = (text) => rows.findIndex((row) => row.kind !== "gap" && row.text === text);

// Built (not literal) so every call yields a distinct object identity, the
// way a fresh preview redelivery does — identical contents still compare equal.
const buffer = (diffHash, fileKey, contents = null) => ({ diffHash, fileKey, contents });
const contents = (mutate = (text) => text) => ({
  oldContents: mutate("line1\nold\nline3"),
  newContents: mutate("line1\nnew\nnewer\nline3"),
});

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

NodeTest.describe("useLineSelection", () => {
  let latest;
  function Probe(props) {
    const current = useLineSelection(props.buffer);
    React.useEffect(() => {
      latest = current;
    });
    return null;
  }

  NodeTest.it("pins a run, extends it, and clears it", async () => {
    let root;
    try {
      const pinned = buffer("hash-1", "f1");
      await act(async () => {
        root = create(e(Probe, { buffer: pinned }));
      });
      await act(async () => {
        latest.select(pinned, 3, false);
      });
      NodeAssert.deepEqual(latest.selection, { anchor: 3, extent: 3 });
      await act(async () => {
        latest.select(pinned, 5, true);
      });
      NodeAssert.deepEqual(latest.selection, { anchor: 3, extent: 5 });
      await act(async () => {
        latest.clear();
      });
      NodeAssert.equal(latest.selection, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  // Select L4–L5 in f1, switch to f2 in the same source, come back: the
  // pin must not re-arm ordinals over rows that may have changed in between.
  NodeTest.it("a selection does not survive a file switch and back", async () => {
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { buffer: buffer("hash-1", "f1") }));
      });
      await act(async () => {
        latest.select(buffer("hash-1", "f1"), 4, false);
      });
      NodeAssert.notEqual(latest.selection, null);

      await act(async () => {
        root.update(e(Probe, { buffer: buffer("hash-1", "f2") }));
      });
      NodeAssert.equal(latest.selection, null);

      await act(async () => {
        root.update(e(Probe, { buffer: buffer("hash-1", "f1") }));
      });
      NodeAssert.equal(latest.selection, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("a selection does not survive a source refresh and back", async () => {
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { buffer: buffer("hash-1", "f1") }));
      });
      await act(async () => {
        latest.select(buffer("hash-1", "f1"), 4, false);
      });
      NodeAssert.notEqual(latest.selection, null);

      await act(async () => {
        root.update(e(Probe, { buffer: buffer("hash-2", "f1") }));
      });
      NodeAssert.equal(latest.selection, null);

      await act(async () => {
        root.update(e(Probe, { buffer: buffer("hash-1", "f1") }));
      });
      NodeAssert.equal(latest.selection, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  // `diffHash` equality proves the bytes did not move, so a byte-identical
  // redelivery (fresh objects, same values) legitimately keeps the pin —
  // the ordinals address the same rows.
  NodeTest.it("a selection survives a byte-identical redelivery", async () => {
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { buffer: buffer("hash-1", "f1", contents()) }));
      });
      await act(async () => {
        latest.select(buffer("hash-1", "f1", contents()), 4, false);
      });
      NodeAssert.deepEqual(latest.selection, { anchor: 4, extent: 4 });

      await act(async () => {
        root.update(e(Probe, { buffer: buffer("hash-1", "f1", contents()) }));
      });
      NodeAssert.deepEqual(latest.selection, { anchor: 4, extent: 4 });
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  // An expansion load or an edit reshapes the rows the ordinals address —
  // contents drift retires the pin even though hash and file still match.
  NodeTest.it("a selection does not survive contents drift or an expansion load", async () => {
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { buffer: buffer("hash-1", "f1") }));
      });
      await act(async () => {
        latest.select(buffer("hash-1", "f1"), 4, false);
      });
      NodeAssert.notEqual(latest.selection, null);

      await act(async () => {
        root.update(e(Probe, { buffer: buffer("hash-1", "f1", contents()) }));
      });
      NodeAssert.equal(latest.selection, null);

      // And a drifted contents value on a re-pinned selection:
      await act(async () => {
        latest.select(buffer("hash-1", "f1", contents()), 2, false);
      });
      NodeAssert.notEqual(latest.selection, null);
      await act(async () => {
        root.update(
          e(Probe, {
            buffer: buffer(
              "hash-1",
              "f1",
              contents((text) => `${text}\nnext`),
            ),
          }),
        );
      });
      NodeAssert.equal(latest.selection, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

NodeTest.describe("useDiffCommentDraft", () => {
  let latest;
  function Probe(props) {
    const current = useDiffCommentDraft(props.buffer);
    React.useEffect(() => {
      latest = current;
    });
    return null;
  }
  const target = {
    selection: { start: 3, side: "additions", end: 4, endSide: "additions" },
    startIndex: 2,
    endIndex: 3,
    rangeLabel: "+3 to +4",
    quote: "@@ -1,2 +1,3 @@\n+new\n+newer",
    truncated: false,
  };
  const draft = { fileKey: "f1", filePath: "src/app.ts", target };

  // The draft's captured anchor and quote are only honest against the exact
  // buffer they were built on: a drift turns the form stale instead of
  // letting submit ship them to attachAnnotation.
  NodeTest.it(
    "a draft whose buffer drifted goes stale instead of shipping dead anchors",
    async () => {
      let root;
      try {
        await act(async () => {
          root = create(e(Probe, { buffer: buffer("hash-1", "f1", contents()) }));
        });
        await act(async () => {
          latest.openDraft(buffer("hash-1", "f1", contents()), draft);
        });
        NodeAssert.equal(latest.draftStale, false);
        NodeAssert.equal(latest.draft?.filePath, "src/app.ts");

        await act(async () => {
          root.update(e(Probe, { buffer: buffer("hash-2", "f1", contents()) }));
        });
        NodeAssert.equal(latest.draftStale, true);
        // Stale stays visible — the form keeps the user's text and names the drift.
        NodeAssert.equal(latest.draft?.filePath, "src/app.ts");

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

  NodeTest.it("a draft does not survive navigation away and back", async () => {
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { buffer: buffer("hash-1", "f1", contents()) }));
      });
      await act(async () => {
        latest.openDraft(buffer("hash-1", "f1", contents()), draft);
      });
      NodeAssert.notEqual(latest.draft, null);

      await act(async () => {
        root.update(e(Probe, { buffer: buffer("hash-1", "f2", contents()) }));
      });
      NodeAssert.equal(latest.draft, null);
      NodeAssert.equal(latest.draftStale, false);

      // Back on byte-identical contents: without the render-phase retire the
      // value-equal pin would re-arm a draft over rows that may have changed.
      await act(async () => {
        root.update(e(Probe, { buffer: buffer("hash-1", "f1", contents()) }));
      });
      NodeAssert.equal(latest.draft, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("a draft stays live across a byte-identical redelivery", async () => {
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { buffer: buffer("hash-1", "f1", contents()) }));
      });
      await act(async () => {
        latest.openDraft(buffer("hash-1", "f1", contents()), draft);
      });
      await act(async () => {
        root.update(e(Probe, { buffer: buffer("hash-1", "f1", contents()) }));
      });
      NodeAssert.equal(latest.draftStale, false);
      NodeAssert.notEqual(latest.draft, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

NodeTest.describe("useCommentTarget", () => {
  let latest;
  let renders;
  function Probe(props) {
    const current = useCommentTarget(fileRow.file, rows, props.anchor, props.extent);
    React.useEffect(() => {
      renders += 1;
      latest = current;
    });
    return null;
  }

  // While a selection is held, unrelated re-renders (theme ticks, wrap
  // flips) must not re-enumerate the file's review rows — a held reference
  // across re-renders is the observable proof the memo held.
  NodeTest.it("holds one target object across unrelated renders", async () => {
    renders = 0;
    const anchor = ordinalOf("new");
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { anchor, extent: anchor, bump: 0 }));
      });
      NodeAssert.notEqual(latest, null);
      NodeAssert.equal(latest.rangeLabel, "+2");
      const held = latest;

      for (let bump = 1; bump <= 5; bump += 1) {
        await act(async () => {
          root.update(e(Probe, { anchor, extent: anchor, bump }));
        });
        NodeAssert.ok(latest === held, `target identity broke at render ${bump}`);
      }
      NodeAssert.ok(renders > 5, "the probe actually re-rendered");

      // A real selection change legitimately recomputes.
      const other = ordinalOf("newer");
      await act(async () => {
        root.update(e(Probe, { anchor, extent: other, bump: 6 }));
      });
      NodeAssert.ok(latest !== held);
      NodeAssert.equal(latest.rangeLabel, "+2 to +3");

      // No selection, no target.
      await act(async () => {
        root.update(e(Probe, { anchor: null, extent: null, bump: 7 }));
      });
      NodeAssert.equal(latest, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

const session = {
  context: {
    resource: {
      namespace: "t3.extensions",
      id: "t3.diff",
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

const readyCapabilities = () => ({
  adapter: "host.messages",
  transport: "client",
  detail: null,
  operations: { attachAnnotation: true, listAnnotations: true, removeAnnotation: true },
});

NodeTest.describe("useCommentBlockReason", () => {
  let latest;
  function Probe(props) {
    const current = useCommentBlockReason(props.host, session, props.threadId);
    React.useEffect(() => {
      latest = current;
    });
    return null;
  }

  // A rejected capability probe must land as a named degraded transport
  // reason, not a "Checking…" state that outlives the probe.
  NodeTest.it("a rejected probe names the failure, never a permanent checking state", async () => {
    let failProbe;
    const host = {
      invokeApi(request) {
        NodeAssert.equal(request.method, "getCapabilities");
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
      NodeAssert.equal(latest.reason, "Checking comment support with the host…");
      NodeAssert.equal(latest.capabilities, null);
      await act(async () => {
        failProbe();
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      NodeAssert.notEqual(latest.reason, "Checking comment support with the host…");
      NodeAssert.equal(latest.reason, "provider connection dropped");
      NodeAssert.equal(latest.capabilities.transport, "unavailable");
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
      NodeAssert.equal(latest.reason, "Comment support could not be checked with the host.");
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("clears over a ready client transport and names a missing thread scope", async () => {
    const host = { invokeApi: () => Promise.resolve(readyCapabilities()) };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread-a" }));
      });
      await settle();
      NodeAssert.equal(latest.reason, null);
      NodeAssert.deepEqual(latest.capabilities, readyCapabilities());

      await act(async () => {
        root.update(e(Probe, { host, threadId: undefined }));
      });
      NodeAssert.equal(
        latest.reason,
        "This panel has no thread scope, so there is no draft to comment into.",
      );
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

NodeTest.describe("usePostedComments", () => {
  let latest;
  function Probe(props) {
    const current = usePostedComments(props.host, session, props.threadId, props.listable);
    React.useEffect(() => {
      latest = current;
    });
    return null;
  }

  const listedDiff = {
    annotationId: "annotation:install-1:list-1",
    kind: "diff",
    filePath: "src/app.ts",
    rangeLabel: "+2",
    sectionTitle: "Working tree",
  };

  NodeTest.it("lists once, keeps only diff-kind entries, and dedupes posts", async () => {
    const host = {
      invokeApi(request) {
        NodeAssert.equal(request.method, "listAnnotations");
        return Promise.resolve({
          annotations: [
            listedDiff,
            { ...listedDiff, annotationId: "annotation:install-1:file-1", kind: "file" },
          ],
        });
      },
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread", listable: true }));
      });
      await settle();
      NodeAssert.deepEqual(latest.entries, [
        {
          annotationId: "annotation:install-1:list-1",
          filePath: "src/app.ts",
          fileKey: null,
          rangeLabel: "+2",
          text: null,
          sectionTitle: "Working tree",
        },
      ]);

      await act(async () => {
        latest.post({
          annotationId: "annotation:install-1:post-1",
          filePath: "src/app.ts",
          fileKey: "\u0000src/app.ts",
          rangeLabel: "+3",
          text: "looks right",
          sectionTitle: "Working tree",
        });
      });
      NodeAssert.equal(latest.entries.length, 2);

      await act(async () => {
        latest.post({
          annotationId: "annotation:install-1:post-1",
          filePath: "src/app.ts",
          fileKey: "\u0000src/app.ts",
          rangeLabel: "+3",
          text: "looks right",
          sectionTitle: "Working tree",
        });
      });
      NodeAssert.equal(latest.entries.length, 2);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("never invokes the listing while it is not listable", async () => {
    const host = {
      invokeApi() {
        throw new Error("listAnnotations must not be invoked");
      },
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread", listable: false }));
      });
      await settle();
      NodeAssert.deepEqual(latest.entries, []);
      NodeAssert.equal(latest.listError, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("surfaces a listing failure", async () => {
    const host = {
      invokeApi: () => Promise.reject(new Error("listing denied")),
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread", listable: true }));
      });
      await settle();
      NodeAssert.equal(latest.listError, "listing denied");
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("removes a posted comment through removeAnnotation", async () => {
    const host = {
      invokeApi(request) {
        if (request.method === "listAnnotations")
          return Promise.resolve({ annotations: [listedDiff] });
        NodeAssert.equal(request.method, "removeAnnotation");
        NodeAssert.equal(request.input.annotationId, "annotation:install-1:list-1");
        return Promise.resolve({ removed: true });
      },
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread", listable: true }));
      });
      await settle();
      NodeAssert.equal(latest.entries.length, 1);
      await act(async () => {
        latest.remove("annotation:install-1:list-1");
      });
      await settle();
      NodeAssert.deepEqual(latest.entries, []);
      NodeAssert.equal(latest.removing, null);
      NodeAssert.equal(latest.removeError, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  // removed:false is the already-gone case — the entry still drops locally,
  // with a note naming what happened.
  NodeTest.it("notes an already-gone removal and keeps a failed one", async () => {
    let outcome;
    const host = {
      invokeApi(request) {
        if (request.method === "listAnnotations")
          return Promise.resolve({ annotations: [listedDiff] });
        if (outcome === "gone") return Promise.resolve({ removed: false });
        return Promise.reject(new Error("not yours to remove"));
      },
    };
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { host, threadId: "thread", listable: true }));
      });
      await settle();

      outcome = "gone";
      await act(async () => {
        latest.remove("annotation:install-1:list-1");
      });
      await settle();
      NodeAssert.deepEqual(latest.entries, []);
      NodeAssert.equal(latest.removeError, "The host no longer lists that comment.");

      // A rejected removal keeps the entry and names the error.
      await act(async () => {
        latest.post({
          annotationId: "annotation:install-1:list-1",
          filePath: "src/app.ts",
          fileKey: null,
          rangeLabel: "+2",
          text: null,
          sectionTitle: "Working tree",
        });
      });
      outcome = "reject";
      await act(async () => {
        latest.remove("annotation:install-1:list-1");
      });
      await settle();
      NodeAssert.equal(latest.entries.length, 1);
      NodeAssert.equal(latest.removeError, "not yours to remove");
      NodeAssert.equal(latest.removing, null);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});
