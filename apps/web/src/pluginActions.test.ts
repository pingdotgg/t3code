import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  PluginActionId,
  ThreadId,
  type PluginAction,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  canOperate: true,
  invoke: vi.fn(),
  toast: vi.fn(),
}));

// The session grant, the invoke RPC and the toast are the boundaries.
vi.mock("./state/session", () => ({
  readEnvironmentScope: (_environmentId: string, scope: string) =>
    scope === AuthOrchestrationOperateScope && state.canOperate,
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  runAtomCommand: state.invoke,
}));
vi.mock("./state/pluginActions", () => ({
  pluginActionEnvironment: { invoke: "invoke" },
  readPluginActions: () => [],
}));
vi.mock("./rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("./components/ui/toast", () => ({ toastManager: { add: state.toast } }));

import { buildPluginActionItems } from "./components/CommandPalette.logic";
import { runPluginAction } from "./pluginActions";

const environmentId = EnvironmentId.make("environment-plugins");
const threadId = ThreadId.make("thread-plugins");
const deploy: PluginAction = {
  id: PluginActionId.make("plugin-deploy:deploy"),
  pluginId: "plugin-deploy",
  pluginName: "Deploy",
  name: "deploy",
  title: "Deploy this thread",
  target: "thread",
  placements: ["command-palette"],
};
const run = () =>
  runPluginAction({ environmentId, action: deploy, target: { _tag: "thread", threadId } });

beforeEach(() => {
  state.canOperate = true;
  state.invoke.mockReset().mockResolvedValue(AsyncResult.success({ message: null }));
  state.toast.mockReset();
});

describe("runPluginAction", () => {
  it("reports that the plugin ran the action", async () => {
    await expect(run()).resolves.toBe(true);
    expect(state.invoke).toHaveBeenCalledOnce();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("reports a refused action as not run", async () => {
    state.invoke.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Forbidden"))));
    await expect(run()).resolves.toBe(false);
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: "Forbidden" }),
    );
  });

  it("does not invoke once the connection has lost its operate grant", async () => {
    state.canOperate = false;
    await expect(run()).resolves.toBe(false);
    expect(state.invoke).not.toHaveBeenCalled();
    expect(state.toast).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("rechecks the grant when a palette entry offered earlier is chosen", async () => {
    const [entry] = buildPluginActionItems({
      environmentId,
      actions: [deploy],
      canOperate: true,
      threadId,
      projectId: null,
      icon: null,
      runAction: runPluginAction,
    });
    state.canOperate = false;

    await entry?.run();

    expect(state.invoke).not.toHaveBeenCalled();
  });
});
