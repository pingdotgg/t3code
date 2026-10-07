// @vitest-environment jsdom
import {
  EnvironmentId,
  PluginActionId,
  ProjectId,
  ThreadId,
  type PluginAction,
} from "@t3tools/contracts";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  actions: [] as ReadonlyArray<unknown>,
  canOperate: true,
  runPluginAction: vi.fn(async () => {}),
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../state/queries", () => ({
  useComposerPathSearch: () => ({ entries: [], isPending: false }),
  useComposerPullRequestSearch: () => ({ entries: [], isPending: false, error: null }),
}));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: vi.fn(),
  readComposerDraftSelection: () => null,
  setComposerDraftContext: vi.fn(),
}));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => "context-id" }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { refreshProviders: Symbol("refreshProviders") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => fixture.canOperate,
}));
vi.mock("../../state/plugin-actions", () => ({
  usePluginActions: () => fixture.actions,
  runPluginAction: fixture.runPluginAction,
}));

import { useComposerCommandMenu } from "./use-composer-command-menu";

const action = (name: string, title: string, target: PluginAction["target"]) =>
  ({
    id: PluginActionId.make(`installation-1:1:${name}`),
    pluginId: "acme.deploy",
    pluginName: "Deploy",
    name,
    title,
    target,
    placements: ["composer-slash"],
  }) satisfies PluginAction;
const deploy = action("deploy", "Deploy this branch", "thread");
const dashboard = action("open-dashboard", "Open dashboard", "project");
const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const projectId = ProjectId.make("project-1");

type Menu = ReturnType<typeof useComposerCommandMenu>;
const latest: { menu: Menu | null; draft: string } = { menu: null, draft: "" };
const report = (menu: Menu, draft: string) => {
  latest.menu = menu;
  latest.draft = draft;
};
const onUpdateInteractionMode = vi.fn();
const onUsageLimits = vi.fn();

/** A composer: the draft lives in state and the menu edits it, as in ThreadComposer and New Task. */
function Composer(props: {
  initialDraft: string;
  currentThreadId: ThreadId | null;
  report: (menu: Menu, draft: string) => void;
}) {
  const [draft, setDraft] = useState(props.initialDraft);
  const menu = useComposerCommandMenu({
    draftMessage: draft,
    ownerKey: "draft-1",
    environmentId,
    currentThreadId: props.currentThreadId,
    projectId,
    projectCwd: null,
    selectedProviderStatus: null,
    hasThread: props.currentThreadId !== null,
    hasCompactableConversation: false,
    onChangeDraftMessage: setDraft,
    onUpdateInteractionMode,
    onUsageLimits,
  });
  props.report(menu, draft);
  return null;
}

let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.actions = [deploy, dashboard];
  fixture.canOperate = true;
  fixture.runPluginAction.mockClear();
  onUpdateInteractionMode.mockClear();
  onUsageLimits.mockClear();
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

/** Types `draft` with the caret after `/<query>`, then returns the plugin entries offered. */
async function openMenu(draft: string, caret: number, currentThreadId: ThreadId | null) {
  await act(async () =>
    root.render(createElement(Composer, { initialDraft: draft, currentThreadId, report })),
  );
  await act(async () => latest.menu!.onSelectionChange({ start: caret, end: caret }));
  return latest.menu!.items.filter((item) => item.type === "plugin-action");
}

async function pick(label: string) {
  const item = latest.menu!.items.find((candidate) => candidate.label === label);
  if (!item) throw new Error(`Expected ${label} in the menu`);
  await act(async () => latest.menu!.onSelect(item));
}

describe("picking a plugin action from the slash menu", () => {
  it("runs it on the open thread and keeps the rest of the message", async () => {
    const draft = "ship it\n/depl\nthen tell me";
    const offered = await openMenu(draft, "ship it\n/depl".length, threadId);
    expect(offered.map((item) => item.label)).toContain("/deploy");

    await pick("/deploy");

    expect(latest.draft).toBe("ship it\n\nthen tell me");
    expect(fixture.runPluginAction).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      action: deploy,
      target: { _tag: "thread", threadId },
    });
    // The pick is the action itself: nothing else changes the message or the turn.
    expect(onUpdateInteractionMode).not.toHaveBeenCalled();
    expect(onUsageLimits).not.toHaveBeenCalled();
  });

  it("in a New Task draft offers project actions on the selected project, not thread actions", async () => {
    const offered = await openMenu("check this\n/", "check this\n/".length, null);
    expect(offered.map((item) => item.label)).toEqual(["/open-dashboard"]);

    await pick("/open-dashboard");

    expect(latest.draft).toBe("check this\n");
    expect(fixture.runPluginAction).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      action: dashboard,
      target: { _tag: "project", projectId },
    });
  });

  it("offers no plugin actions to a read-only connection and keeps the typed command", async () => {
    fixture.canOperate = false;
    const draft = "ship it\n/depl";
    const offered = await openMenu(draft, draft.length, threadId);
    expect(offered).toEqual([]);

    // A stale entry picked after the grant changed is refused before the draft is touched.
    await act(async () =>
      latest.menu!.onSelect({
        id: `plugin-action:${deploy.id}`,
        type: "plugin-action",
        action: deploy,
        target: { _tag: "thread", threadId },
        label: "/deploy",
        description: deploy.title,
      }),
    );

    expect(latest.draft).toBe(draft);
    expect(fixture.runPluginAction).not.toHaveBeenCalled();
  });
});
