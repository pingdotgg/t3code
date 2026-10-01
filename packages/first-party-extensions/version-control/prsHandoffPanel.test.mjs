/**
 * The REAL pull-request panel's host handoffs: Resolve conflicts, and the
 * worktree checkout that opens its own thread. The pack names a task; the
 * host writes any prompt, so no call here may carry text. The host reports
 * every outcome it reaches in native's toasts, across the navigation, so the
 * pack says nothing of its own about them.
 */
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import {
  React,
  REF,
  defaultHandlers,
  deferred,
  detailOf,
  dispatch,
  flush,
  loadPrsPanel,
  mount,
  nodeName,
} from "./prsPanelHarness.mjs";

let panel;
NodeTest.before(async () => {
  panel = await loadPrsPanel();
});

const URL = "https://github.com/o/r/pull/3";
const READY = {
  status: "ready",
  branch: "b3",
  worktreePath: "/w/.t3/worktrees/b3",
  isOnPullRequestHead: true,
};

/** Every phrase the pack itself could show for a handoff outcome. */
const HOST_OWNED_WORDS = [
  "Preparing the pull request checkout...",
  "Added to the composer",
  "Checkout ready",
  "Checked out",
  "Could not open a thread for the checkout",
  "Could not prepare the pull request checkout",
  "Checked out, but the thread stayed where it was",
];
const TOASTS_LIVE = {
  "t3.ui/notifications#getCapabilities": () => ({
    adapter: "web",
    operations: { notify: true, update: true, dismiss: true },
    clients: [],
  }),
  "t3.ui/notifications#notify": () => ({ notificationId: "n1" }),
  "t3.ui/notifications#update": () => ({ applied: true }),
};
const notifications = (view) => view.calls.filter((call) => call.id === "t3.ui/notifications");
/** The pack's own words about a handoff: an inline receipt or a toast it posted. */
const packReport = (view) => [
  ...HOST_OWNED_WORDS.filter((words) => view.text().includes(words)),
  ...notifications(view)
    .filter((call) => call.method !== "getCapabilities")
    .map((call) => `${call.method}: ${call.input.title ?? ""}`),
];

function mountPanel(overrides = {}, { handoff = true, mergeability = "conflicting" } = {}) {
  return mount(
    (host, session) =>
      React.createElement(panel.PullRequestsPanel, {
        host,
        session,
        visible: true,
        selected: REF,
        onSelect: () => {},
      }),
    defaultHandlers({
      "t3.vcs/actions#getCapabilities": () => ({
        detected: true,
        operations: {
          "actions.preparePullRequestThread": true,
          ...(handoff ? { "actions.handoffPullRequest": true } : {}),
        },
      }),
      "t3.prs/read#detail": () => detailOf({ mergeability, baseBranch: "main" }),
      ...overrides,
    }),
  );
}

const handoffCalls = (view) =>
  view.calls
    .filter((call) => call.id === "t3.vcs/actions" && call.method === "handoffPullRequest")
    .map((call) => ({ versionRange: call.versionRange, input: call.input }));
const prepareCalls = (view) =>
  view.calls.filter(
    (call) => call.id === "t3.vcs/actions" && call.method === "preparePullRequestThread",
  );
/** The button itself: its tooltip says the same words, as native's does. */
const button = (view, name) => {
  const found = view.byName(name).filter((node) => node.type === "button");
  NodeAssert.equal(found.length, 1, `one ${name} button`);
  return found[0];
};
const menuItem = (view, prefix) =>
  view.renderer.root
    .findAll((node) => node.type === "button" && node.props.role === "menuitem")
    .find((node) => nodeName(node).startsWith(prefix));

NodeTest.describe("resolve conflicts", () => {
  NodeTest.it("sits beside Check out and hands only the task to the host", async () => {
    const running = deferred();
    const view = mountPanel({ "t3.vcs/actions#handoffPullRequest": () => running.promise });
    await flush();
    const resolve = button(view, "Resolve conflicts");
    // Native's placement: in the header row, next to the checkout control.
    const header = view.find(`Open pull request #3 on host`).parent.parent.parent;
    NodeAssert.ok(header.findAll((node) => node === resolve).length === 1);
    NodeAssert.ok(header.findAll((node) => nodeName(node) === "Check out").length > 0);

    dispatch(resolve, "onClick");
    await flush();
    NodeAssert.deepEqual(handoffCalls(view), [
      { versionRange: "^1.1.0", input: { reference: URL, task: "resolve-conflicts" } },
    ]);
    // Its own label while it runs; every other handoff waits for it.
    NodeAssert.equal(button(view, "Preparing...").props.disabled, true);
    NodeAssert.equal(view.find("Check out").props.disabled, true);

    running.resolve(READY);
    await flush();
    NodeAssert.equal(button(view, "Resolve conflicts").props.disabled, false);
    NodeAssert.deepEqual(packReport(view), []);
    NodeAssert.equal(prepareCalls(view).length, 0);
    view.unmount();
  });

  NodeTest.it("is absent when the pull request merges cleanly", async () => {
    const view = mountPanel({}, { mergeability: "mergeable" });
    await flush();
    NodeAssert.equal(view.has("Resolve conflicts"), false);
    view.unmount();
  });

  NodeTest.it("is absent where the host cannot run the handoff", async () => {
    const view = mountPanel({}, { handoff: false });
    await flush();
    NodeAssert.equal(view.has("Resolve conflicts"), false);
    view.unmount();
  });

  // Each of these the host has already said, on the thread it opened.
  for (const [name, outcome] of [
    ["drafted beside a thread", { status: "drafted" }],
    ["ready", READY],
    ["stale", { ...READY, isOnPullRequestHead: false }],
    ["no thread", { status: "failed", stage: "thread" }],
    ["no checkout", { status: "failed", stage: "checkout", detail: "Checked out elsewhere." }],
    ["no move", { status: "failed", stage: "thread-move", branch: "b3" }],
  ]) {
    NodeTest.it(
      `says nothing of its own for a ${name} outcome, with or without toasts`,
      async () => {
        for (const toasts of [TOASTS_LIVE, {}]) {
          const view = mountPanel({
            ...toasts,
            "t3.vcs/actions#handoffPullRequest": () => outcome,
          });
          await flush();
          dispatch(button(view, "Resolve conflicts"), "onClick");
          await flush();
          NodeAssert.equal(handoffCalls(view).length, 1);
          NodeAssert.deepEqual(packReport(view), []);
          view.unmount();
        }
      },
    );
  }

  // A refused call never reached the host's toasts, so the pack says so itself.
  NodeTest.it("names a handoff the host refused", async () => {
    const view = mountPanel({
      "t3.vcs/actions#handoffPullRequest": () => {
        throw new Error("client-provider-unavailable: No client.");
      },
    });
    await flush();
    dispatch(button(view, "Resolve conflicts"), "onClick");
    await flush();
    NodeAssert.ok(view.text().includes("Could not prepare the pull request checkout"));
    NodeAssert.ok(view.text().includes("client-provider-unavailable: No client."));
    NodeAssert.equal(button(view, "Resolve conflicts").props.disabled, false);
    view.unmount();
  });
});

NodeTest.describe("checkout into its own folder and thread", () => {
  NodeTest.it("goes through the host handoff, which opens the thread", async () => {
    const view = mountPanel({ "t3.vcs/actions#handoffPullRequest": () => READY });
    await flush();
    dispatch(view.find("Check out"), "onClick");
    await flush();
    const item = menuItem(view, "In a separate worktree");
    NodeAssert.ok(
      nodeName(item).includes("Its own folder and thread. Nothing you have open moves."),
    );
    dispatch(item, "onClick");
    await flush();
    NodeAssert.deepEqual(handoffCalls(view), [
      { versionRange: "^1.1.0", input: { reference: URL, task: "checkout", mode: "worktree" } },
    ]);
    NodeAssert.equal(prepareCalls(view).length, 0);
    NodeAssert.deepEqual(packReport(view), []);
    view.unmount();
  });

  NodeTest.it(
    "keeps the folder-only checkout, and says so, where the host has no handoff",
    async () => {
      const view = mountPanel(
        {
          "t3.vcs/actions#preparePullRequestThread": () => ({
            branch: "b3",
            worktreePath: "/w/.t3/worktrees/b3",
            isOnPullRequestHead: true,
          }),
        },
        { handoff: false },
      );
      await flush();
      dispatch(view.find("Check out"), "onClick");
      await flush();
      const item = menuItem(view, "In a separate worktree");
      NodeAssert.ok(nodeName(item).includes("Its own folder. Nothing you have open moves."));
      dispatch(item, "onClick");
      await flush();
      NodeAssert.deepEqual(handoffCalls(view), []);
      NodeAssert.equal(prepareCalls(view).length, 1);
      view.unmount();
    },
  );

  NodeTest.it("still checks out in this repository without a handoff", async () => {
    const view = mountPanel(
      {
        "t3.vcs/actions#preparePullRequestThread": () => ({
          branch: "b3",
          worktreePath: null,
          isOnPullRequestHead: true,
        }),
      },
      { handoff: false },
    );
    await flush();
    dispatch(view.find("Check out"), "onClick");
    await flush();
    dispatch(menuItem(view, "In this repository"), "onClick");
    await flush();
    NodeAssert.deepEqual(handoffCalls(view), []);
    NodeAssert.deepEqual(
      prepareCalls(view).map((call) => call.input),
      [{ reference: URL, mode: "local" }],
    );
    view.unmount();
  });

  // Native opens a thread for this checkout too, on the repository's own checkout.
  NodeTest.it("checks out in this repository through the host handoff too", async () => {
    const view = mountPanel({
      "t3.vcs/actions#handoffPullRequest": () => ({ ...READY, worktreePath: null }),
    });
    await flush();
    dispatch(view.find("Check out"), "onClick");
    await flush();
    dispatch(menuItem(view, "In this repository"), "onClick");
    await flush();
    NodeAssert.deepEqual(handoffCalls(view), [
      { versionRange: "^1.1.0", input: { reference: URL, task: "checkout", mode: "local" } },
    ]);
    NodeAssert.equal(prepareCalls(view).length, 0);
    NodeAssert.deepEqual(packReport(view), []);
    view.unmount();
  });
});
