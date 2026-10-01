// @vitest-environment jsdom

import type { PrsCheck, PrsRef } from "@t3tools/extension-sdk/catalogue";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import * as React from "react";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { hostFloatingLayer } from "./floatingLayer/hostFloatingLayer";

// The version-control pack's floating UI through the real host floating layer
// and a real DOM, so focus, portals and modality are the browser's own rules
// rather than a renderer's. Packs load by path, not by import.
const PACKS = new URL("../../../../packages/first-party-extensions", import.meta.url).pathname;

let PullRequestsPanel: ComponentType<{
  host: ClientHost;
  session: unknown;
  visible: boolean;
  selected: PrsRef | null;
  onSelect: (ref: PrsRef | null) => void;
}>;
let ChecksControl: ComponentType<{
  host: ClientHost;
  state: "passing" | "failing" | "pending";
  checks: readonly PrsCheck[];
  onOpenLink: (url: string) => void;
}>;

const REF = { host: "github.com", repository: "o/r", number: 3 } as PrsRef;
const ACTIONS = ["merge", "enable-auto-merge", "disable-auto-merge", "draft", "ready", "close"];
const layer = (number: number) => ({
  number,
  title: `Layer ${number}`,
  headBranch: `b${number}`,
  headSha: `sha${number}`,
  state: "open",
});

/** Host answers for an open pull request in a three-layer stack; override any key. */
function handlersFor(overrides: Record<string, (input: unknown) => unknown> = {}) {
  const off = (names: string[]) => Object.fromEntries(names.map((name) => [name, false]));
  return {
    "t3.prs/read#getCapabilities": () => ({
      hosted: true,
      reason: null,
      detail: null,
      providers: [],
      operations: {
        ...off(["prs.listStats", "prs.threadComments", "prs.reviewerCandidates"]),
        ...off(["prs.labelCandidates", "prs.streamDiff", "prs.streamDiffFileContents"]),
        "prs.list": true,
        "prs.summary": true,
        "prs.detail": true,
        "prs.activity": true,
        "prs.linkedThreads": true,
        "prs.stack": true,
        "prs.invalidate": true,
        "prs.subscribeRefreshes": true,
      },
    }),
    "t3.prs/write#getCapabilities": () => ({
      hosted: true,
      reason: null,
      detail: null,
      operations: { "prs.runAction": true },
      actions: ACTIONS,
      mergeMethods: ["merge", "squash", "rebase"],
      updateMethods: ["merge", "rebase"],
      verdicts: [],
    }),
    "t3.vcs/actions#getCapabilities": () => ({ detected: true, operations: {} }),
    "t3.vcs/refs#list": () => ({
      refs: [],
      isRepo: true,
      hasPrimaryRemote: true,
      nextCursor: null,
      totalCount: 0,
    }),
    "t3.prs/read#list": () => ({
      viewers: {},
      providers: [],
      entries: [],
      errors: [],
      truncated: false,
      nextCursors: {},
    }),
    "t3.prs/read#detail": () => ({
      provider: "github",
      capabilities: {
        diff: false,
        comment: false,
        actions: ACTIONS,
        mergeMethods: ["merge", "squash", "rebase"],
        search: true,
        review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
        reviewers: { request: false, listCandidates: false },
        stacks: true,
        stackActions: true,
      },
      viewerPermissions: {
        actions: ACTIONS,
        comment: false,
        resolve: false,
        verdicts: [],
        requestReviewers: false,
      },
      projectId: "p1",
      projectTitle: "Project",
      workspaceRoot: "/w",
      repository: "o/r",
      number: 3,
      title: "Layer 3",
      body: "",
      url: "https://github.com/o/r/pull/3",
      author: null,
      state: "open",
      isDraft: false,
      mergeability: "mergeable",
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      headBranch: "b3",
      baseBranch: "b2",
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: "2026-09-01T00:00:00Z",
      mergedAt: null,
      closedAt: null,
      reviewers: [],
      labels: [],
      checks: [],
      mergeCapabilities: { merge: true, squash: true, rebase: true },
      autoMergeEnabled: false,
    }),
    "t3.prs/read#activity": () => ({
      comments: [],
      commentCount: 0,
      commentsTruncated: false,
      reviewThreads: [],
      commits: [],
      truncated: false,
    }),
    "t3.prs/read#linkedThreads": () => ({ threads: [], truncated: false }),
    "t3.prs/read#stack": () => ({
      id: "s",
      number: 40,
      url: "https://github.com/o/r/stacks/40",
      base: "main",
      layers: [layer(2), layer(3), layer(4)],
    }),
    "t3.prs/read#invalidate": () => ({}),
    "t3.prs/write#runAction": () => ({}),
    "t3.ui/notifications#getCapabilities": () => ({ adapter: "none", operations: {}, clients: [] }),
    ...overrides,
  } as Record<string, (input: unknown) => unknown>;
}

beforeAll(async () => {
  ({ PullRequestsPanel, ChecksControl } = await import(
    /* @vite-ignore */ `${PACKS}/version-control/prsPanel.tsx`
  ));
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // jsdom runs no animations; Base UI waits on them before it unmounts a closed dialog.
  Element.prototype.getAnimations ??= () => [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

/**
 * One animation frame: Base UI moves focus in a frame callback, so a callback
 * queued after its own runs once that focus has moved.
 */
async function nextFrame() {
  await act(async () => {
    await new Promise((next) => requestAnimationFrame(next));
  });
}

/** Lets settled reads, timers, focus frames and the updates they queued land. */
async function settle() {
  for (let index = 0; index < 5; index += 1)
    await act(async () => {
      await new Promise((next) => setTimeout(next, 0));
    });
  await nextFrame();
}

function scriptedHost(handlers: Record<string, (input: unknown) => unknown>): ClientHost {
  return {
    React,
    floatingLayer: hostFloatingLayer,
    invokeApi: (request: { id: string; method: string; input: unknown }) => {
      const handler = handlers[`${request.id}#${request.method}`];
      if (handler === undefined)
        return Promise.reject(new Error(`unexpected ${request.id}#${request.method}`));
      return Promise.resolve().then(() => handler(request.input));
    },
    subscribeApi: (_request: unknown, signal: AbortSignal) =>
      (async function* () {
        // No refreshes: the stream stays open, silent, until the view goes.
        await new Promise((resolve) => signal.addEventListener("abort", resolve));
        yield* [];
      })(),
    discoverApis: async () => [],
    invokeTool: async () => null,
  } as unknown as ClientHost;
}

function viewSession() {
  const controller = new AbortController();
  return {
    context: {
      client: "web",
      resource: { namespace: "t3.extensions", id: "vc", environmentId: "env", projectId: "p1" },
    },
    signal: controller.signal,
    restoring: false,
    visible: true,
    onVisibility: () => () => {},
    restoreState: null,
    publish: () => true,
    save: () => true,
    invoke: async () => null,
    bindCommands: () => "b",
    setTabIndicators: () => true,
    onDispose: () => {},
  };
}

function byText(root: ParentNode, selector: string, text: string): HTMLElement {
  const found = [...root.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.textContent?.trim() === text,
  );
  if (!found) throw new Error(`No ${selector} reading ${JSON.stringify(text)}`);
  return found;
}

async function press(key: string, init: KeyboardEventInit = {}) {
  const target = document.activeElement ?? document.body;
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
  });
  await settle();
}

async function pressOutside(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }));
  });
  await settle();
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
/** Where a press anywhere outside the dialog lands: the backdrop covering the client. */
const backdrop = () => {
  const element = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]');
  expect(element, "a modal backdrop").not.toBeNull();
  return element!;
};

describe("stack confirmation", () => {
  async function renderPanel(handlers: Record<string, (input: unknown) => unknown>) {
    await act(async () =>
      root.render(
        <>
          <button type="button">Repository</button>
          <PullRequestsPanel
            host={scriptedHost(handlers)}
            session={viewSession()}
            visible
            selected={REF}
            onSelect={() => {}}
          />
        </>,
      ),
    );
    await settle();
    const opener = byText(container, "button", "Merge stack");
    await act(async () => {
      // A browser focuses a button it activates; jsdom's click() does not.
      opener.focus();
      opener.click();
    });
    await settle();
    return { opener, repositoryTab: byText(container, "button", "Repository") };
  }

  it("is modal over the whole client, centred, and focused on Cancel", async () => {
    const { repositoryTab } = await renderPanel(handlersFor());
    const open = dialog();
    expect(open).not.toBeNull();
    // Native's centred dialog viewport, outside the panel's own DOM.
    expect(open?.closest('[data-slot="dialog-viewport"]')).not.toBeNull();
    expect(container.contains(open)).toBe(false);
    // The rest of the client, the parent tab included, is hidden behind it.
    expect(repositoryTab.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(document.querySelector('[data-slot="dialog-backdrop"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Cancel");
  });

  it("wraps Tab at either end back into the dialog", async () => {
    await renderPanel(handlersFor());
    const open = dialog()!;
    // Tab off either end of the dialog lands on the guard beside it, which the
    // modal hands straight back inside.
    const guards = [...document.querySelectorAll<HTMLElement>("[data-base-ui-focus-guard]")];
    const after = guards.filter(
      (guard) => open.compareDocumentPosition(guard) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const before = guards.filter(
      (guard) => open.compareDocumentPosition(guard) & Node.DOCUMENT_POSITION_PRECEDING,
    );
    expect(after.length > 0 && before.length > 0).toBe(true);
    for (const guard of [after[0]!, before.at(-1)!]) {
      await act(async () => guard.focus());
      await nextFrame();
      expect(open.contains(document.activeElement)).toBe(true);
    }
  });

  it("closes on an outside press or Escape and hands focus back to its opener", async () => {
    const { opener } = await renderPanel(handlersFor());
    await pressOutside(backdrop());
    expect(dialog()).toBeNull();
    await act(async () => {
      // A browser focuses a button it activates; jsdom's click() does not.
      opener.focus();
      opener.click();
    });
    await settle();
    await press("Escape");
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("cannot be dismissed, from outside or by key, while its write runs", async () => {
    let finish: (value: unknown) => void = () => {};
    const { repositoryTab } = await renderPanel(
      handlersFor({
        "t3.prs/write#runAction": () => new Promise((resolve) => (finish = resolve)),
      }),
    );
    await act(async () => byText(dialog()!, "button", "Merge stack").click());
    await settle();
    await pressOutside(backdrop());
    await pressOutside(repositoryTab);
    await press("Escape");
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('[aria-label="Close"]')).toBeNull();
    expect(repositoryTab.closest('[aria-hidden="true"]')).not.toBeNull();
    await act(async () => finish({}));
    await settle();
    expect(dialog()).toBeNull();
  });
});

describe("checks popover", () => {
  const check = (name: string): PrsCheck =>
    ({
      name,
      status: "failure",
      description: null,
      url: `https://ci.example/${name}`,
    }) as PrsCheck;

  async function renderChecks(between: React.ReactNode = null) {
    await act(async () =>
      root.render(
        <>
          <button type="button">Before</button>
          <ChecksControl
            host={{ React, floatingLayer: hostFloatingLayer } as unknown as ClientHost}
            state="failing"
            checks={[check("lint"), check("test")]}
            onOpenLink={() => {}}
          />
          {between}
          <button type="button">After</button>
        </>,
      ),
    );
    const trigger = container.querySelector<HTMLElement>('[aria-haspopup="dialog"]')!;
    await act(async () => trigger.focus());
    return trigger;
  }
  const popover = () => document.querySelector<HTMLElement>('[role="dialog"][aria-label="Checks"]');

  it("opens from the keyboard onto its first link and tabs on past its trigger", async () => {
    const trigger = await renderChecks();
    await press("Enter");
    expect(popover()).not.toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open check lint");
    await press("Tab");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Open check test");
    await press("Tab");
    expect(popover()).toBeNull();
    expect(document.activeElement?.textContent).toBe("After");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("tabs past controls that are not Tab stops", async () => {
    await renderChecks(
      <>
        <button type="button" tabIndex={-1}>
          Not a Tab stop
        </button>
        <button type="button" hidden>
          Hidden
        </button>
        <div inert>
          <button type="button">Inert</button>
        </div>
      </>,
    );
    await press("Enter");
    await press("Tab");
    await press("Tab");
    expect(popover()).toBeNull();
    expect(document.activeElement?.textContent).toBe("After");
  });

  it("tabs past controls that CSS hides", async () => {
    await renderChecks(
      <>
        <button type="button" style={{ display: "none" }}>
          Not displayed
        </button>
        <button type="button" style={{ visibility: "hidden" }}>
          Invisible
        </button>
        <div style={{ display: "none" }}>
          <button type="button">Inside a hidden container</button>
        </div>
      </>,
    );
    await press("Enter");
    await press("Tab");
    await press("Tab");
    expect(popover()).toBeNull();
    expect(document.activeElement?.textContent).toBe("After");
  });

  it("Shift-Tab and Escape close it back onto the trigger", async () => {
    const trigger = await renderChecks();
    await press("Enter");
    await press("Tab", { shiftKey: true });
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await press("Enter");
    await press("Tab");
    await press("Escape");
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes when focus leaves it", async () => {
    await renderChecks();
    await press("Enter");
    expect(popover()).not.toBeNull();
    await act(async () => byText(container, "button", "Before").focus());
    await settle();
    expect(popover()).toBeNull();
  });
});
