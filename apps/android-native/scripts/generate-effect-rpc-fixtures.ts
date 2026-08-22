import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ClientOrchestrationCommand,
  OrchestrationShellStreamItem,
  OrchestrationThreadStreamItem,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../protocol/src/test/resources/effect-rpc.json");
const encodeCommand = Schema.encodeSync(ClientOrchestrationCommand);
const encodeShellItem = Schema.encodeSync(OrchestrationShellStreamItem);
const encodeThreadItem = Schema.encodeSync(OrchestrationThreadStreamItem);
const serialization = RpcSerialization.json.makeUnsafe();

const startCommand = encodeCommand({
  type: "thread.turn.start",
  commandId: "command-1",
  threadId: "thread-1",
  message: {
    messageId: "message-1",
    role: "user",
    text: "Hello from Kotlin",
    attachments: [],
  },
  modelSelection: {
    instanceId: "codex",
    model: "gpt-5.6-sol",
  },
  titleSeed: "Hello from Kotlin",
  runtimeMode: "full-access",
  interactionMode: "default",
  bootstrap: {
    createThread: {
      projectId: "project-1",
      title: "Hello from Kotlin",
      modelSelection: {
        instanceId: "codex",
        model: "gpt-5.6-sol",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-08-08T00:00:00.000Z",
    },
  },
  createdAt: "2026-08-08T00:00:00.000Z",
});

const encode = (message: unknown) => JSON.parse(serialization.encode(message) as string);
const modelSelection = { instanceId: "codex", model: "gpt-5.6-sol" } as const;
const timestamp = "2026-08-08T00:00:00.000Z";
const threadShell = {
  id: "thread-1",
  projectId: "project-1",
  title: "Hello from Kotlin",
  modelSelection,
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};
const fixtures = {
  generatedFrom: {
    contracts: "packages/contracts/src/orchestration.ts",
    serialization: "effect/unstable/rpc/RpcSerialization.json",
  },
  client: {
    request: encode({
      _tag: "Request",
      id: 1,
      tag: "orchestration.dispatchCommand",
      payload: startCommand,
      headers: [],
    }),
    interrupt: encode({ _tag: "Interrupt", requestId: 1 }),
    ack: encode({ _tag: "Ack", requestId: 1 }),
    ping: encode({ _tag: "Ping" }),
    eof: encode({ _tag: "Eof" }),
  },
  server: {
    chunk: encode({
      _tag: "Chunk",
      requestId: 2,
      values: [{ kind: "synchronized" }],
    }),
    success: encode({
      _tag: "Exit",
      requestId: 1,
      exit: { _tag: "Success", value: { sequence: 42 } },
    }),
    failure: encode({
      _tag: "Exit",
      requestId: 1,
      exit: {
        _tag: "Failure",
        cause: [
          {
            _tag: "Fail",
            error: {
              _tag: "OrchestrationDispatchCommandError",
              message: "Rejected fixture command.",
            },
          },
        ],
      },
    }),
    defect: encode({ _tag: "Defect", defect: { message: "Fixture defect." } }),
    pong: encode({ _tag: "Pong" }),
    protocolError: encode({
      _tag: "ClientProtocolError",
      error: { _tag: "RpcClientError", reason: "Protocol", message: "Fixture protocol error." },
    }),
  },
  domain: {
    shellSnapshot: encodeShellItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        projects: [
          {
            id: "project-1",
            title: "T3 Code",
            workspaceRoot: "/repo",
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
        threads: [threadShell],
        updatedAt: timestamp,
      },
    }),
    threadSnapshot: encodeThreadItem({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 10,
        thread: {
          ...threadShell,
          deletedAt: null,
          messages: [],
          proposedPlans: [],
          activities: [],
          checkpoints: [],
        },
      },
    }),
    assistantDelta: encodeThreadItem({
      kind: "event",
      event: {
        sequence: 11,
        eventId: "event-1",
        aggregateKind: "thread",
        aggregateId: "thread-1",
        occurredAt: timestamp,
        commandId: "command-1",
        causationEventId: null,
        correlationId: "command-1",
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: "thread-1",
          messageId: "message-1",
          role: "assistant",
          text: "Hello",
          attachments: [],
          turnId: "turn-1",
          streaming: true,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      },
    }),
  },
};

const contents = `${JSON.stringify(fixtures, null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== contents) {
    throw new Error("Effect RPC fixtures are stale. Run `pnpm fixtures` from apps/android-native.");
  }
  console.log("Effect RPC fixtures are current.");
} else {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, contents);
  console.log(`Wrote ${output}`);
}
