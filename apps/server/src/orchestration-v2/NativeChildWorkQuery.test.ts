import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { resolveAntigravityInstanceDirectories } from "../provider/antigravityAuthSupport.ts";
import {
  ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
  describeAntigravitySubagentLaunches,
} from "../provider/acp/AntigravityChildWork.ts";
import {
  CHILD,
  invokeStep,
  LAUNCH,
  makeProfile,
  ROOT,
} from "../provider/acp/AntigravityChildWork.testkit.ts";
import * as NativeChildWorkQuery from "./NativeChildWorkQuery.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("antigravity");
const childThreadId = ThreadId.make("thread-child");
const launch = describeAntigravitySubagentLaunches([LAUNCH]);

// A permission-prompt batch in session ROOT, plus an older batch with no launch text in `olderRun`.
const records = (olderRun: string) => ({
  thread: {
    id: childThreadId,
    creationSource: "provider",
    lineage: { parentThreadId: "thread-parent", relationshipToParent: "subagent" },
    forkedFrom: { type: "node", nodeId: "subagent-new" },
  },
  subagents: [
    {
      id: "subagent-new",
      childThreadId,
      driver: "antigravity",
      origin: "provider_native",
      providerInstanceId: instanceId,
      runId: "run-root",
      nativeTaskRef: { nativeId: "35bea692fa95447fbdae6333fec5515f" },
      ...launch,
    },
    {
      id: "subagent-old",
      childThreadId: "thread-old",
      driver: "antigravity",
      origin: "provider_native",
      providerInstanceId: instanceId,
      runId: olderRun,
      nativeTaskRef: { nativeId: "0ld" },
      title: ANTIGRAVITY_SUBAGENT_BATCH_TITLE,
      prompt: "Running",
    },
  ],
  runs: [
    { id: "run-root", providerThreadId: "provider-root" },
    { id: "run-root-earlier", providerThreadId: "provider-root" },
    { id: "run-other", providerThreadId: "provider-other" },
  ],
  providerThreads: [
    { id: "provider-root", providerInstanceId: instanceId, nativeThreadRef: { nativeId: ROOT } },
    {
      id: "provider-other",
      providerInstanceId: instanceId,
      nativeThreadRef: { nativeId: "00000000-0000-4000-8000-000000000000" },
    },
  ],
});

const readChildren = (olderRun: string) =>
  Effect.gen(function* () {
    const query = yield* NativeChildWorkQuery.NativeChildWorkQuery;
    return (yield* query.getNativeChildWork({ threadId: childThreadId })).children;
  }).pipe(
    Effect.provide(
      NativeChildWorkQuery.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(records(olderRun) as never),
          }),
        ),
      ),
    ),
  );

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "native-child-work-" }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
)("NativeChildWorkQuery", (it) => {
  it.effect("weighs only batches from the same agent session", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const { profile } = yield* resolveAntigravityInstanceDirectories(stateDir, instanceId);
      yield* makeProfile({
        profile,
        steps: (logUri) => [
          [
            2,
            127,
            invokeStep({ callId: "x", launches: [LAUNCH], children: [{ id: CHILD, logUri }] }),
          ],
        ],
      });
      const fromOtherSession = yield* readChildren("run-other");
      expect(fromOtherSession.map((child) => child.conversationId)).toEqual([CHILD]);
      // An earlier run in the same session may own the only record.
      expect(yield* readChildren("run-root-earlier")).toEqual([]);
    }),
  );
});
