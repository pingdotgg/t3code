import {
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentId,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  scopes: new Map<string, Set<string>>(),
  requests: [] as { action: string; environmentId: string | null }[],
}));

vi.mock("react", () => ({ useCallback: (callback: unknown) => callback }));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ operation: null, error: null, isRunning: false }),
}));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../components/sourceControlAppAccessToast", () => ({
  suggestAppAccessForRemote: () => Promise.resolve(),
}));
vi.mock("./session", () => ({
  useEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
  readEnvironmentScope: (environmentId: string, scope: string) =>
    state.scopes.get(environmentId)?.has(scope) === true,
}));
vi.mock("./query", () => ({ useEnvironmentQuery: () => ({ refresh: () => {} }) }));
vi.mock("./use-atom-command", () => ({
  useAtomCommand:
    (command: { action: string; environmentId?: string }) =>
    async (input: { environmentId?: string }) => {
      state.requests.push({
        action: command.action,
        environmentId: input.environmentId ?? command.environmentId ?? null,
      });
      return AsyncResult.success({});
    },
}));
vi.mock("./vcs", () => ({
  vcsEnvironment: { init: { action: "init" }, pull: { action: "pull" }, status: () => "status" },
  vcsActionManager: {
    stateAtom: () => "state",
    resetError: () => {},
    track: (_registry: unknown, _target: unknown, _input: unknown, execute: () => unknown) =>
      execute(),
    runStackedAction: (scope: { environmentId: string }) => ({ action: "stack", ...scope }),
  },
}));
vi.mock("./sourceControl", () => ({
  sourceControlEnvironment: { publishRepository: { action: "publish" } },
}));
vi.mock("./git", () => ({
  gitEnvironment: { preparePullRequestThread: { action: "prepare" } },
}));

import {
  useGitStackedAction,
  usePreparePullRequestThreadAction,
  useSourceControlPublishRepositoryAction,
  useVcsInitAction,
  useVcsPullAction,
} from "./sourceControlActions";

const primary = EnvironmentId.make("primary");
const secondary = EnvironmentId.make("secondary");
const scope = { environmentId: secondary, cwd: "/repo" };
const cases = [
  {
    name: "init",
    create: () => {
      const action = useVcsInitAction(scope);
      return { isAllowed: action.isAllowed, run: () => action.run() };
    },
  },
  {
    name: "pull",
    create: () => {
      const action = useVcsPullAction(scope);
      return { isAllowed: action.isAllowed, run: () => action.run() };
    },
  },
  {
    name: "stack",
    create: () => {
      const action = useGitStackedAction(scope);
      return {
        isAllowed: action.isAllowed,
        run: () => action.run({ actionId: "action", action: "commit" }),
      };
    },
  },
  {
    name: "publish",
    create: () => {
      const action = useSourceControlPublishRepositoryAction(scope);
      return {
        isAllowed: action.isAllowed,
        run: () =>
          action.run({
            provider: SourceControlProviderKind.make("github"),
            repository: "owner/repo",
            visibility: "private",
            remoteName: "origin",
            protocol: "ssh",
          }),
      };
    },
  },
  {
    name: "prepare",
    create: () => {
      const action = usePreparePullRequestThreadAction(scope);
      return {
        isAllowed: action.isAllowed,
        run: () => action.run({ reference: "1" }),
      };
    },
  },
] as const;

beforeEach(() => {
  state.scopes = new Map([
    [primary, new Set([AuthSourceControlWriteScope, AuthOrchestrationOperateScope])],
    [secondary, new Set<string>()],
  ]);
  state.requests = [];
});

describe("source control callback grants", () => {
  it.each(cases)("$name uses the selected environment's permission", async ({ create }) => {
    const action = create();
    expect(action.isAllowed).toBe(false);
    expect((await action.run())._tag).toBe("Failure");
    expect(state.requests).toEqual([]);
  });

  it.each(cases)("$name rejects a retained callback after revocation", async ({ create }) => {
    state.scopes.get(secondary)!.add(AuthSourceControlWriteScope);
    const action = create();
    expect(action.isAllowed).toBe(true);
    state.scopes.get(secondary)!.clear();
    expect((await action.run())._tag).toBe("Failure");
    expect(state.requests).toEqual([]);
    expect(create().isAllowed).toBe(false);
  });
});
