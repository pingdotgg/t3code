import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  PluginActionId,
  ProjectId,
  ThreadId,
  type PluginAction,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canOperate: true,
  invoke: vi.fn(),
  alert: vi.fn(),
}));

// The session grant, the invoke RPC and the alert are the boundaries.
vi.mock("react-native", () => ({ Alert: { alert: state.alert } }));
vi.mock("expo-haptics", () => ({
  notificationAsync: async () => {},
  NotificationFeedbackType: { Success: "success" },
}));
vi.mock("./session", () => ({
  readEnvironmentScope: (_environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.canOperate,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: state.invoke,
}));
vi.mock("@t3tools/client-runtime/state/pluginActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/pluginActions")>()),
  createPluginActionEnvironmentAtoms: () => ({ invoke: "invoke", snapshot: () => null }),
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("./atom-registry", () => ({ appAtomRegistry: {} }));
vi.mock("./query", () => ({ useEnvironmentQuery: () => ({ data: null }) }));

import { buildPluginActionPaletteItems } from "../features/keyboard/commandPaletteItems";
import { runPluginAction } from "./plugin-actions";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");
const deploy: PluginAction = {
  id: PluginActionId.make("installation-1:1:deploy"),
  pluginId: "acme.deploy",
  pluginName: "Deploy",
  name: "deploy",
  title: "Deploy this branch",
  target: "thread",
  placements: ["command-palette"],
};
const run = () =>
  runPluginAction({ environmentId, action: deploy, target: { _tag: "thread", threadId } });

beforeEach(() => {
  state.canOperate = true;
  state.invoke.mockReset().mockResolvedValue(AsyncResult.success({ message: "Deployed" }));
  state.alert.mockReset();
});

describe("runPluginAction", () => {
  it("reports that the plugin ran the action", async () => {
    await expect(run()).resolves.toBe(true);
    expect(state.invoke).toHaveBeenCalledOnce();
    expect(state.alert).toHaveBeenCalledWith("Deploy this branch", "Deployed");
  });

  it("reports a refused action as not run", async () => {
    state.invoke.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Forbidden"))));
    await expect(run()).resolves.toBe(false);
    expect(state.alert).toHaveBeenCalledWith("Deploy this branch failed", "Forbidden");
  });

  it("does not invoke once the connection has lost its operate grant", async () => {
    state.canOperate = false;
    await expect(run()).resolves.toBe(false);
    expect(state.invoke).not.toHaveBeenCalled();
  });

  it("rechecks the grant when a palette entry runs after the palette closes", async () => {
    // The palette stores the picked entry and runs it once its modal is dismissed.
    const [entry] = buildPluginActionPaletteItems({
      actions: [deploy],
      canOperate: true,
      environmentId,
      threadId,
      projectId: ProjectId.make("project-1"),
      runAction: (input) => void runPluginAction(input),
    });
    state.canOperate = false;

    entry?.run();
    await Promise.resolve();

    expect(state.invoke).not.toHaveBeenCalled();
  });
});
