import * as Effect from "effect/Effect";
import * as Console from "effect/Console";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as AcpClient from "../../src/client.ts";

const program = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make("cursor-agent", ["acp"], {
    cwd: process.cwd(),
    shell: process.platform === "win32",
  });
  const handle = yield* spawner.spawn(command);
  const acpLayer = AcpClient.layerChildProcess(handle, {
    logIncoming: true,
    logOutgoing: true,
  });

  yield* Effect.gen(function* () {
    const acp = yield* AcpClient.AcpClient;

    yield* acp.handleRequestPermission(() =>
      Effect.succeed({
        outcome: {
          outcome: "selected",
          optionId: "allow",
        },
      }),
    );
    // yield* acp.handleSessionUpdate((notification) =>
    //   Console.log("session/update", JSON.stringify(notification)),
    // );

    const initialized = yield* acp.agent.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: {
          parameterizedModelPicker: true,
        },
      },
      clientInfo: {
        name: "effect-acp-example",
        version: "0.0.0",
      },
    });
    yield* Console.log("initialized", JSON.stringify(initialized, null, 4));

    const session = yield* acp.agent.createSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    const config = yield* acp.agent.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "claude-opus-4-6",
    });

    yield* Console.log("config", JSON.stringify(config, null, 4));

    const result = yield* acp.agent.prompt({
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: "Illustrate your ability to create todo lists and then execute all of them. Do not write the list to disk, illustrate your built in ability!",
        },
      ],
    });

    yield* Console.log("prompt result", JSON.stringify(result));
    yield* acp.agent.cancel({ sessionId: session.sessionId });
  }).pipe(Effect.provide(acpLayer));
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
