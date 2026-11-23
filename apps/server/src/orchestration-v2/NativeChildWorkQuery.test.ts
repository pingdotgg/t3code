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
// `rootThreadSession` is where the root provider thread points now; a rollback moves it.
const records = (olderRun: string, rootThreadSession: string) => ({
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
    { id: "run-root", providerThreadId: "provider-root", activeAttemptId: "attempt-root" },
    {
      id: "run-root-earlier",
      providerThreadId: "provider-root",
      activeAttemptId: "attempt-root-earlier",
    },
    { id: "run-other", providerThreadId: "provider-other", activeAttemptId: null },
  ],
  attempts: [
    { id: "attempt-root", nativeThreadId: ROOT },
    { id: "attempt-root-earlier", nativeThreadId: ROOT },
  ],
  providerThreads: [
    {
      id: "provider-root",
      providerInstanceId: instanceId,
      nativeThreadRef: { nativeId: rootThreadSession },
    },
    {
      id: "provider-other",
      providerInstanceId: instanceId,
      nativeThreadRef: { nativeId: "00000000-0000-4000-8000-000000000000" },
    },
  ],
});

const readChildren = (olderRun: string, rootThreadSession = ROOT) =>
  Effect.gen(function* () {
    const query = yield* NativeChildWorkQuery.NativeChildWorkQuery;
    return (yield* query.getNativeChildWork({ threadId: childThreadId })).children;
  }).pipe(
    Effect.provide(
      NativeChildWorkQuery.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(records(olderRun, rootThreadSession) as never),
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
      // After a rollback, kept batches still read the session they ran in.
      const rolledBack = "1a7f8b0c-3c55-4c1e-9a43-5d0e2b6f9c11";
      expect(
        (yield* readChildren("run-other", rolledBack)).map((child) => child.conversationId),
      ).toEqual([CHILD]);
      expect(yield* readChildren("run-root-earlier", rolledBack)).toEqual([]);
    }),
  );
});

const memberThreadId = ThreadId.make("thread-swarm-member");
const swarmThreadId = ThreadId.make("thread-swarm");
// A swarm worker's thread hangs off the swarm thread, whose workflow names the worker's session.
const swarmRecords = (threadId: string) =>
  threadId === memberThreadId
    ? {
        thread: {
          id: memberThreadId,
          creationSource: "provider",
          lineage: { parentThreadId: swarmThreadId, relationshipToParent: "subagent" },
          forkedFrom: { type: "node", nodeId: "member-node" },
        },
      }
    : threadId === swarmThreadId
      ? {
          thread: { id: swarmThreadId, lineage: { parentThreadId: "thread-root" } },
          subagents: [
            {
              id: "member-node",
              childThreadId: memberThreadId,
              driver: "antigravity",
              providerInstanceId: instanceId,
              runId: null,
              prompt: "Read it",
            },
          ],
        }
      : {
          subagents: [
            {
              childThreadId: swarmThreadId,
              driver: "antigravity",
              providerInstanceId: instanceId,
              workflow: {
                phases: [],
                agents: [
                  {
                    index: 0,
                    label: "reader",
                    state: "completed",
                    agentId: CHILD,
                    childThreadId: memberThreadId,
                    prompt: "Read README.md and report the marker",
                  },
                ],
              },
            },
          ],
        };

it.layer(
  Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "native-swarm-work-" }).pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
)("NativeChildWorkQuery swarm", (it) => {
  it.effect("reads a swarm worker's own transcript", () =>
    Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const { profile } = yield* resolveAntigravityInstanceDirectories(stateDir, instanceId);
      yield* makeProfile({ profile, steps: () => [] });
      const children = yield* Effect.gen(function* () {
        const query = yield* NativeChildWorkQuery.NativeChildWorkQuery;
        return (yield* query.getNativeChildWork({ threadId: memberThreadId })).children;
      }).pipe(
        Effect.provide(
          NativeChildWorkQuery.layer.pipe(
            Layer.provide(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadRecords: (threadId) => Effect.succeed(swarmRecords(threadId) as never),
              }),
            ),
          ),
        ),
      );
      expect(children.map(({ conversationId, role }) => [conversationId, role])).toEqual([
        [CHILD, "reader"],
      ]);
      expect(children[0]?.steps?.at(-1)?.text).toBe("marker 4242 found");
    }),
  );
});
