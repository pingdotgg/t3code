import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createFaviconReadQueue } from "./faviconReads.ts";
import {
  MAX_FAVICON_READS,
  emptyFaviconCache,
  pendingFaviconRefs,
  recordResolvedFaviconRef,
  resolveFavicon,
} from "./faviconStore.ts";

const icon = (ref) => `data:image/png;base64,${Buffer.from(ref).toString("base64")}`;

const restoredTabs = (count) =>
  Array.from({ length: count }, (_, index) => ({
    tabId: `tab-${index}`,
    faviconRef: `r${index}`,
    navigation: { kind: "loaded", url: `http://localhost:${3000 + index}/`, title: "" },
  }));

/** A read that completes only when the test releases it, one at a time, out of order. */
function controlledReads() {
  const waiting = [];
  let started = 0;
  const read = (ref, signal) =>
    new Promise((resolve, reject) => {
      started += 1;
      waiting.push({ ref, resolve: () => resolve(icon(ref)) });
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  return {
    read,
    started: () => started,
    releaseOne: async () => {
      waiting.splice(waiting.length % 2 === 0 ? 0 : waiting.length - 1, 1)[0]?.resolve();
      // Let the read's continuation (settle, then start the next) run.
      for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    },
    waiting: () => waiting.length,
  };
}

function panel() {
  let cache = emptyFaviconCache();
  const queue = createFaviconReadQueue({
    maxInFlight: MAX_FAVICON_READS,
    settle: (ref, src) => {
      cache = recordResolvedFaviconRef(cache, ref, src, 1);
    },
  });
  return { queue, cache: () => cache };
}

NodeTest.describe("createFaviconReadQueue", () => {
  for (const count of [9, 20, 100]) {
    NodeTest.it(`reads all ${count} restored tabs from one snapshot, ≤8 at a time`, async () => {
      const { queue, cache } = panel();
      const reads = controlledReads();
      const tabs = restoredTabs(count);
      // One snapshot, no later session event.
      queue.request(pendingFaviconRefs(cache(), tabs), reads.read, new AbortController().signal);
      let peak = queue.inFlight();
      while (reads.waiting() > 0) {
        await reads.releaseOne();
        peak = Math.max(peak, queue.inFlight());
      }
      NodeAssert.equal(peak, Math.min(count, MAX_FAVICON_READS));
      NodeAssert.equal(reads.started(), count);
      NodeAssert.equal(queue.inFlight(), 0);
      NodeAssert.deepEqual(pendingFaviconRefs(cache(), tabs), []);
      for (const tab of tabs)
        NodeAssert.equal(
          resolveFavicon(cache(), tab.navigation.url, tab.faviconRef).src,
          icon(tab.faviconRef),
        );
    });
  }

  NodeTest.it("serves a second view's demand while every slot is busy", async () => {
    const { queue, cache } = panel();
    const reads = controlledReads();
    const tabs = restoredTabs(MAX_FAVICON_READS);
    queue.request(pendingFaviconRefs(cache(), tabs), reads.read, new AbortController().signal);
    queue.request(["late"], reads.read, new AbortController().signal);
    NodeAssert.equal(reads.started(), MAX_FAVICON_READS);
    while (reads.waiting() > 0) await reads.releaseOne();
    NodeAssert.equal(cache().resolved.late.src, icon("late"));
  });

  NodeTest.it("drops a closed view's queued demand and re-reads it for a live view", async () => {
    const { queue, cache } = panel();
    const reads = controlledReads();
    const closed = new AbortController();
    queue.request(
      restoredTabs(MAX_FAVICON_READS + 2).map((tab) => tab.faviconRef),
      reads.read,
      closed.signal,
    );
    closed.abort();
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    // Cancelled reads are not recorded, and nothing queued behind them starts.
    NodeAssert.equal(reads.started(), MAX_FAVICON_READS);
    NodeAssert.equal(queue.inFlight(), 0);
    NodeAssert.deepEqual(cache().resolved, {});

    const live = new AbortController();
    queue.request(["r0", "r9"], reads.read, live.signal);
    while (reads.waiting() > 0) await reads.releaseOne();
    NodeAssert.equal(cache().resolved.r0.src, icon("r0"));
    NodeAssert.equal(cache().resolved.r9.src, icon("r9"));
  });

  NodeTest.it("keeps a queued ref for a live view when a later requester closes", async () => {
    const { queue, cache } = panel();
    const reads = controlledReads();
    const first = new AbortController();
    const refs = restoredTabs(MAX_FAVICON_READS + 1).map((tab) => tab.faviconRef);
    queue.request(refs, reads.read, first.signal);
    const second = new AbortController();
    queue.request([refs.at(-1)], reads.read, second.signal);
    second.abort();
    while (reads.waiting() > 0) await reads.releaseOne();
    NodeAssert.equal(reads.started(), refs.length);
    NodeAssert.equal(cache().resolved[refs.at(-1)].src, icon(refs.at(-1)));
  });

  NodeTest.it("aborts a running read only once every requesting view closes", async () => {
    const { queue, cache } = panel();
    const reads = controlledReads();
    const first = new AbortController();
    const second = new AbortController();
    queue.request(["shared"], reads.read, first.signal);
    queue.request(["shared"], reads.read, second.signal);
    first.abort();
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    NodeAssert.equal(queue.inFlight(), 1);
    await reads.releaseOne();
    NodeAssert.equal(reads.started(), 1);
    NodeAssert.equal(cache().resolved.shared.src, icon("shared"));

    queue.request(["closing"], reads.read, second.signal);
    second.abort();
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    NodeAssert.equal(queue.inFlight(), 0);
    NodeAssert.equal(cache().resolved.closing, undefined);
  });

  NodeTest.it("records a failed read once and never reads a settled ref again", async () => {
    const settled = [];
    const queue = createFaviconReadQueue({
      maxInFlight: MAX_FAVICON_READS,
      settle: (ref, src) => settled.push([ref, src]),
    });
    let started = 0;
    const failing = () => {
      started += 1;
      return Promise.reject(new Error("BrowserFaviconNotFound"));
    };
    const signal = new AbortController().signal;
    queue.request(["gone"], failing, signal);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    // Even after the cache ages the result out, the ref is not re-read.
    queue.request(["gone"], failing, signal);
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
    NodeAssert.equal(started, 1);
    NodeAssert.deepEqual(settled, [["gone", null]]);
  });
});
