// @vitest-environment jsdom
import { AuthSourceControlWriteScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  actions: [] as {
    scope: { environmentId: string | null; cwd: string | null };
    input: { threadId?: string; action: string };
  }[],
  toasts: [] as { type?: string; description?: string; actionProps?: { onClick: () => void } }[],
  scopes: new Set<string>(),
  primaryScopes: new Set<string>(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) => (atom === "vcs-state" ? { isRunning: false } : null),
}));
vi.mock("~/state/entities", () => ({
  useThreadProjection: () => null,
  useThreadShell: (ref: { threadId: string }) => ({ branch: "main", id: ref.threadId }),
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
  readEnvironmentScope: (environmentId: unknown, scope: string) =>
    (environmentId === "environment" ? state.scopes : state.primaryScopes).has(scope),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
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
      return {
        _tag: "Success",
        value: {
          branch: { status: "skipped_not_requested" },
          toast: {
            title: "Committed",
            description: "Committed",
            cta: {
              kind: "run_action",
              label: "Push & create PR",
              action: { kind: "commit_push_pr" },
            },
          },
        },
      };
    },
  }),
}));
vi.mock("~/lib/utils", () => ({ cn: () => "", randomUUID: () => "action" }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => () => {} }));
vi.mock("~/lib/openPullRequestLink", () => ({ useOpenPrLink: () => () => {} }));
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
