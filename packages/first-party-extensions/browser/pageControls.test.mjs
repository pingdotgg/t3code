import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  DEFAULT_ZOOM_FACTOR,
  ZOOM_LADDER,
  engineStatusLabel,
  isRecoveryExhausted,
  nextZoomFactor,
  pageCommandErrorMessage,
  pageControlsBlock,
  runPageCommand,
} from "./pageControls.ts";

const target = { tabId: "tab-1", serverEpoch: "epoch-1", engineGeneration: "wc-7" };

function session(engine, overrides = {}) {
  return {
    tabId: "tab-1",
    requestedUrl: "http://localhost:5173/",
    navigation: { kind: "loaded", url: "http://localhost:5173/", title: "Home" },
    canGoBack: true,
    canGoForward: false,
    viewport: { _tag: "fill" },
    engine,
    zoomFactor: 1,
    appearance: "system",
    audioMuted: false,
    audible: false,
    pictureInPicture: false,
    ...overrides,
  };
}

const ready = session({ state: "ready", generation: "wc-7" });
const unavailable = session(
  { state: "unavailable", generation: null, reason: "desktop-required" },
  {
    zoomFactor: null,
    appearance: null,
    audioMuted: null,
    audible: null,
    pictureInPicture: null,
  },
);
NodeTest.test(
  "attach status keeps an unclaimed engine pending only while its owner is claiming",
  () => {
    const pending = {
      ...unavailable,
      navigation: { kind: "pending", url: unavailable.requestedUrl, title: "" },
    };
    NodeAssert.equal(engineStatusLabel(pending, true), "engine pending, navigation pending");
    NodeAssert.equal(
      engineStatusLabel(pending, false),
      "engine unavailable (desktop-required), navigation pending",
    );
    NodeAssert.equal(
      engineStatusLabel({ ...pending, engine: { ...pending.engine, generation: "wc-7" } }, true),
      "engine unavailable (desktop-required), navigation pending",
    );
    NodeAssert.equal(
      engineStatusLabel(
        { ...pending, engine: { ...pending.engine, reason: "host-unavailable" } },
        true,
      ),
      "engine unavailable (host-unavailable), navigation pending",
    );
    NodeAssert.equal(
      engineStatusLabel({ ...pending, engine: { state: "starting", generation: "wc-7" } }, true),
      "engine starting, navigation pending",
    );
    NodeAssert.equal(engineStatusLabel(ready, true), "engine ready, navigation loaded");
    NodeAssert.notEqual(pageControlsBlock(pending), null);
    NodeAssert.equal(pageControlsBlock(pending, true), "Waiting for the browser engine to attach.");
  },
);

const recovering = session({ state: "recovering", generation: "wc-7" });
const crashed = session(
  { state: "crashed", generation: "wc-7" },
  {
    navigation: {
      kind: "failed",
      url: "http://localhost:5173/",
      title: "Home",
      failureCode: "crash",
    },
  },
);
const exhausted = session(
  { state: "crashed", generation: "wc-7", reason: "recovery-exhausted" },
  {
    navigation: {
      kind: "failed",
      url: "http://localhost:5173/",
      title: "Home",
      failureCode: "crash",
    },
  },
);

function receipt(outcome, overrides = {}) {
  return {
    commandId: "cmd-1",
    outcome,
    serverEpoch: "epoch-1",
    revision: 4,
    session: { ...ready, ...overrides },
  };
}

/** A `bindApi`-shaped client that records every call and answers with `answer`. */
function fakeApi(answer) {
  const calls = [];
  return {
    calls,
    invoke(method, input, signal) {
      calls.push({ method, input });
      signal.throwIfAborted();
      return typeof answer === "function" ? answer(method, input) : Promise.resolve(answer);
    },
  };
}

const signal = new AbortController().signal;

NodeTest.test("attach-time engine verbs stay local without desktop-required wording", async () => {
  const api = fakeApi(receipt("accepted"));
  const result = await runPageCommand(api, target, unavailable, { method: "reload" }, signal, true);
  NodeAssert.deepEqual(result, {
    kind: "blocked",
    message: "Waiting for the browser engine to attach.",
  });
  NodeAssert.equal(api.calls.length, 0);
});

NodeTest.describe("engine gate", () => {
  NodeTest.it("allows a claimed guest, ready or still starting", () => {
    NodeAssert.equal(pageControlsBlock(ready), null);
    NodeAssert.equal(pageControlsBlock(session({ state: "starting", generation: "wc-7" })), null);
  });

  NodeTest.it("names every state that cannot take a page verb", () => {
    NodeAssert.match(pageControlsBlock(unavailable), /desktop app.*\(desktop-required\)/);
    NodeAssert.match(pageControlsBlock(recovering), /\(recovering\)/);
    NodeAssert.match(pageControlsBlock(crashed), /crashed \(crash\)/);
    NodeAssert.match(pageControlsBlock(exhausted), /\(recovery-exhausted\).*fresh session/);
    NodeAssert.equal(
      pageControlsBlock(null),
      "Waiting for the browser session to report its state.",
    );
  });

  NodeTest.it("only an exhausted recovery counts as permanently dead", () => {
    NodeAssert.equal(isRecoveryExhausted(exhausted), true);
    NodeAssert.equal(isRecoveryExhausted(crashed), false);
    NodeAssert.equal(isRecoveryExhausted(recovering), false);
    NodeAssert.equal(isRecoveryExhausted(null), false);
  });

  NodeTest.it("the status clause carries the contract's own names", () => {
    NodeAssert.equal(engineStatusLabel(ready), "engine ready, navigation loaded");
    NodeAssert.equal(
      engineStatusLabel(exhausted),
      "engine crashed (recovery-exhausted), navigation failed (crash)",
    );
    NodeAssert.equal(
      engineStatusLabel(unavailable),
      "engine unavailable (desktop-required), navigation loaded",
    );
  });
});

NodeTest.describe("zoom ladder", () => {
  NodeTest.it("steps one ladder entry and clamps at the ends", () => {
    NodeAssert.equal(nextZoomFactor(1, "in"), 1.1);
    NodeAssert.equal(nextZoomFactor(1, "out"), 0.9);
    NodeAssert.equal(nextZoomFactor(5, "in"), 5);
    NodeAssert.equal(nextZoomFactor(0.25, "out"), 0.25);
  });

  NodeTest.it("steps from 100% when the engine has not reported a factor", () => {
    NodeAssert.equal(nextZoomFactor(null, "in"), 1.1);
    NodeAssert.equal(nextZoomFactor(null, "out"), 0.9);
  });

  NodeTest.it("an off-ladder factor steps from the entry at or below it", () => {
    NodeAssert.equal(nextZoomFactor(1.05, "in"), 1.1);
    NodeAssert.equal(nextZoomFactor(1.05, "out"), 0.9);
  });

  NodeTest.it("every step lands on the contract ladder", () => {
    for (const level of ZOOM_LADDER) {
      NodeAssert.ok(ZOOM_LADDER.includes(nextZoomFactor(level, "in")));
      NodeAssert.ok(ZOOM_LADDER.includes(nextZoomFactor(level, "out")));
    }
    NodeAssert.ok(ZOOM_LADDER.includes(DEFAULT_ZOOM_FACTOR));
  });
});

NodeTest.describe("runPageCommand", () => {
  NodeTest.it("jumps to any ladder factor in exactly one zoom call", async () => {
    const api = fakeApi(receipt("accepted", { zoomFactor: 3 }));
    const outcome = await runPageCommand(
      api,
      target,
      ready,
      { method: "zoom", zoomFactor: 3 },
      signal,
    );
    NodeAssert.equal(outcome.kind, "accepted");
    NodeAssert.deepEqual(api.calls, [
      {
        method: "zoom",
        input: {
          tabId: "tab-1",
          serverEpoch: "epoch-1",
          expectedEngineGeneration: "wc-7",
          zoomFactor: 3,
        },
      },
    ]);
  });

  NodeTest.it("never sends an off-ladder factor", async () => {
    const api = fakeApi(receipt("accepted"));
    const outcome = await runPageCommand(
      api,
      target,
      ready,
      { method: "zoom", zoomFactor: 1.05 },
      signal,
    );
    NodeAssert.equal(outcome.kind, "blocked");
    NodeAssert.match(outcome.message, /105% is not on the zoom ladder/);
    NodeAssert.equal(api.calls.length, 0);
  });

  NodeTest.it("refuses locally for every dead or hostless engine state", async () => {
    for (const subject of [unavailable, recovering, crashed, exhausted]) {
      for (const verb of [{ method: "reload" }, { method: "setPictureInPicture", open: true }]) {
        const api = fakeApi(receipt("accepted"));
        const outcome = await runPageCommand(api, target, subject, verb, signal);
        NodeAssert.equal(outcome.kind, "blocked");
        NodeAssert.equal(outcome.message, pageControlsBlock(subject));
        NodeAssert.equal(api.calls.length, 0);
      }
    }
  });

  NodeTest.it("fences each verb on the held generation with its own payload", async () => {
    const api = fakeApi(receipt("accepted"));
    const guard = { tabId: "tab-1", serverEpoch: "epoch-1", expectedEngineGeneration: "wc-7" };
    for (const method of ["back", "forward", "reload", "hardReload"])
      await runPageCommand(api, target, ready, { method }, signal);
    await runPageCommand(
      api,
      target,
      ready,
      { method: "setAppearance", appearance: "dark" },
      signal,
    );
    await runPageCommand(api, target, ready, { method: "setAudioMuted", muted: true }, signal);
    await runPageCommand(api, target, ready, { method: "setPictureInPicture", open: true }, signal);
    NodeAssert.deepEqual(api.calls, [
      { method: "back", input: guard },
      { method: "forward", input: guard },
      { method: "reload", input: guard },
      { method: "hardReload", input: guard },
      { method: "setAppearance", input: { ...guard, appearance: "dark" } },
      { method: "setAudioMuted", input: { ...guard, muted: true } },
      { method: "setPictureInPicture", input: { ...guard, open: true } },
    ]);
  });

  NodeTest.it("reports rejected and unanswered receipts by outcome", async () => {
    const rejected = await runPageCommand(
      fakeApi(receipt("rejected")),
      target,
      ready,
      { method: "hardReload" },
      signal,
    );
    NodeAssert.equal(rejected.kind, "rejected");
    NodeAssert.equal(rejected.message, "Hard reload was rejected by the browser engine.");
    const unknown = await runPageCommand(
      fakeApi(receipt("unknown")),
      target,
      ready,
      { method: "setAudioMuted", muted: true },
      signal,
    );
    NodeAssert.equal(unknown.kind, "unknown");
    NodeAssert.match(unknown.message, /^Mute: the browser engine did not answer \(unknown\)/);
  });

  NodeTest.it("names the server's refusals", async () => {
    const unsupported = await runPageCommand(
      fakeApi(() =>
        Promise.reject(
          new Error(
            "browser.sessions: BrowserSessionCommandUnsupported: 'back' requires an authenticated desktop engine host; none renders this session (desktop-required).",
          ),
        ),
      ),
      target,
      ready,
      { method: "back" },
      signal,
    );
    NodeAssert.deepEqual(unsupported, {
      kind: "failed",
      message: "Back needs the T3 Code desktop app, where the page renders (desktop-required).",
    });
    NodeAssert.match(
      pageCommandErrorMessage(
        "zoom",
        new Error("BrowserStaleEngineGeneration: the expected engine generation was replaced."),
      ),
      /^Zoom was not sent: .*\(stale-generation\)/,
    );
    NodeAssert.match(
      pageCommandErrorMessage("reload", new Error("BrowserSessionNotFound: gone")),
      /\(session-not-found\)/,
    );
    NodeAssert.equal(
      pageCommandErrorMessage("forward", new Error("boom")),
      "Forward failed — boom",
    );
  });

  NodeTest.it("names picture-in-picture refusals: missing grant, dead engine, no desktop", () => {
    NodeAssert.equal(
      pageCommandErrorMessage(
        "setPictureInPicture",
        new Error("API capability denied: t3.browser/picture-in-picture"),
      ),
      "Picture in picture — Needs permission t3.browser/picture-in-picture. Grant it in Settings → Extensions.",
    );
    // The server refuses a guest that went dead between the local check and dispatch.
    NodeAssert.equal(
      pageCommandErrorMessage(
        "setPictureInPicture",
        new Error(
          "browser.sessions.setPictureInPicture: BrowserSessionEngineNotLive: picture-in-picture needs a live page; the engine is crashed (recovery-exhausted).",
        ),
      ),
      "Picture in picture needs a live page; the page's engine is not live (recovery-exhausted).",
    );
    NodeAssert.match(
      pageCommandErrorMessage(
        "setPictureInPicture",
        new Error(
          "BrowserSessionCommandUnsupported: none renders this session (desktop-required).",
        ),
      ),
      /^Picture in picture needs the T3 Code desktop app.*\(desktop-required\)/,
    );
  });
});

NodeTest.describe("DevTools", () => {
  const guard = { tabId: "tab-1", serverEpoch: "epoch-1", expectedEngineGeneration: "wc-7" };

  NodeTest.it(
    "sends openDevTools and closeDevTools as distinct fenced verbs and never while blocked",
    async () => {
      const api = fakeApi(receipt("accepted"));
      await runPageCommand(api, target, ready, { method: "openDevTools" }, signal);
      await runPageCommand(api, target, ready, { method: "closeDevTools" }, signal);
      NodeAssert.deepEqual(api.calls, [
        { method: "openDevTools", input: guard },
        { method: "closeDevTools", input: guard },
      ]);
      const blocked = await runPageCommand(
        api,
        target,
        unavailable,
        { method: "openDevTools" },
        signal,
      );
      NodeAssert.equal(blocked.kind, "blocked");
      NodeAssert.match(blocked.message, /\(desktop-required\)/);
      NodeAssert.equal(api.calls.length, 2);
    },
  );

  NodeTest.it(
    "names the missing grant, a foreign session, a detached session and an unsupported engine",
    async () => {
      const failWith = (message, method = "openDevTools") =>
        runPageCommand(
          fakeApi(() => Promise.reject(new Error(message))),
          target,
          ready,
          { method },
          signal,
        );
      NodeAssert.deepEqual(await failWith("API capability denied: t3.browser/devtools"), {
        kind: "failed",
        message:
          "Open DevTools — Needs permission t3.browser/devtools. Grant it in Settings → Extensions.",
      });
      NodeAssert.match(
        (
          await failWith(
            "browser.sessions.closeDevTools: BrowserSessionNotOwned: the session was opened natively, not by this installation (not-owned).",
            "closeDevTools",
          )
        ).message,
        /^Close DevTools is only available on pages this panel opened \(not-owned\)\.$/,
      );
      NodeAssert.match(
        (
          await failWith(
            "browser.sessions.openDevTools: BrowserSessionEngineDetached: no desktop engine has attached this session yet (no-attached-engine).",
          )
        ).message,
        /^Open DevTools was not sent: .*\(no-attached-engine\)\.$/,
      );
      NodeAssert.match(
        (
          await failWith(
            "browser.sessions.openDevTools: BrowserSessionCommandUnsupported: the attached browser engine cannot open DevTools (engine-unsupported).",
          )
        ).message,
        /^Open DevTools is not supported .*\(engine-unsupported\)\.$/,
      );
      NodeAssert.match(
        (
          await failWith(
            "browser.sessions.openDevTools: BrowserSessionCommandUnsupported: 'openDevTools' requires an authenticated desktop engine host; none renders this session (desktop-required).",
          )
        ).message,
        /^Open DevTools needs the T3 Code desktop app.*\(desktop-required\)\.$/,
      );
    },
  );
});
