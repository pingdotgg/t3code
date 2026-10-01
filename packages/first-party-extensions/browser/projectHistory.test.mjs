import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  createCommandDispatch,
  createRevisionFence,
  createProjectHistory,
  displayedHistory,
  projectHistoryErrorState,
  titleUpdate,
} from "./projectHistory.ts";
import { isLeaseUrl } from "./viewModel.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake bound API whose answers the test releases explicitly. */
function scriptedApi() {
  const calls = [];
  return {
    calls,
    invoke(method, input) {
      const answer = deferred();
      calls.push({ method, input, answer });
      return answer.promise;
    },
  };
}

/** Collects states; `next()` resolves on the next report — the receipt, never a sleep. */
function stateLog() {
  const states = [];
  let waiter = null;
  return {
    states,
    onState(state) {
      states.push(state);
      waiter?.resolve(state);
      waiter = null;
    },
    next() {
      waiter = deferred();
      return waiter.promise;
    },
  };
}

NodeTest.describe("createProjectHistory", () => {
  NodeTest.it("reports the project list, dropping corrupt entries", async () => {
    const api = scriptedApi();
    const log = stateLog();
    const history = createProjectHistory(api, new AbortController().signal, log.onState);
    history.refresh();
    NodeAssert.deepEqual(
      api.calls.map((call) => [call.method, call.input]),
      [["list", {}]],
    );
    const reported = log.next();
    api.calls[0].answer.resolve({
      entries: [
        { url: "https://b.test/", lastVisitedAt: 1 },
        { url: "https://a.test/", lastVisitedAt: 2, title: "A" },
        { url: 7, lastVisitedAt: 3 },
        { url: "https://no-time.test/", lastVisitedAt: "later" },
      ],
    });
    NodeAssert.deepEqual(await reported, {
      kind: "ready",
      entries: [
        { url: "https://a.test/", lastVisitedAt: 2, title: "A" },
        { url: "https://b.test/", lastVisitedAt: 1 },
      ],
      truncated: false,
    });
  });

  NodeTest.it("carries the host's truncation flag so the view can say so", async () => {
    const api = scriptedApi();
    const log = stateLog();
    const history = createProjectHistory(api, new AbortController().signal, log.onState);
    history.record("https://a.test/");
    const reported = log.next();
    api.calls[0].answer.resolve({
      entries: [{ url: "https://a.test/", lastVisitedAt: 2 }],
      truncated: true,
    });
    NodeAssert.deepEqual(await reported, {
      kind: "ready",
      entries: [{ url: "https://a.test/", lastVisitedAt: 2 }],
      truncated: true,
    });
  });

  NodeTest.it("sends each write with its own input", () => {
    const api = scriptedApi();
    const history = createProjectHistory(api, new AbortController().signal, () => {});
    history.record("https://a.test/");
    history.setTitle("https://a.test/", "A");
    history.remove("https://a.test/");
    NodeAssert.deepEqual(
      api.calls.map((call) => [call.method, call.input]),
      [
        ["record", { url: "https://a.test/" }],
        ["setTitle", { url: "https://a.test/", title: "A" }],
        ["remove", { url: "https://a.test/" }],
      ],
    );
  });

  NodeTest.it("keeps the latest-issued answer when an older one lands late", async () => {
    const api = scriptedApi();
    const log = stateLog();
    const history = createProjectHistory(api, new AbortController().signal, log.onState);
    history.refresh();
    history.record("https://new.test/");
    const reported = log.next();
    api.calls[1].answer.resolve({ entries: [{ url: "https://new.test/", lastVisitedAt: 5 }] });
    await reported;
    api.calls[0].answer.resolve({ entries: [] });
    // The stale list answer settles without a report; a later op still reports.
    await api.calls[0].answer.promise;
    history.refresh();
    const again = log.next();
    api.calls[2].answer.resolve({ entries: [{ url: "https://new.test/", lastVisitedAt: 5 }] });
    await again;
    NodeAssert.equal(log.states.length, 2);
    NodeAssert.deepEqual(
      log.states.map((state) => state.entries.map((entry) => entry.url)),
      [["https://new.test/"], ["https://new.test/"]],
    );
  });

  NodeTest.it("reports nothing after the view's signal aborts", async () => {
    const api = scriptedApi();
    const log = stateLog();
    const controller = new AbortController();
    const history = createProjectHistory(api, controller.signal, log.onState);
    history.refresh();
    controller.abort();
    api.calls[0].answer.resolve({ entries: [] });
    await api.calls[0].answer.promise;
    NodeAssert.deepEqual(log.states, []);
  });

  NodeTest.it("names a denied grant or a missing provider", async () => {
    const api = scriptedApi();
    const log = stateLog();
    const history = createProjectHistory(api, new AbortController().signal, log.onState);
    history.record("https://a.test/");
    const denied = log.next();
    api.calls[0].answer.reject(new Error("API capability denied: t3.browser/record-history"));
    NodeAssert.deepEqual(await denied, {
      kind: "unavailable",
      message:
        "Showing this view's history only — Needs permission t3.browser/record-history. Grant it in Settings → Extensions.",
    });
    history.refresh();
    const missing = log.next();
    api.calls[1].answer.reject(
      new Error("client-provider-unavailable: No connected client registered this provider."),
    );
    const state = await missing;
    NodeAssert.equal(state.kind, "unavailable");
    NodeAssert.match(state.message, /project history is unavailable \(client-provider-unavailable/);
  });
});

NodeTest.describe("projectHistoryErrorState", () => {
  NodeTest.it("falls back to the op's grant when the denial names none", () => {
    NodeAssert.match(
      projectHistoryErrorState("list", new Error("capability denied")).message,
      /Needs permission t3\.browser\/read-history\./,
    );
  });
});

NodeTest.describe("displayedHistory", () => {
  const own = [{ url: "https://own.test/", lastVisitedAt: 1 }];
  NodeTest.it("shows the view's own rows until the project list arrives or when it cannot", () => {
    NodeAssert.equal(displayedHistory({ kind: "loading" }, own), own);
    NodeAssert.equal(displayedHistory({ kind: "unavailable", message: "x" }, own), own);
  });
  NodeTest.it("shows the project list once ready, even when it is empty", () => {
    NodeAssert.deepEqual(
      displayedHistory({ kind: "ready", entries: [], truncated: false }, own),
      [],
    );
  });
});

NodeTest.describe("createCommandDispatch", () => {
  const fenceAt = (revision) => ({ ...createRevisionFence(), epoch: "epoch-a", revision });

  /**
   * The view's `dispatch`, recording through a real `createProjectHistory`
   * the way `submit` wires `go(url, () => projectHistory.record(url))`.
   * `send` returns the pending receipt; awaiting it resumes after dispatch's
   * own settle handler, which was registered first. Receipts default to the
   * fence's epoch.
   */
  function dispatchHarness(fence) {
    const api = scriptedApi();
    const session = new AbortController();
    const history = createProjectHistory(api, session.signal, () => {});
    const effects = [];
    const dispatch = createCommandDispatch({
      signal: session.signal,
      fence,
      adopt: (receipt) => effects.push(["adopt", receipt.revision]),
      refuse: (outcome) => effects.push(["refuse", outcome]),
      fail: (error) => effects.push(["fail", error.message]),
    });
    const send = (url) => {
      const receipt = deferred();
      dispatch(() => receipt.promise, url ? () => history.record(url) : undefined);
      return {
        ...receipt,
        resolve: (value) => receipt.resolve({ serverEpoch: "epoch-a", ...value }),
      };
    };
    const records = () => api.calls.filter((call) => call.method === "record");
    return { send, effects, records, session };
  }

  NodeTest.it(
    "records an accepted visit once when the stream already applied a newer page",
    async () => {
      const fence = fenceAt(4);
      const { send, effects, records } = dispatchHarness(fence);
      const navigate = send("https://typed.test/");
      // The events stream's upsert at revision 6 lands before the navigate receipt at 5.
      fence.revision = 6;
      navigate.resolve({ revision: 5, outcome: "accepted" });
      await navigate.promise;
      NodeAssert.deepEqual(effects, []);
      NodeAssert.equal(fence.revision, 6);
      NodeAssert.deepEqual(
        records().map((call) => call.input),
        [{ url: "https://typed.test/" }],
      );
    },
  );

  NodeTest.it("adopts a current receipt and records once", async () => {
    const fence = fenceAt(4);
    const { send, effects, records } = dispatchHarness(fence);
    const navigate = send("https://typed.test/");
    navigate.resolve({ revision: 5, outcome: "accepted" });
    await navigate.promise;
    NodeAssert.deepEqual(effects, [["adopt", 5]]);
    NodeAssert.equal(fence.revision, 5);
    NodeAssert.equal(records().length, 1);
  });

  NodeTest.it("never records a refused command, and a stale refusal stays silent", async () => {
    const fence = fenceAt(4);
    const { send, effects, records } = dispatchHarness(fence);
    const current = send("https://typed.test/");
    const stale = send("https://typed.test/");
    current.resolve({ revision: 5, outcome: "rejected" });
    stale.resolve({ revision: 3, outcome: "rejected" });
    await Promise.all([current.promise, stale.promise]);
    NodeAssert.deepEqual(effects, [["refuse", "rejected"]]);
    NodeAssert.equal(records().length, 0);
  });

  NodeTest.it("orders receipts by revision only within the server epoch", async () => {
    // The stream last saw revision 40 of epoch-a; the server then restarted.
    const fence = fenceAt(40);
    const { send, effects } = dispatchHarness(fence);
    const old = send();
    old.resolve({ revision: 39, outcome: "accepted", serverEpoch: "epoch-a" });
    await old.promise;
    // The restarted server's open receipt counts from 1 again and still lands.
    const reopened = send();
    reopened.resolve({ revision: 2, outcome: "accepted", serverEpoch: "epoch-b" });
    await reopened.promise;
    NodeAssert.deepEqual(effects, [["adopt", 2]]);
    NodeAssert.equal(fence.revision, 2);
  });

  NodeTest.it("keeps the (epoch, revision) fence monotonic after a restart", async () => {
    // The stream still holds epoch-a at 40; two receipts from the restarted
    // server land out of order before its snapshot does.
    const fence = fenceAt(40);
    const { send, effects } = dispatchHarness(fence);
    const newer = send();
    const older = send();
    newer.resolve({ revision: 3, outcome: "accepted", serverEpoch: "epoch-b" });
    await newer.promise;
    older.resolve({ revision: 2, outcome: "accepted", serverEpoch: "epoch-b" });
    await older.promise;
    // A late result from the retired server never lands either.
    const retired = send();
    retired.resolve({ revision: 41, outcome: "accepted", serverEpoch: "epoch-a" });
    await retired.promise;
    NodeAssert.deepEqual(effects, [["adopt", 3]]);
    NodeAssert.deepEqual([fence.epoch, fence.revision], ["epoch-b", 3]);
  });

  NodeTest.it("keeps an older refusal from the restarted server silent", async () => {
    const fence = fenceAt(40);
    const { send, effects } = dispatchHarness(fence);
    const newer = send();
    const older = send();
    newer.resolve({ revision: 3, outcome: "accepted", serverEpoch: "epoch-b" });
    await newer.promise;
    older.resolve({ revision: 2, outcome: "rejected", serverEpoch: "epoch-b" });
    await older.promise;
    NodeAssert.deepEqual(effects, [["adopt", 3]]);
    NodeAssert.equal(fence.revision, 3);
  });

  NodeTest.it("settles nothing once the view session ends, and reports live failures", async () => {
    const fence = fenceAt(4);
    const { send, effects, records, session } = dispatchHarness(fence);
    const failed = send("https://typed.test/");
    failed.reject(new Error("offline"));
    await failed.promise.catch(() => {});
    const late = send("https://typed.test/");
    session.abort();
    late.resolve({ revision: 5, outcome: "accepted" });
    await late.promise;
    NodeAssert.deepEqual(effects, [["fail", "offline"]]);
    NodeAssert.equal(fence.revision, 4);
    NodeAssert.equal(records().length, 0);
  });
});

NodeTest.describe("titleUpdate", () => {
  const loaded = { kind: "loaded", url: "https://a.test/", title: "A" };
  NodeTest.it("writes back a loaded page's title", () => {
    NodeAssert.deepEqual(titleUpdate(loaded, false, isLeaseUrl), {
      url: "https://a.test/",
      title: "A",
    });
  });
  NodeTest.it("skips unloaded pages, blank titles, and workspace-file presentations", () => {
    NodeAssert.equal(titleUpdate({ ...loaded, kind: "loading" }, false, isLeaseUrl), null);
    NodeAssert.equal(titleUpdate({ ...loaded, title: "  " }, false, isLeaseUrl), null);
    NodeAssert.equal(titleUpdate(loaded, true, isLeaseUrl), null);
    NodeAssert.equal(titleUpdate(null, false, isLeaseUrl), null);
    NodeAssert.equal(
      titleUpdate(loaded, false, () => true),
      null,
    );
  });
});
