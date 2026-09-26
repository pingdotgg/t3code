import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeTest from "node:test";
import React from "react";
import TestRenderer from "react-test-renderer";

import { useFileEditor } from "./editorSession.ts";
import { useMutationRefresh, useWorkspaceChanges } from "./mutationRefresh.ts";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { act, create } = TestRenderer;
const e = React.createElement;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

NodeTest.describe("useFileEditor", () => {
  // A mutation-triggered refresh
  // reruns the editor effect and aborts that run's read signal; the retained
  // coordinator must still save afterwards — its persist signal is the
  // session's, not the dead refresh-read one.
  NodeTest.it("saves cleanly after a refresh superseded the open read", async () => {
    const reads = [];
    const saves = [];
    const host = {
      invokeApi(request, signal) {
        if (request.method === "readSnapshot") {
          reads.push(signal);
          return Promise.resolve({
            kind: "editable",
            contents: `remote-${reads.length}`,
            revision: `rev-${reads.length}`,
          });
        }
        if (request.method === "save") {
          signal.throwIfAborted();
          saves.push({ input: request.input, aborted: signal.aborted });
          return Promise.resolve({ kind: "saved", revision: `rev-save-${saves.length}` });
        }
        return Promise.reject(new Error(`unexpected ${request.method}`));
      },
    };
    let editor;
    function Probe(props) {
      const current = useFileEditor(
        host,
        session,
        props.selected,
        "text",
        props.refreshRevision,
        true,
      );
      React.useEffect(() => {
        editor = current;
      });
      return null;
    }
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { selected: "a.txt", refreshRevision: 0 }));
      });
      NodeAssert.equal(reads.length, 1);
      NodeAssert.equal(reads[0].aborted, false);
      NodeAssert.equal(editor.surface.contents, "remote-1");

      // A mutation bump refreshes: the first read's signal is aborted and the
      // snapshot is re-read — while the coordinator is retained for the path.
      await act(async () => {
        root.update(e(Probe, { selected: "a.txt", refreshRevision: 1 }));
      });
      NodeAssert.equal(reads.length, 2);
      NodeAssert.equal(reads[0].aborted, true);
      NodeAssert.equal(reads[1].aborted, false);
      NodeAssert.equal(editor.surface.contents, "remote-2");

      await act(async () => {
        editor.change("local edit");
        editor.retry();
      });
      NodeAssert.equal(saves.length, 1);
      NodeAssert.equal(saves[0].aborted, false);
      NodeAssert.equal(editor.surface.saveState.kind, "saved");
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  // Review repro: a delayed resource save for file A lands after the user
  // switched to file B (dispose flushes A's pending edit into an in-flight
  // persist). The confirmed-base byte size that routes saves between the
  // unary and chunked contracts is per-file state — A's landing must not
  // corrupt B's baseline, or B's shrink-below-24KiB save would wrongly take
  // the unary path and fail oversized against B's large on-disk base.
  NodeTest.it("keeps base-size save routing per file across a delayed save", async () => {
    const sha256 = (text) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");
    const utf8 = (text) => Buffer.byteLength(text, "utf8");
    const disk = { "a.txt": "a".repeat(30000), "b.txt": "b".repeat(40000) };
    const uploads = new Map();
    const chunkBuffers = new Map();
    const unarySaves = [];
    let releaseA = null;
    const host = {
      invokeApi(request, _signal) {
        const { method, input } = request;
        if (method === "readSnapshot")
          return Promise.resolve({
            kind: "not-editable",
            relativePath: input.relativePath,
            reason: "oversized",
          });
        if (method === "save") {
          unarySaves.push(input.relativePath);
          // The real contract re-reads the on-disk base under the 24,000-byte
          // bound — these files can never take the unary path.
          if (utf8(disk[input.relativePath]) > 24000)
            return Promise.reject(new Error("the base exceeds the editable bound"));
          disk[input.relativePath] = input.contents;
          return Promise.resolve({
            kind: "saved",
            relativePath: input.relativePath,
            revision: sha256(input.contents),
          });
        }
        if (method === "save.begin") {
          const uploadId = `up-${input.relativePath}`;
          uploads.set(uploadId, input.relativePath);
          chunkBuffers.set(uploadId, []);
          return Promise.resolve({ kind: "session", uploadId });
        }
        if (method === "save.chunk") {
          chunkBuffers.get(input.uploadId)[input.chunkIndex] = input.data;
          return Promise.resolve({ kind: "accepted", received: input.chunkIndex + 1 });
        }
        if (method === "save.commit") {
          const path = uploads.get(input.uploadId);
          const finish = () => {
            const contents = chunkBuffers.get(input.uploadId).join("");
            disk[path] = contents;
            return { kind: "saved", relativePath: path, revision: sha256(contents) };
          };
          // A's commit is held so the save stays in flight across the switch.
          if (path === "a.txt")
            return new Promise((resolve) => {
              releaseA = () => resolve(finish());
            });
          return Promise.resolve(finish());
        }
        if (method === "save.abort") return Promise.resolve({});
        return Promise.reject(new Error(`unexpected ${method}`));
      },
      subscribeApi(request, _signal) {
        const path = request.input.relativePath;
        const body = disk[path];
        const chunks = [];
        for (let start = 0; start < body.length; start += 8192)
          chunks.push(body.slice(start, start + 8192));
        return (async function* () {
          yield {
            value: {
              kind: "manifest",
              relativePath: path,
              byteLength: utf8(body),
              deliveredByteLength: utf8(body),
              chunkCount: chunks.length,
              truncated: false,
            },
          };
          for (const [chunkIndex, data] of chunks.entries())
            yield { value: { kind: "chunk", chunkIndex, data } };
          yield { value: { kind: "complete", sha256: sha256(body) } };
        })();
      },
    };
    let editor;
    function Probe(props) {
      const current = useFileEditor(host, session, props.selected, "text", 0, true);
      React.useEffect(() => {
        editor = current;
      });
      return null;
    }
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { selected: "a.txt" }));
      });
      await act(async () => {
        await sleep(50);
      });
      // A opened through the resource stream — editable, 30,000-byte base.
      NodeAssert.notEqual(editor.surface, null, JSON.stringify(editor.surface));
      NodeAssert.equal(editor.surface.path, "a.txt");
      NodeAssert.equal(editor.surface.open.editable, true);
      NodeAssert.equal(editor.surface.contents, disk["a.txt"]);

      await act(async () => {
        editor.change("small-a");
      });
      // Switching paths disposes A's coordinator, which flushes the pending
      // edit — its persist parks at the held commit while B opens.
      await act(async () => {
        root.update(e(Probe, { selected: "b.txt" }));
      });
      await act(async () => {
        await sleep(30);
      });
      NodeAssert.equal(editor.surface.path, "b.txt");
      NodeAssert.equal(editor.surface.contents, disk["b.txt"]);
      NodeAssert.ok(releaseA, "a.txt's save is still in flight");

      // A's delayed save lands — over a shared baseline this would overwrite
      // B's 40,000-byte base size with "small-a"'s 7.
      await act(async () => {
        releaseA();
        await sleep(10);
      });
      NodeAssert.equal(disk["a.txt"], "small-a");

      // B shrinks below the bound: the base is still 40,000 bytes, so this
      // must take the chunked path — the unary save would fail oversized.
      await act(async () => {
        editor.change("small-b");
        editor.retry();
        await sleep(10);
      });
      NodeAssert.deepEqual(unarySaves, []);
      NodeAssert.equal(editor.surface.saveState.kind, "saved");
      NodeAssert.equal(disk["b.txt"], "small-b");
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

NodeTest.describe("useMutationRefresh", () => {
  let calls;
  function Probe(props) {
    useMutationRefresh({
      mutationSeq: props.seq,
      enabled: props.enabled,
      refresh: () => calls.push(props.seq),
    });
    return null;
  }

  // No baseline suppression — the first observed nonzero seq must refresh
  // because it may fold mutations that landed during the view's initial reads.
  NodeTest.it("refreshes once on the first observed nonzero seq, never on seq 0", async () => {
    calls = [];
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { seq: 0, enabled: true }));
      });
      NodeAssert.equal(calls.length, 0);
      await act(async () => {
        root.update(e(Probe, { seq: 1, enabled: true }));
      });
      NodeAssert.deepEqual(calls, [1]);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  NodeTest.it("fires once per seq and catches up when the latch opens", async () => {
    calls = [];
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, { seq: 1, enabled: true }));
      });
      NodeAssert.equal(calls.length, 1);
      // Same seq does not refire.
      await act(async () => {
        root.update(e(Probe, { seq: 1, enabled: true }));
      });
      NodeAssert.equal(calls.length, 1);
      // Latched: a bump while disabled stays pending.
      await act(async () => {
        root.update(e(Probe, { seq: 2, enabled: false }));
      });
      NodeAssert.equal(calls.length, 1);
      await act(async () => {
        root.update(e(Probe, { seq: 2, enabled: true }));
      });
      NodeAssert.equal(calls.length, 2);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });
});

NodeTest.describe("useWorkspaceChanges", () => {
  function openStream(signal, frames) {
    return (async function* () {
      for (const frame of frames) {
        if (signal.aborted) return;
        yield { value: frame };
      }
      // Stay open until aborted — a real stream does not end silently.
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    })();
  }

  NodeTest.it("delivers the subscription snapshot to the mutation gate", async () => {
    const subscribes = [];
    const refreshes = [];
    const host = {
      subscribeApi(request, signal) {
        subscribes.push(request);
        return openStream(signal, [{ kind: "snapshot", mutationSeq: 1 }]);
      },
    };
    let probeStatus = "idle";
    function Probe() {
      const changes = useWorkspaceChanges(host, session, true, { retryMs: 5, errorRetryMs: 5 });
      useMutationRefresh({
        mutationSeq: changes.mutationSeq,
        enabled: true,
        refresh: () => refreshes.push(changes.mutationSeq),
      });
      React.useEffect(() => {
        probeStatus = changes.status;
      });
      return null;
    }
    let root;
    try {
      await act(async () => {
        root = create(e(Probe, {}));
        await sleep(20);
      });
      NodeAssert.equal(probeStatus, "live");
      // The snapshot's seq=1 — folded before this view subscribed — still
      // fires one refresh: a mutation between the initial reads and stream
      // setup is not swallowed as a baseline.
      NodeAssert.deepEqual(refreshes, [1]);
    } finally {
      if (root) await act(async () => root.unmount());
    }
  });

  // A stream that dies AFTER delivering frames is the common
  // established-connection loss — it must flip to degraded, and stay
  // unavailable until a fresh frame proves recovery.
  NodeTest.it(
    "marks a post-snapshot stream failure degraded until a fresh frame recovers",
    async () => {
      const subscribes = [];
      let failNext = null;
      let fail = false;
      const host = {
        subscribeApi(request, signal) {
          subscribes.push(request);
          if (fail) throw new Error("still down");
          return (async function* () {
            yield { value: { kind: "snapshot", mutationSeq: 4 } };
            // Park until aborted or until the test kills this stream.
            await new Promise((resolve, reject) => {
              failNext = reject;
              signal.addEventListener("abort", resolve, { once: true });
            });
          })();
        },
      };
      let probeStatus = "idle";
      function Probe() {
        const changes = useWorkspaceChanges(host, session, true, { retryMs: 5, errorRetryMs: 5 });
        React.useEffect(() => {
          probeStatus = changes.status;
        });
        return null;
      }
      let root;
      try {
        await act(async () => {
          root = create(e(Probe, {}));
          await sleep(10);
        });
        NodeAssert.equal(probeStatus, "live");
        NodeAssert.equal(subscribes.length, 1);
        NodeAssert.ok(failNext !== null, "stream parked after the snapshot");
        // Kill the established stream while resubscribes still fail — the
        // status must drop to degraded and stay there across attempts.
        fail = true;
        await act(async () => {
          failNext(new Error("transport disconnected"));
          await sleep(10);
        });
        NodeAssert.equal(probeStatus, "degraded", "post-snapshot failure is not live");
        for (let i = 0; i < 3; i += 1) {
          await act(async () => {
            await sleep(10);
          });
          NodeAssert.equal(probeStatus, "degraded", "failed resubscribes stay unavailable");
        }
        fail = false;
        for (let i = 0; i < 10; i += 1) {
          if (probeStatus === "live") break;
          await act(async () => {
            await sleep(10);
          });
        }
        NodeAssert.ok(subscribes.length >= 3, "the dead stream was retried");
        NodeAssert.equal(probeStatus, "live");
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );

  NodeTest.it(
    "reports degraded while retries fail and recovers when the stream returns",
    async () => {
      const subscribes = [];
      let fail = true;
      const host = {
        subscribeApi(request, signal) {
          subscribes.push(request);
          if (fail) throw new Error("capability denied");
          return openStream(signal, [{ kind: "snapshot", mutationSeq: 4 }]);
        },
      };
      let probeStatus = "idle";
      function Probe() {
        const changes = useWorkspaceChanges(host, session, true, { retryMs: 5, errorRetryMs: 5 });
        React.useEffect(() => {
          probeStatus = changes.status;
        });
        return null;
      }
      // The detached retry loop's continuations are pumped across act
      // boundaries — each act lets pending timers resolve one step, so retry
      // progress is observed by driving acts, not by a single sleep window.
      let root;
      try {
        await act(async () => {
          root = create(e(Probe, {}));
          await sleep(10);
        });
        NodeAssert.equal(probeStatus, "degraded");
        fail = false;
        for (let i = 0; i < 10; i += 1) {
          if (probeStatus === "live") break;
          await act(async () => {
            await sleep(10);
          });
        }
        NodeAssert.ok(subscribes.length >= 2, "a failed attempt is retried");
        NodeAssert.equal(probeStatus, "live");
        NodeAssert.deepEqual(
          subscribes.at(-1).input,
          { threadId: "thread" },
          "retries resubscribe the same thread",
        );
      } finally {
        if (root) await act(async () => root.unmount());
      }
    },
  );
});
