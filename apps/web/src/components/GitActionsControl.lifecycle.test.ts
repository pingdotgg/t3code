// @vitest-environment jsdom
import {
  AuthSourceControlWriteScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type GitRunStackedActionToastCta,
  type ServerSettings,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  actions: [] as {
    scope: { environmentId: string | null; cwd: string | null };
    input: { threadId?: string; action: string };
  }[],
  toasts: [] as { type?: string; description?: string; actionProps?: { onClick: () => void } }[],
  settings: undefined as ServerSettings | undefined,
  currentConfigAvailable: true,
  toastCta: undefined as GitRunStackedActionToastCta | undefined,
  afterAction: undefined as (() => void) | undefined,
  openedPrs: [] as string[],
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "vcs-state"
      ? { isRunning: false }
      : atom === "last-known-settings"
        ? (state.settings ?? null)
        : atom === "server-config" && state.currentConfigAvailable
          ? { settings: state.settings }
          : null,
}));
vi.mock("~/state/entities", () => ({
  useThreadProjection: () => null,
  useThreadShell: (ref: { threadId: string }) => ({
    branch: "main",
    id: ref.threadId,
    projectId: `${ref.threadId}-project`,
  }),
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
  readEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => "server-config",
    lastKnownSettingsValueAtom: () => "last-known-settings",
  },
}));
vi.mock("~/rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "last-known-settings"
        ? (state.settings ?? null)
        : state.currentConfigAvailable
          ? { settings: state.settings }
          : null,
  },
}));
vi.mock("~/state/sourceControl", () => ({ sourceControlEnvironment: { discovery: () => null } }));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: { status: () => null },
  vcsActionManager: { stateAtom: () => "vcs-state" },
}));
vi.mock("~/state/threads", () => ({
  threadEnvironment: { updateMetadata: async () => AsyncResult.success(undefined) },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      sourceControlProviders: [],
      isRepo: true,
      refName: "main",
      isDefaultRef: false,
      hasPrimaryRemote: true,
      hasWorkingTreeChanges: true,
      workingTree: {
        files: [{ path: "file.ts", status: "modified", insertions: 1, deletions: 0 }],
      },
    },
    error: null,
  }),
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => {} }));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: {
      getDraftSession: () => null;
      getDraftThreadByRef: () => null;
      setDraftThreadContext: () => void;
    }) => unknown,
  ) =>
    select({
      getDraftSession: () => null,
      getDraftThreadByRef: () => null,
      setDraftThreadContext: () => {},
    }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({}),
  useVcsPullAction: () => ({}),
  useSourceControlPublishRepositoryAction: () => ({}),
  useGitStackedAction: (scope: { environmentId: string | null; cwd: string | null }) => ({
    run: async (input: { featureBranch?: boolean; threadId?: string; action: string }) => {
      state.actions.push({ scope, input });
      state.afterAction?.();
      return {
        _tag: "Success",
        value: {
          branch: { status: "skipped_not_requested" },
          toast: {
            title: "Committed",
            description: "Committed",
            cta: state.toastCta,
          },
        },
      };
    },
  }),
}));
vi.mock("~/lib/utils", () => ({ cn: () => "", randomUUID: () => "action" }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => () => {} }));
vi.mock("~/lib/openPullRequestLink", () => ({
  useOpenPrLink: () => (_event: unknown, url: string) => state.openedPrs.push(url),
}));
vi.mock("~/components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: {
    add: (input: {
      type?: string;
      description?: string;
      actionProps?: { onClick: () => void };
    }) => {
      state.toasts.push(input);
      return "toast";
    },
    update: () => {},
    close: () => {},
  },
}));
vi.mock("~/components/ui/dialog", () => ({
  Dialog: "Dialog",
  DialogDescription: "DialogDescription",
  DialogFooter: "DialogFooter",
  DialogHeader: "DialogHeader",
  DialogPanel: "DialogPanel",
  DialogPopup: "DialogPopup",
  DialogTitle: "DialogTitle",
}));
vi.mock("~/components/ui/group", () => ({ Group: "Group", GroupSeparator: "GroupSeparator" }));
vi.mock("~/components/ui/menu", () => ({
  Menu: "Menu",
  MenuItem: "MenuItem",
  MenuItemLabel: "MenuItemLabel",
  MenuPopup: "MenuPopup",
  MenuTrigger: "MenuTrigger",
}));
vi.mock("~/components/ui/popover", () => ({
  Popover: "Popover",
  PopoverPopup: "PopoverPopup",
  PopoverTrigger: "PopoverTrigger",
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: "Tooltip",
  TooltipPopup: "TooltipPopup",
  TooltipTrigger: "TooltipTrigger",
}));
vi.mock("~/components/ui/button", () => ({ Button: "button" }));
vi.mock("~/components/ui/checkbox", () => ({ Checkbox: "Checkbox" }));
vi.mock("~/components/ui/input", () => ({ Input: "Input" }));
vi.mock("~/components/ui/radio-group", () => ({ RadioGroup: "RadioGroup" }));
vi.mock("~/components/ui/scroll-area", () => ({ ScrollArea: "ScrollArea" }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: "Spinner" }));
vi.mock("~/components/ui/textarea", () => ({ Textarea: "Textarea" }));
vi.mock("~/components/ui/toggle", () => ({ toggleVariants: () => "" }));
vi.mock("./AnimatedHeight", () => ({ AnimatedHeight: "AnimatedHeight" }));

import GitActionsControl from "./GitActionsControl";

import { createElement, memo } from "react";
import { act, create } from "react-test-renderer";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const renderers: ReturnType<typeof create>[] = [];
// ThreadDetailsPanel keeps this component mounted behind React.memo when threads change.
const MemoGitActionsControl = memo(GitActionsControl);
const props = (thread: string, cwd: string) => ({
  gitCwd: cwd,
  activeThreadRef: {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make(thread),
  },
});

async function renderActions(thread: string, cwd: string) {
  let renderer!: ReturnType<typeof create>;
  await act(async () => {
    renderer = create(createElement(MemoGitActionsControl, props(thread, cwd)));
  });
  renderers.push(renderer);
  return renderer;
}

async function clickQuickAction(renderer: ReturnType<typeof create>) {
  const button = renderer.root
    .findAllByType("button")
    .find((button) => button.props.onClick && !button.props.disabled);
  expect(button).toBeDefined();
  await act(async () => {
    button!.props.onClick({});
  });
}

beforeEach(() => {
  state.scopes = new Set([AuthSourceControlWriteScope]);
  state.primaryScopes = new Set([AuthSourceControlWriteScope]);
  state.actions = [];
  state.toasts = [];
  state.settings = { ...DEFAULT_SERVER_SETTINGS };
  state.currentConfigAvailable = true;
  state.toastCta = {
    kind: "run_action",
    label: "Push & create PR",
    action: { kind: "commit_push_pr" },
  };
  state.afterAction = undefined;
  state.openedPrs = [];
});

afterEach(async () => {
  await act(async () => {
    for (const renderer of renderers.splice(0)) renderer.unmount();
  });
});

describe("Git action targets across thread navigation", () => {
  it("runs a retained PR toast in the thread that produced it", async () => {
    const renderer = await renderActions("first", "/first");
    await clickQuickAction(renderer);
    const toast = state.toasts.find((toast) => toast.actionProps)!;
    expect(toast).toBeDefined();
    await act(async () => {
      renderer.update(createElement(MemoGitActionsControl, props("second", "/second")));
    });
    await act(async () => {
      toast.actionProps!.onClick();
    });
    expect(state.actions.at(-1)).toMatchObject({
      scope: { cwd: "/first" },
      input: { threadId: "first", action: "commit_push_pr" },
    });
  });

  it("runs the memoized panel button in the current thread after navigation", async () => {
    const renderer = await renderActions("first", "/first");
    for (const [thread, cwd] of [
      ["first", "/first"],
      ["second", "/second"],
      ["first", "/first"],
    ] as const) {
      await act(async () => {
        renderer.update(createElement(MemoGitActionsControl, props(thread, cwd)));
      });
      await clickQuickAction(renderer);
      expect(state.actions.at(-1)).toMatchObject({ scope: { cwd }, input: { threadId: thread } });
    }
  });
});

describe("PR creation in result notifications", () => {
  it.each(["create_pr", "commit_push_pr"] as const)(
    "omits a %s notification action when PR creation is disabled",
    async (kind) => {
      state.settings = { ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: false };
      state.toastCta = { kind: "run_action", label: "Create PR", action: { kind } };
      const renderer = await renderActions("first", "/first");
      await clickQuickAction(renderer);
      expect(state.actions.map(({ input }) => input.action)).toEqual(["commit_push"]);
      expect(state.toasts.at(-1)?.type).toBe("success");
      expect(state.toasts.at(-1)?.actionProps).toBeUndefined();
    },
  );

  it("checks the setting again when the action finishes", async () => {
    state.afterAction = () => {
      state.settings = { ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: false };
    };
    const renderer = await renderActions("first", "/first");
    await clickQuickAction(renderer);
    expect(state.toasts.at(-1)?.type).toBe("success");
    expect(state.toasts.at(-1)?.actionProps).toBeUndefined();
  });

  it.each(["create_pr", "commit_push_pr"] as const)(
    "blocks a retained %s action after its project disables PR creation",
    async (kind) => {
      state.toastCta = { kind: "run_action", label: "Create PR", action: { kind } };
      const renderer = await renderActions("first", "/first");
      await clickQuickAction(renderer);
      const toast = state.toasts.find((toast) => toast.actionProps)!;
      expect(toast).toBeDefined();
      await act(async () => {
        renderer.update(createElement(MemoGitActionsControl, props("second", "/second")));
      });
      state.settings = {
        ...DEFAULT_SERVER_SETTINGS,
        projectSettingsOverrides: {
          [ProjectId.make("first-project")]: { pullRequestCreationEnabled: false },
        },
      };
      const previousActionCount = state.actions.length;
      await act(async () => {
        toast.actionProps!.onClick();
      });
      expect(state.actions).toHaveLength(previousActionCount);
    },
  );

  it.each(["create_pr", "commit_push_pr"] as const)(
    "blocks a retained %s action when there are no known settings",
    async (kind) => {
      state.toastCta = { kind: "run_action", label: "Create PR", action: { kind } };
      const renderer = await renderActions("first", "/first");
      await clickQuickAction(renderer);
      const toast = state.toasts.find((toast) => toast.actionProps)!;
      expect(toast).toBeDefined();
      state.settings = undefined;
      const previousActionCount = state.actions.length;
      await act(async () => toast.actionProps!.onClick());
      expect(state.actions).toHaveLength(previousActionCount);
    },
  );

  it.each([true, false])(
    "keeps the last known PR preference (%s) while current configuration reloads",
    async (enabled) => {
      state.settings = { ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: enabled };
      const renderer = await renderActions("first", "/first");
      state.currentConfigAvailable = false;
      await act(async () => {
        renderer.update(createElement(MemoGitActionsControl, props("first", "/first")));
      });
      await clickQuickAction(renderer);
      expect(state.actions.at(-1)?.input.action).toBe(enabled ? "commit_push_pr" : "commit_push");
      expect(Boolean(state.toasts.at(-1)?.actionProps)).toBe(enabled);
      if (enabled) {
        await act(async () => state.toasts.at(-1)!.actionProps!.onClick());
        expect(state.actions).toHaveLength(2);
        expect(state.actions.at(-1)?.input.action).toBe("commit_push_pr");
      }
    },
  );

  it("omits PR quick actions and notification actions until settings load", async () => {
    state.settings = undefined;
    const renderer = await renderActions("first", "/first");
    await clickQuickAction(renderer);
    expect(state.actions.map(({ input }) => input.action)).toEqual(["commit_push"]);
    expect(state.toasts.at(-1)?.actionProps).toBeUndefined();
    state.settings = { ...DEFAULT_SERVER_SETTINGS };
    await act(async () => {
      renderer.update(createElement(MemoGitActionsControl, props("first", "/first")));
    });
    await clickQuickAction(renderer);
    expect(state.actions.at(-1)?.input.action).toBe("commit_push_pr");
  });

  it("omits a PR notification if there are no known settings when an action finishes", async () => {
    state.afterAction = () => {
      state.settings = undefined;
    };
    const renderer = await renderActions("first", "/first");
    await clickQuickAction(renderer);
    expect(state.toasts.at(-1)?.type).toBe("success");
    expect(state.toasts.at(-1)?.actionProps).toBeUndefined();
  });

  it("uses the originating project's enabled override for a retained action", async () => {
    state.settings = {
      ...DEFAULT_SERVER_SETTINGS,
      pullRequestCreationEnabled: false,
      projectSettingsOverrides: {
        [ProjectId.make("first-project")]: { pullRequestCreationEnabled: true },
      },
    };
    const renderer = await renderActions("first", "/first");
    await clickQuickAction(renderer);
    const toast = state.toasts.find((toast) => toast.actionProps)!;
    expect(toast).toBeDefined();
    await act(async () => {
      renderer.update(createElement(MemoGitActionsControl, props("second", "/second")));
    });
    await act(async () => {
      toast.actionProps!.onClick();
    });
    expect(state.actions.at(-1)).toMatchObject({
      scope: { cwd: "/first" },
      input: { threadId: "first", action: "commit_push_pr" },
    });
  });

  it.each(["disabled", "unavailable"])(
    "keeps Push notification actions with settings %s",
    async (mode) => {
      state.settings =
        mode === "disabled"
          ? { ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: false }
          : undefined;
      state.toastCta = { kind: "run_action", label: "Push", action: { kind: "push" } };
      const renderer = await renderActions("first", "/first");
      await clickQuickAction(renderer);
      const toast = state.toasts.find((toast) => toast.actionProps)!;
      expect(toast).toBeDefined();
      await act(async () => {
        toast.actionProps!.onClick();
      });
      expect(state.actions.map(({ input }) => input.action)).toEqual(["commit_push", "push"]);
    },
  );

  it.each(["disabled", "unavailable"])(
    "keeps links to existing PRs with settings %s",
    async (mode) => {
      state.settings =
        mode === "disabled"
          ? { ...DEFAULT_SERVER_SETTINGS, pullRequestCreationEnabled: false }
          : undefined;
      const url = "https://example.com/pull/1";
      state.toastCta = { kind: "open_pr", label: "View PR", url };
      const renderer = await renderActions("first", "/first");
      await clickQuickAction(renderer);
      const toast = state.toasts.find((toast) => toast.actionProps)!;
      expect(toast).toBeDefined();
      await act(async () => {
        toast.actionProps!.onClick();
      });
      expect(state.openedPrs).toEqual([url]);
      expect(state.actions).toHaveLength(1);
    },
  );
});
