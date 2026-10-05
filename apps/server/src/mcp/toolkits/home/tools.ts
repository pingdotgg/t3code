import {
  EnvironmentId,
  HomeWatch,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { homeRoutingDependencies } from "../../homeRouting.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerEnvironment.ServerEnvironment,
    ...homeRoutingDependencies,
  ],
};

const EnvironmentListTool = Tool.make("t3_environment_list", {
  ...shared,
  description:
    "List the environments this thread can act in. Other threads see only their own environment. Home sees every environment the user's desktop app is connected to; relayConnected is false when no desktop window is open to relay calls to them.",
  success: Schema.Struct({
    currentEnvironmentId: EnvironmentId,
    relayConnected: Schema.Boolean,
    environments: Schema.Array(
      Schema.Struct({
        environmentId: EnvironmentId,
        label: Schema.String,
        connected: Schema.Boolean,
        current: Schema.Boolean,
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const ThreadWatchTool = Tool.make("t3_thread_watch", {
  ...shared,
  description:
    "Home only. Choose which threads wake Home. watch/unwatch one thread (threadId, optional environmentId), or watch_all/unwatch_all for every thread in every environment. Threads Home launches are already watched. A watch ends when its thread is settled or archived. Returns what Home now watches.",
  parameters: Schema.Struct({
    action: Schema.Literals(["watch", "unwatch", "watch_all", "unwatch_all"]),
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
  }),
  success: Schema.Struct({ watchAll: Schema.Boolean, watches: Schema.Array(HomeWatch) }),
}).annotate(Tool.Destructive, false);

export const HomeToolkit = Toolkit.make(EnvironmentListTool, ThreadWatchTool);
