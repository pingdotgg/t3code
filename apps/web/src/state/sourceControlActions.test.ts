import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../test/reactHookHarness";

const atoms = vi.hoisted(() => ({
  actionState: Symbol("actionState"),
  pull: Symbol("pull"),
  publishRepository: Symbol("publishRepository"),
  refreshStatus: Symbol("refreshStatus"),
  runStackedAction: Symbol("runStackedAction"),
}));

const commands = vi.hoisted(() => ({
  pull: vi.fn(),
  publishRepository: vi.fn(),
  refreshStatus: vi.fn(),
  runStackedAction: vi.fn(),
}));

const observers = vi.hoisted(() => ({
  commandAtoms: [] as symbol[],
  environmentQueries: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ error: null, isRunning: false, operation: null }),
}));

vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));

vi.mock("./git", () => ({
  gitEnvironment: {
    preparePullRequestThread: Symbol("preparePullRequestThread"),
    pullRequestResolution: vi.fn(),
  },
}));

vi.mock("./query", () => ({
  useEnvironmentQuery: observers.environmentQueries,
}));

vi.mock("./sourceControl", () => ({
  sourceControlEnvironment: { publishRepository: atoms.publishRepository },
}));

vi.mock("./use-atom-command", () => ({
  useAtomCommand: (atom: symbol) => {
    observers.commandAtoms.push(atom);
    if (atom === atoms.pull) return commands.pull;
    if (atom === atoms.publishRepository) return commands.publishRepository;
    if (atom === atoms.refreshStatus) return commands.refreshStatus;
    if (atom === atoms.runStackedAction) return commands.runStackedAction;
    throw new Error("Unexpected command atom");
  },
}));

vi.mock("./vcs", () => ({
  vcsActionManager: {
    resetError: vi.fn(),
    runStackedAction: () => atoms.runStackedAction,
    stateAtom: () => atoms.actionState,
    track: async (
      _registry: unknown,
      _scope: unknown,
      _details: unknown,
      execute: () => Promise<unknown>,
    ) => execute(),
  },
  vcsEnvironment: {
    pull: atoms.pull,
    refreshStatus: atoms.refreshStatus,
  },
}));

import {
  useGitStackedAction,
  useSourceControlPublishRepositoryAction,
  useVcsPullAction,
} from "./sourceControlActions";

const scope = {
  environmentId: EnvironmentId.make("env-1"),
  cwd: "/repo",
};

function mountAction(kind: "pull" | "stacked" | "publish"): () => Promise<unknown> {
  hooks.beginRender();
  if (kind === "pull") {
    const action = useVcsPullAction(scope);
    return () => action.run();
  }
  if (kind === "stacked") {
    const action = useGitStackedAction(scope);
    return () => action.run({ actionId: "action-1", action: "push" });
  }
  const action = useSourceControlPublishRepositoryAction(scope);
  return () =>
    action.run({
      provider: "github",
      repository: "owner/repo",
      visibility: "private",
      remoteName: "origin",
      protocol: "ssh",
    });
}

describe("source-control action status ownership", () => {
  beforeEach(() => {
    hooks.reset();
    observers.commandAtoms = [];
    observers.environmentQueries.mockReset();
    commands.pull.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    commands.publishRepository.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    commands.refreshStatus.mockReset().mockResolvedValue(AsyncResult.success(undefined));
    commands.runStackedAction.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  });

  it.each(["pull", "stacked", "publish"] as const)(
    "%s mounts no status observer and dispatches no refresh after success",
    async (kind) => {
      const run = mountAction(kind);

      expect(observers.environmentQueries).not.toHaveBeenCalled();
      expect(observers.commandAtoms).not.toContain(atoms.refreshStatus);
      await run();

      expect(commands.refreshStatus).not.toHaveBeenCalled();
      const mutation =
        kind === "stacked"
          ? commands.runStackedAction
          : kind === "publish"
            ? commands.publishRepository
            : commands.pull;
      expect(mutation).toHaveBeenCalledTimes(1);
    },
  );
});
