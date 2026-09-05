import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Set<string>(),
  shell: { branch: "main" } as { branch: string } | null,
  draft: null as { branch: string; worktreePath: null; envMode: "local" } | null,
  branch: "main",
  commits: 0,
  run: null as ((input: { action: "commit"; featureBranch?: boolean }) => Promise<void>) | null,
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: (callback: unknown) => callback,
  useMemo: (factory: () => unknown) => factory(),
  useState: (initial: unknown) => [typeof initial === "function" ? initial() : initial, () => {}],
  useRef: (current: unknown) => ({ current }),
  useEffect: () => {},
  useEffectEvent: (callback: typeof state.run) => {
    state.run = callback;
    return callback;
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("~/state/entities", () => ({
  useThread: () => null,
  useThreadShell: () => state.shell,
}));
vi.mock("~/state/session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) => state.scopes.has(scope),
  readEnvironmentScope: (_environmentId: unknown, scope: string) => state.scopes.has(scope),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/state/server", () => ({ serverEnvironment: { configValueAtom: () => null } }));
vi.mock("~/state/sourceControl", () => ({ sourceControlEnvironment: {} }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    updateMetadata: async ({ input }: { input: { branch: string } }) => {
      if (!state.scopes.has(AuthOrchestrationOperateScope)) throw new Error("Task denied");
      if (state.shell) state.shell.branch = input.branch;
    },
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      isRepo: true,
      refName: "main",
      isDefaultRef: false,
      hasPrimaryRemote: true,
      hasWorkingTreeChanges: true,
      workingTree: { files: [{ path: "file.ts", status: "modified" }] },
    },
    error: null,
  }),
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (
    select: (store: {
      getDraftSession: () => typeof state.draft;
      getDraftThreadByRef: () => typeof state.draft;
      setDraftThreadContext: (_target: unknown, input: { branch: string }) => void;
    }) => unknown,
  ) =>
    select({
      getDraftSession: () => state.draft,
      getDraftThreadByRef: () => state.draft,
      setDraftThreadContext: (_target, input) => {
        if (state.draft) state.draft.branch = input.branch;
      },
    }),
}));
vi.mock("~/lib/sourceControlActions", () => ({
  useSourceControlActionRunning: () => false,
  useVcsInitAction: () => ({}),
  useVcsPullAction: () => ({}),
  useSourceControlPublishRepositoryAction: () => ({}),
  useGitStackedAction: () => ({
    run: async ({ featureBranch }: { featureBranch?: boolean }) => {
      state.commits += 1;
      if (featureBranch) state.branch = "feature";
      return {
        _tag: "Success",
        value: {
          branch: featureBranch
            ? { status: "created", name: "feature" }
            : { status: "skipped_not_requested" },
          toast: { title: "Committed", description: "Committed", cta: { kind: "none" } },
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
  toastManager: { add: () => "toast", update: () => {}, close: () => {} },
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
vi.mock("~/components/ui/button", () => ({ Button: "Button" }));
vi.mock("~/components/ui/checkbox", () => ({ Checkbox: "Checkbox" }));
vi.mock("~/components/ui/input", () => ({ Input: "Input" }));
vi.mock("~/components/ui/radio-group", () => ({ RadioGroup: "RadioGroup" }));
vi.mock("~/components/ui/scroll-area", () => ({ ScrollArea: "ScrollArea" }));
vi.mock("~/components/ui/spinner", () => ({ Spinner: "Spinner" }));
vi.mock("~/components/ui/textarea", () => ({ Textarea: "Textarea" }));
vi.mock("~/components/ui/toggle", () => ({ toggleVariants: () => "" }));
vi.mock("./AnimatedHeight", () => ({ AnimatedHeight: "AnimatedHeight" }));

import GitActionsControl from "./GitActionsControl";

function renderActions() {
  GitActionsControl({
    gitCwd: "/repo",
    activeThreadRef: {
      environmentId: EnvironmentId.make("environment"),
      threadId: ThreadId.make("thread"),
    },
  });
  if (!state.run) throw new Error("Git action missing");
  return state.run;
}

describe("Git actions while thread details load", () => {
  beforeEach(() => {
    state.scopes = new Set([AuthSourceControlWriteScope]);
    state.shell = { branch: "main" };
    state.draft = null;
    state.branch = "main";
    state.commits = 0;
    state.run = null;
  });

  it("does not create a feature branch for a server thread without task permission", async () => {
    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.branch).toBe("main");
    expect(state.commits).toBe(0);
    expect(state.shell?.branch).toBe("main");
  });

  it("commits and synchronizes the server thread before details finish loading", async () => {
    state.scopes.add(AuthOrchestrationOperateScope);
    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.branch).toBe("feature");
    expect(state.commits).toBe(1);
    expect(state.shell?.branch).toBe("feature");
  });

  it("keeps ordinary commits available while details load", async () => {
    await renderActions()({ action: "commit" });

    expect(state.commits).toBe(1);
    expect(state.branch).toBe("main");
  });

  it("keeps feature-branch commits available for a local draft", async () => {
    state.shell = null;
    state.draft = { branch: "main", worktreePath: null, envMode: "local" };
    await renderActions()({ action: "commit", featureBranch: true });

    expect(state.commits).toBe(1);
    expect(state.draft.branch).toBe("feature");
  });
});
