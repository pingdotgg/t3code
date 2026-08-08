import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ClientOrchestrationCommand } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";

const here = dirname(fileURLToPath(import.meta.url));
const output = resolve(here, "../protocol/src/test/resources/effect-rpc.json");
const encodeCommand = Schema.encodeSync(ClientOrchestrationCommand);
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
