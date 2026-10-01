import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodeTest from "node:test";

import { bindApi } from "@t3tools/extension-sdk/capabilities";
import { uiNotificationsApi } from "@t3tools/extension-sdk/catalogue";

import {
  annotationControl,
  captureOutcomeMessage,
  captureOutcomeToast,
  capturePageView,
  captureToastActions,
  captureToChat,
  captureUnavailableReason,
  reportCaptureOutcome,
  runBrowserCapture,
  runCaptureToastAction,
  useBrowserCapture,
} from "./capture.ts";

const require = NodeModule.createRequire(new URL(".", import.meta.url));
const React = require("react");
const { act, create } = require("react-test-renderer");
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ARTIFACT_REF = "pending-0f1e2d3c-4b5a-4968-8776-655443322110";
const held = { tabId: "tab-1", serverEpoch: "epoch-1" };
const context = {
  client: "desktop",
  resource: {
    namespace: "t3.browser",
    id: "view",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
};

NodeTest.test(
  "annotation capability discovery is cached and local capture mode needs no crop upload",
  async () => {
    let discoveries = 0;
    const host = fakeHost({
      capture: async (request) => {
        NodeAssert.equal(request.annotation, true);
        return { ok: true, artifact: null, annotationRef: "native-ref" };
      },
    });
    host.browserCapture.version = "1.3.0";
    host.discoverApis = async () => {
      discoveries += 1;
      return [{ id: "t3.composer/context", version: "1.3.0" }];
    };
    const scope = { ...context, resource: { ...context.resource, id: "cached-view" } };
    for (let pick = 0; pick < 2; pick += 1)
      NodeAssert.equal(
        (await captureToChat(host, scope, held, "element", new AbortController().signal)).kind,
        "annotated",
      );
    NodeAssert.equal(discoveries, 1);
  },
);
const artifact = {
  artifactRef: ARTIFACT_REF,
  mimeType: "image/png",
  sizeBytes: 10,
  width: 1280,
  height: 800,
  target: "page",
  pageUrl: "http://localhost:5173/",
  pageTitle: "Home",
};

function fakeHost({ capture, insert } = {}) {
  const calls = { capture: [], invoke: [] };
  return {
    calls,
    browserCapture: {
      id: "t3.browser/capture",
      version: "1.0.0",
      support: { supported: true },
      async capture(request) {
        calls.capture.push(request);
        return capture ? capture(request) : { ok: true, artifact };
      },
    },
    async invokeApi(request) {
      calls.invoke.push(request);
      return insert ? insert(request) : { inserted: true, target: "env-a:thread-a" };
    },
  };
}

NodeTest.test(
  "element picks insert the native annotation and crop in one composer operation",
  async () => {
    const host = fakeHost({
      capture: async () => ({
        ok: true,
        artifact: { ...artifact, target: "element" },
        annotationRef: "annotation-ref",
      }),
      insert: async () => ({
        inserted: true,
        imageInserted: true,
        screenshotFailed: false,
        target: "env-a:thread-a",
      }),
    });
    host.discoverApis = async () => [{ id: "t3.composer/context", version: "1.3.0" }];
    const outcome = await captureToChat(
      host,
      context,
      held,
      "element",
      new AbortController().signal,
    );
    NodeAssert.equal(host.calls.invoke.length, 1);
    NodeAssert.equal(host.calls.invoke[0].method, "insertPreviewAnnotation");
    NodeAssert.deepEqual(host.calls.invoke[0].input, {
      threadId: "thread-a",
      annotationRef: "annotation-ref",
    });
    NodeAssert.equal(outcome.kind, "annotated");
  },
);

NodeTest.test(
  "a lost crop keeps the annotation and reports native's image-loss toast",
  async () => {
    const host = fakeHost({
      capture: async () => ({
        ok: false,
        annotationRef: "annotation-ref",
        failure: { reason: "capture-failed", detail: "no crop" },
      }),
      insert: async () => ({
        inserted: true,
        imageInserted: false,
        screenshotFailed: true,
        target: "env-a:thread-a",
      }),
    });
    host.discoverApis = async () => [{ id: "t3.composer/context", version: "1.3.0" }];
    const outcome = await captureToChat(
      host,
      context,
      held,
      "element",
      new AbortController().signal,
    );
    NodeAssert.equal(outcome.kind, "annotated");
    NodeAssert.equal(
      captureOutcomeToast("element", outcome)?.body,
      "The annotation was kept without the screenshot.",
    );
  },
);

NodeTest.describe("captureUnavailableReason", () => {
  NodeTest.it("names each missing precondition", () => {
    const host = fakeHost();
    NodeAssert.match(captureUnavailableReason(host, held, undefined), /no thread/);
    NodeAssert.match(captureUnavailableReason({}, held, "thread-a"), /cannot capture/);
    NodeAssert.match(
      captureUnavailableReason(
        { browserCapture: { support: { supported: false, reason: "desktop-required" } } },
        held,
        "thread-a",
      ),
      /desktop app/,
    );
    NodeAssert.match(captureUnavailableReason(host, null, "thread-a"), /Open a page/);
    NodeAssert.match(captureUnavailableReason(host, held, "thread-a", "hidden"), /not shown here/);
    NodeAssert.equal(
      captureUnavailableReason(host, held, "thread-a", "failed"),
      "Page didn't load — pick unavailable until the page renders",
    );
    NodeAssert.equal(captureUnavailableReason(host, held, "thread-a"), null);
  });
});

NodeTest.describe("capturePageView", () => {
  const active = { state: { kind: "active", presentation: { supported: true } } };
  NodeTest.it("counts the page shown only while its slot presents it visible", () => {
    NodeAssert.equal(capturePageView(active, true, "loaded"), "shown");
    // An active lease stays active while present(..., false) hides it.
    NodeAssert.equal(capturePageView(active, false, "loaded"), "hidden");
    NodeAssert.equal(capturePageView(null, true, "loaded"), "hidden");
    NodeAssert.equal(
      capturePageView(
        { state: { kind: "active", presentation: { supported: false, reason: "x" } } },
        true,
        "loaded",
      ),
      "hidden",
    );
    NodeAssert.equal(capturePageView(active, true, "failed"), "failed");
  });
});

NodeTest.describe("captureToChat", () => {
  NodeTest.it("inserts the captured artifactRef into this thread's draft", async () => {
    const host = fakeHost();
    const outcome = await captureToChat(host, context, held, "page", new AbortController().signal);
    NodeAssert.deepEqual(outcome, { kind: "added", artifact, inserted: true });
    NodeAssert.deepEqual(host.calls.capture[0].session, held);
    NodeAssert.equal(host.calls.capture[0].target, "page");
    const invoke = host.calls.invoke[0];
    NodeAssert.equal(invoke.id, "t3.composer/context");
    NodeAssert.equal(invoke.versionRange, "^1.2.0");
    NodeAssert.equal(invoke.method, "insertImage");
    // Only the ref crosses to the composer — never pixels.
    NodeAssert.deepEqual(invoke.input, { threadId: "thread-a", artifactRef: ARTIFACT_REF });
    NodeAssert.equal(captureOutcomeMessage("page", outcome), "Page screenshot added to chat.");
  });

  NodeTest.it("stays quiet on a dismissed picker and never inserts", async () => {
    const host = fakeHost({
      capture: () => ({ ok: false, failure: { reason: "cancelled", detail: "dismissed" } }),
    });
    const outcome = await captureToChat(
      host,
      context,
      held,
      "element",
      new AbortController().signal,
    );
    NodeAssert.deepEqual(outcome, { kind: "cancelled" });
    NodeAssert.equal(captureOutcomeMessage("element", outcome), null);
    NodeAssert.equal(host.calls.invoke.length, 0);
  });

  NodeTest.it("reports capture failures by reason and grant", async () => {
    const host = fakeHost({
      capture: () => ({
        ok: false,
        failure: { reason: "grant-denied", detail: "needs grant", grant: "t3.browser/capture" },
      }),
    });
    const outcome = await captureToChat(host, context, held, "page", new AbortController().signal);
    NodeAssert.equal(outcome.stage, "request");
    NodeAssert.equal(
      captureOutcomeMessage("page", outcome),
      "Capture failed — Needs permission t3.browser/capture. Grant it in Settings → Extensions.",
    );
    NodeAssert.equal(host.calls.invoke.length, 0);
  });

  NodeTest.it("tells a lost image apart from a picker that failed", async () => {
    const run = (failure) =>
      captureToChat(
        fakeHost({ capture: () => ({ ok: false, failure }) }),
        context,
        held,
        "element",
        new AbortController().signal,
      );
    for (const reason of ["capture-failed", "too-large", "upload-failed"])
      NodeAssert.equal((await run({ reason, detail: "x" })).stage, "image");
    for (const reason of ["not-presented", "busy", "epoch-changed", "session-invalid"])
      NodeAssert.equal((await run({ reason, detail: "x" })).stage, "request");
    const threw = await captureToChat(
      fakeHost({
        capture: () => {
          throw new Error("webview navigated");
        },
      }),
      context,
      held,
      "element",
      new AbortController().signal,
    );
    NodeAssert.equal(threw.kind, "failed");
    NodeAssert.equal(threw.stage, "request");
  });

  NodeTest.it("stays quiet when cancelled after the image was stored", async () => {
    const cancel = new AbortController();
    const host = fakeHost({
      capture: () => {
        cancel.abort();
        return { ok: true, artifact };
      },
    });
    const outcome = await captureToChat(host, context, held, "element", cancel.signal);
    NodeAssert.deepEqual(outcome, { kind: "cancelled" });
    NodeAssert.equal(host.calls.invoke.length, 0);
  });

  NodeTest.it("says the capture exists when the composer refuses it", async () => {
    const host = fakeHost({
      insert: () => {
        throw new Error("client-provider-unsupported-version");
      },
    });
    const outcome = await captureToChat(host, context, held, "page", new AbortController().signal);
    NodeAssert.equal(outcome.kind, "failed");
    NodeAssert.equal(outcome.stage, "insert");
    NodeAssert.match(
      captureOutcomeMessage("page", outcome),
      /^Captured, but it could not be added to chat/,
    );
  });

  NodeTest.it("reports an element capture already in the draft", () => {
    NodeAssert.equal(
      captureOutcomeMessage("element", {
        kind: "added",
        artifact: { ...artifact, target: "element" },
        inserted: false,
      }),
      "Element capture is already in chat.",
    );
  });
});

const failed = {
  kind: "failed",
  stage: "request",
  message: "Capture failed — engine-error: tab gone",
};
const cropLost = {
  kind: "failed",
  stage: "image",
  message: "Capture failed — capture-failed: the picker kept no crop",
};
const pageAdded = { kind: "added", artifact, inserted: true };
/** A page capture the desktop saved, so the artifact actions can act on it. */
const savedPage = { kind: "added", artifact: { ...artifact, saved: true }, inserted: true };
const elementAdded = {
  kind: "added",
  artifact: { ...artifact, target: "element" },
  inserted: true,
};

NodeTest.describe("captureOutcomeToast", () => {
  NodeTest.it("uses native's screenshot titles and lifetime for page outcomes", () => {
    NodeAssert.deepEqual(captureOutcomeToast("page", pageAdded), {
      severity: "success",
      title: "Screenshot saved",
      durationMs: 5_000,
    });
    NodeAssert.deepEqual(captureOutcomeToast("page", failed), {
      severity: "error",
      title: "Unable to capture screenshot",
      body: failed.message,
      durationMs: 5_000,
    });
  });

  NodeTest.it("toasts a pick only when it loses its image, like native", () => {
    NodeAssert.deepEqual(captureOutcomeToast("element", cropLost), {
      severity: "error",
      title: "Could not capture the picked element",
      body: cropLost.message,
      durationMs: 5_000,
    });
    NodeAssert.deepEqual(
      captureOutcomeToast("element", { ...cropLost, stage: "insert" })?.title,
      "Could not capture the picked element",
    );
    NodeAssert.equal(captureOutcomeToast("element", elementAdded), null);
  });

  NodeTest.it("keeps a refused pick on the status line, where native has no toast", () => {
    NodeAssert.equal(captureOutcomeToast("element", failed), null);
    NodeAssert.equal(captureOutcomeMessage("element", failed), failed.message);
  });

  NodeTest.it("stays silent on a cancel", () => {
    NodeAssert.equal(captureOutcomeToast("page", { kind: "cancelled" }), null);
    NodeAssert.equal(captureOutcomeToast("element", { kind: "cancelled" }), null);
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A notifications client whose answer the test settles, or that never answers. */
function notifier(answer, range) {
  const calls = [];
  const client = {
    invokeApi: (request, signal) => {
      calls.push(request);
      if (answer === "hang")
        return new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason)),
        );
      if (answer instanceof Error) return Promise.reject(answer);
      if (answer && typeof answer.then === "function") return answer;
      return Promise.resolve(answer);
    },
  };
  return { calls, client, api: bindApi(uiNotificationsApi, client, context, range) };
}

NodeTest.describe("reportCaptureOutcome", () => {
  const signal = new AbortController().signal;

  NodeTest.it("toasts on this thread and owes no status line", async () => {
    const { calls, api } = notifier({ notificationId: "n-1" });
    const report = reportCaptureOutcome(api, "thread-a", "page", failed, signal);
    NodeAssert.equal(report.inline, null);
    NodeAssert.equal(await report.fallback, null);
    NodeAssert.equal(calls.length, 1);
    NodeAssert.equal(calls[0].id, "t3.ui/notifications");
    NodeAssert.equal(calls[0].method, "notify");
    NodeAssert.deepEqual(calls[0].input, {
      severity: "error",
      title: "Unable to capture screenshot",
      body: failed.message,
      durationMs: 5_000,
      threadId: "thread-a",
      anchor: "thread",
    });
  });

  NodeTest.it("falls back to the status line when notify definitely failed", async () => {
    const { calls, api } = notifier(new Error("grant t3.ui/notify missing"));
    const report = reportCaptureOutcome(api, "thread-a", "page", pageAdded, signal);
    NodeAssert.equal(report.inline, null);
    NodeAssert.equal(await report.fallback, "Page screenshot added to chat.");
    NodeAssert.equal(calls.length, 1);
  });

  NodeTest.it("does not report twice when notify's ack times out", async () => {
    const { calls, api } = notifier("hang");
    const report = reportCaptureOutcome(api, "thread-a", "page", pageAdded, signal, 0);
    NodeAssert.equal(await report.fallback, null);
    NodeAssert.equal(calls.length, 1);
  });

  NodeTest.it("keeps untoasted outcomes on the status line without notifying", async () => {
    const { calls, api } = notifier({ notificationId: "n-1" });
    NodeAssert.equal(
      reportCaptureOutcome(api, "thread-a", "element", elementAdded, signal).inline,
      "Element capture added to chat.",
    );
    NodeAssert.equal(
      reportCaptureOutcome(api, "thread-a", "page", { kind: "cancelled" }, signal).inline,
      null,
    );
    NodeAssert.equal(calls.length, 0);
  });
});

NodeTest.describe("runBrowserCapture", () => {
  const session = { context, signal: new AbortController().signal };
  const hostWithNotify = (answer) => {
    const host = fakeHost({
      capture: () => ({
        ok: false,
        failure: { reason: "capture-failed", detail: "engine lost it" },
      }),
    });
    const notify = notifier(answer);
    return { host: { ...host, invokeApi: notify.client.invokeApi }, calls: notify.calls };
  };

  NodeTest.it("releases capture state before notify settles", async () => {
    const pending = deferred();
    const { host, calls } = hostWithNotify(pending.promise);
    const states = [];
    const run = runBrowserCapture(
      host,
      session,
      held,
      "page",
      () => true,
      (s) => states.push(s),
    );
    await Promise.race([run, new Promise((resolve) => setImmediate(resolve))]);
    // notify is still pending, yet the buttons are already free.
    NodeAssert.equal(calls.length, 1);
    NodeAssert.deepEqual(states, [
      { kind: "capturing", target: "page" },
      { kind: "done", message: null },
    ]);
    pending.reject(new Error("provider-unavailable"));
    await run;
    NodeAssert.equal(states.length, 3);
    NodeAssert.match(states[2].message, /engine lost it/);
  });

  for (const [reason, detail, grant] of [
    ["grant-denied", "t3.browser/capture requires the grant.", "t3.browser/capture"],
    ["busy", "Another capture of this session is still running.", undefined],
    ["not-presented", "The session is not shown on this client.", undefined],
  ])
    NodeTest.it(`explains a pick the host refused (${reason}) on the status line`, async () => {
      const refused = fakeHost({
        capture: () => ({
          ok: false,
          failure: { reason, detail, ...(grant ? { grant } : {}) },
        }),
      });
      const notify = notifier({ notificationId: "n-1" });
      const states = [];
      await runBrowserCapture(
        { ...refused, invokeApi: notify.client.invokeApi },
        session,
        held,
        "element",
        () => true,
        (s) => states.push(s),
      );
      NodeAssert.equal(states.length, 2);
      NodeAssert.equal(states[1].kind, "done");
      // A named grant is the fix to show; otherwise the reason and the host's detail.
      if (grant)
        NodeAssert.equal(
          states[1].message,
          "Capture failed — Needs permission t3.browser/capture. Grant it in Settings → Extensions.",
        );
      else {
        NodeAssert.match(states[1].message, new RegExp(`^Capture failed — ${reason}`));
        NodeAssert.ok(states[1].message.endsWith(detail));
      }
      // No toast (native raises none for a pick) and no insert: no host API was invoked.
      NodeAssert.equal(notify.calls.length, 0);
    });

  NodeTest.it("cancel dismisses an open picker silently", async () => {
    const opened = deferred();
    const host = fakeHost({
      capture: (request) =>
        new Promise((resolve) => {
          opened.resolve();
          request.signal.addEventListener("abort", () =>
            resolve({ ok: false, failure: { reason: "cancelled", detail: "dismissed" } }),
          );
        }),
    });
    const cancel = new AbortController();
    const states = [];
    const run = runBrowserCapture(
      host,
      session,
      held,
      "element",
      () => true,
      (s) => states.push(s),
      undefined,
      cancel.signal,
    );
    await opened.promise;
    cancel.abort();
    await run;
    NodeAssert.deepEqual(states, [
      { kind: "capturing", target: "element" },
      { kind: "done", message: null },
    ]);
    NodeAssert.equal(host.calls.invoke.length, 0);
  });

  NodeTest.it("drops a fallback once a newer run has started", async () => {
    const pending = deferred();
    const { host } = hostWithNotify(pending.promise);
    const states = [];
    let current = true;
    const run = runBrowserCapture(
      host,
      session,
      held,
      "page",
      () => current,
      (s) => states.push(s),
    );
    await Promise.race([run, new Promise((resolve) => setImmediate(resolve))]);
    current = false;
    pending.reject(new Error("provider-unavailable"));
    await run;
    NodeAssert.deepEqual(states, [
      { kind: "capturing", target: "page" },
      { kind: "done", message: null },
    ]);
  });
});

const supported = { supported: true };
const desktopOnly = { supported: false, reason: "desktop-required" };

/** A host's API discovery naming this t3.ui/notifications version. */
const discovering = (version) => async () => [
  {
    id: "t3.ui/notifications",
    version,
    providerId: "host.ui.notifications",
    generation: 1,
    health: "ready",
    selected: true,
  },
];

/** A 1.1.0 capture host whose artifact actions record their calls. */
function actionCapture({ support = supported, results = {} } = {}) {
  const calls = [];
  const run = (name) => async (request) => {
    calls.push([name, request]);
    return results[name] ?? { ok: true };
  };
  return {
    calls,
    artifactActions: {
      copyImage: support,
      copyPath: support,
      reveal: support,
      revealLabel: "Reveal in Finder",
    },
    copyArtifactToClipboard: run("copyImage"),
    copyArtifactPath: run("copyPath"),
    revealArtifact: run("reveal"),
  };
}

NodeTest.describe("Screenshot saved actions", () => {
  const signal = new AbortController().signal;
  const request = { context, artifactRef: ARTIFACT_REF };

  NodeTest.it("offers native's three actions in native's order, all keeping the toast", () => {
    NodeAssert.deepEqual(captureToastActions(actionCapture()), [
      { id: "copy-path", label: "Copy path", keepOpen: true },
      { id: "reveal", label: "Reveal in Finder", keepOpen: true },
      { id: "copy-image", label: "Copy image", variant: "primary", keepOpen: true },
    ]);
    NodeAssert.deepEqual(
      captureOutcomeToast("page", pageAdded, captureToastActions(actionCapture())).actions.length,
      3,
    );
  });

  NodeTest.it("hides actions a client or an older host cannot run", () => {
    NodeAssert.deepEqual(captureToastActions(actionCapture({ support: desktopOnly })), []);
    NodeAssert.deepEqual(captureToastActions(fakeHost().browserCapture), []);
    NodeAssert.deepEqual(captureToastActions(null), []);
    // Failures and picks never carry them.
    NodeAssert.equal(
      captureOutcomeToast("page", failed, captureToastActions(actionCapture())).actions,
      undefined,
    );
  });

  NodeTest.it(
    "flashes Copied! for 2 s on a restored success toast after a copy lands",
    async () => {
      const capture = actionCapture();
      const { calls, api } = notifier({ applied: true }, "^1.1.0");
      await runCaptureToastAction(api, capture, request, "n-1", "copy-image", signal);
      await runCaptureToastAction(api, capture, request, "n-1", "copy-path", signal);
      NodeAssert.deepEqual(
        capture.calls.map(([name]) => name),
        ["copyImage", "copyPath"],
      );
      NodeAssert.deepEqual(capture.calls[0][1], request);
      NodeAssert.deepEqual(
        calls.map((call) => [call.method, call.input]),
        ["copy-image", "copy-path"].map((actionId) => [
          "update",
          {
            notificationId: "n-1",
            severity: "success",
            title: "Screenshot saved",
            body: "",
            flashAction: { actionId, label: "Copied!", durationMs: 2_000 },
          },
        ]),
      );
    },
  );

  NodeTest.it("turns the toast into native's error when a copy fails", async () => {
    // Whatever the host says, the toast body is the pack's own path-free line.
    const failure = {
      ok: false,
      failure: {
        reason: "action-failed",
        detail: "could not load /Users/me/.t3/browser-artifacts/browser-screenshot-x.png",
      },
    };
    const capture = actionCapture({ results: { copyImage: failure, copyPath: failure } });
    const { calls, api } = notifier({ applied: true });
    await runCaptureToastAction(api, capture, request, "n-1", "copy-image", signal);
    await runCaptureToastAction(api, capture, request, "n-1", "copy-path", signal);
    NodeAssert.deepEqual(
      calls.map((call) => call.input),
      [
        {
          notificationId: "n-1",
          severity: "error",
          title: "Unable to copy screenshot",
          body: "The saved screenshot could not be copied.",
        },
        {
          notificationId: "n-1",
          severity: "error",
          title: "Unable to copy screenshot path",
          body: "The saved screenshot could not be copied.",
        },
      ],
    );
  });

  NodeTest.it("reveals without touching the toast", async () => {
    const capture = actionCapture();
    const { calls, api } = notifier({ applied: true });
    await runCaptureToastAction(api, capture, request, "n-1", "reveal", signal);
    NodeAssert.deepEqual(capture.calls, [["reveal", request]]);
    NodeAssert.equal(calls.length, 0);
  });

  NodeTest.it("serves every click until the toast closes", async () => {
    const capture = actionCapture();
    const answers = [{ actionId: "copy-path" }, { actionId: "reveal" }, { dismissed: true }];
    const calls = [];
    let served;
    const done = new Promise((resolve) => (served = resolve));
    const client = {
      invokeApi: async (req) => {
        calls.push(req);
        if (req.method === "notify") return { notificationId: "n-7" };
        if (req.method === "awaitAction") {
          const next = answers.shift();
          if (answers.length === 0) served();
          return next;
        }
        return { applied: true };
      },
    };
    const report = reportCaptureOutcome(
      bindApi(uiNotificationsApi, client, context),
      "thread-a",
      "page",
      savedPage,
      signal,
      5_000,
      { capture, context, discoverApis: discovering("1.1.0"), invokeApi: client.invokeApi },
    );
    NodeAssert.equal(await report.fallback, null);
    await done;
    await new Promise((resolve) => setImmediate(resolve));
    NodeAssert.equal(calls[0].input.actions.length, 3);
    // The probed toast and its updates ask for the range that carries keepOpen.
    NodeAssert.deepEqual(new Set(calls.map((call) => call.versionRange)), new Set(["^1.1.0"]));
    NodeAssert.deepEqual(
      capture.calls.map(([name]) => name),
      ["copyPath", "reveal"],
    );
    NodeAssert.equal(calls.filter((call) => call.method === "awaitAction").length, 3);
  });

  NodeTest.it("falls back to the plain toast on a host that rejects the actions", async () => {
    const calls = [];
    const client = {
      invokeApi: async (req) => {
        calls.push(req);
        if (req.input.actions) throw new Error("unknown property keepOpen");
        return { notificationId: "n-8" };
      },
    };
    const report = reportCaptureOutcome(
      bindApi(uiNotificationsApi, client, context),
      "thread-a",
      "page",
      savedPage,
      signal,
      5_000,
      {
        capture: actionCapture(),
        context,
        discoverApis: discovering("1.1.0"),
        invokeApi: client.invokeApi,
      },
    );
    NodeAssert.equal(await report.fallback, null);
    NodeAssert.equal(calls.length, 2);
    NodeAssert.equal(calls[1].input.actions, undefined);
    NodeAssert.equal(calls[1].input.title, "Screenshot saved");
  });

  /** Reports a page capture through a recording client; returns what notify saw. */
  const notifyInputs = async (outcome, discoverApis) => {
    const calls = [];
    const client = {
      invokeApi: async (req) => {
        calls.push(req);
        return req.method === "notify" ? { notificationId: "n-9" } : { dismissed: true };
      },
    };
    const report = reportCaptureOutcome(
      bindApi(uiNotificationsApi, client, context),
      "thread-a",
      "page",
      outcome,
      signal,
      5_000,
      { capture: actionCapture(), context, discoverApis, invokeApi: client.invokeApi },
    );
    NodeAssert.equal(await report.fallback, null);
    return calls.filter((call) => call.method === "notify").map((call) => call.input);
  };

  NodeTest.it("offers no file actions for a capture the desktop did not save", async () => {
    const inputs = await notifyInputs(
      { ...pageAdded, artifact: { ...artifact, saved: false } },
      discovering("1.1.0"),
    );
    NodeAssert.equal(inputs.length, 1);
    NodeAssert.equal(inputs[0].title, "Screenshot saved");
    NodeAssert.equal(inputs[0].actions, undefined);
    // A 1.0.0 capture host says nothing about saving, so it gets none either.
    NodeAssert.equal((await notifyInputs(pageAdded, discovering("1.1.0")))[0].actions, undefined);
  });

  NodeTest.it("asks for keepOpen actions only when the host advertises 1.1.0", async () => {
    for (const discoverApis of [discovering("1.0.0"), async () => Promise.reject(new Error("x"))]) {
      const inputs = await notifyInputs(savedPage, discoverApis);
      NodeAssert.equal(inputs.length, 1);
      NodeAssert.equal(inputs[0].actions, undefined);
    }
    NodeAssert.equal((await notifyInputs(savedPage, discovering("1.1.0")))[0].actions.length, 3);
  });
});

NodeTest.describe("useBrowserCapture status", () => {
  /** Mounts the hook and records every status line it reports. */
  function mountCapture(host) {
    const reports = [];
    const session = { context, signal: new AbortController().signal };
    const Probe = () => {
      const { capture } = useBrowserCapture(host, session, held, "shown", (line) =>
        reports.push(line),
      );
      return React.createElement("probe", { capture });
    };
    let renderer;
    act(() => {
      renderer = create(React.createElement(Probe));
    });
    return {
      reports,
      capture: (target) => act(() => renderer.root.findByType("probe").props.capture(target)),
    };
  }

  // The panel's status line shows only the latest event, so a run that ends
  // with nothing to say must still report that, or an older unrelated line
  // (a profile action's result) resurfaces.
  NodeTest.it("reports a cancelled pick as a cleared line", async () => {
    const opened = deferred();
    const settled = deferred();
    const host = fakeHost({
      capture: (request) =>
        new Promise((resolve) => {
          opened.resolve();
          request.signal.addEventListener("abort", () => {
            resolve({ ok: false, failure: { reason: "cancelled", detail: "dismissed" } });
            setImmediate(settled.resolve);
          });
        }),
    });
    const view = mountCapture(host);
    view.capture("element");
    await opened.promise;
    // Pressing pick again while the picker is open is Cancel annotation.
    view.capture("element");
    await act(() => settled.promise);
    NodeAssert.deepEqual(view.reports, ["Pick an element in the page — Esc cancels.", null]);
  });

  NodeTest.it("reports a toasted page capture as a cleared line", async () => {
    const notified = deferred();
    const host = fakeHost({
      insert: (request) => {
        if (request.method === "notify") setImmediate(notified.resolve);
        return request.method === "notify"
          ? { notificationId: "n-1" }
          : { inserted: true, target: "env-a:thread-a" };
      },
    });
    const view = mountCapture(host);
    view.capture("page");
    await act(() => notified.promise);
    NodeAssert.deepEqual(view.reports, ["Capturing the page…", null]);
  });
});

NodeTest.test("annotationControl: a failed page disables pick with native's reason", () => {
  const reason = captureUnavailableReason(fakeHost(), held, "thread-a", "failed");
  // Supported desktop host, held tab, idle capture: only the page failed.
  NodeAssert.deepEqual(
    annotationControl({ blockReason: reason, capturing: null, pageFailed: true }),
    {
      disabled: true,
      picking: false,
      ariaLabel: "Annotate preview",
      tooltip: reason,
      hoverWhileDisabled: true,
    },
  );
  NodeAssert.deepEqual(
    annotationControl({ blockReason: null, capturing: null, pageFailed: false }),
    {
      disabled: false,
      picking: false,
      ariaLabel: "Annotate preview",
      tooltip: "Annotate elements, regions, and drawings",
      hoverWhileDisabled: false,
    },
  );
  // Other disabled states stay silent, as native's ordinary disabled buttons.
  const blocked = annotationControl({
    blockReason: "Open a page to capture it.",
    capturing: null,
    pageFailed: false,
  });
  NodeAssert.equal(blocked.disabled, true);
  NodeAssert.equal(blocked.hoverWhileDisabled, false);
  const picking = annotationControl({ blockReason: null, capturing: "element", pageFailed: false });
  NodeAssert.equal(picking.ariaLabel, "Cancel annotation");
  NodeAssert.equal(picking.tooltip, "Cancel annotation (Esc)");
});

NodeTest.test("annotationControl: pressing pick again while picking cancels", () => {
  // The picker is open, so the button is Cancel annotation and must stay
  // enabled, even if capture became blocked while it was open.
  for (const blockReason of [null, "The page is not shown here yet — capture once it renders."]) {
    const picking = annotationControl({ blockReason, capturing: "element", pageFailed: false });
    NodeAssert.equal(picking.disabled, false);
    NodeAssert.equal(picking.picking, true);
    NodeAssert.equal(picking.ariaLabel, "Cancel annotation");
    NodeAssert.equal(picking.tooltip, "Cancel annotation (Esc)");
  }
});
