import * as Console from "effect/Console";
import * as Effect from "effect/Effect";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as CodexClient from "../../src/client.ts";

const program = Effect.gen(function* () {
  const codexLayer = CodexClient.layerCommand({
    command: process.env.CODEX_BIN ?? "codex",
    args: ["app-server"],
    cwd: process.cwd(),
    logIncoming: true,
    logOutgoing: true,
  });

  yield* Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;

    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      Effect.succeed({
        answers: Object.fromEntries(
          payload.questions.map((question) => [
            question.id,
            {
              answers:
                question.options && question.options.length > 0
                  ? [question.options[0]!.label]
                  : ["ok"],
            },
          ]),
        ),
      }),
    );

    const initialized = yield* client.request("initialize", {
      clientInfo: {
        name: "effect-codex-app-server-probe",
        title: "Effect Codex App Server Probe",
        version: "0.0.0",
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: null,
      },
    });
    yield* Console.log("initialize", JSON.stringify(initialized, null, 2));

    yield* client.notify("initialized", undefined);

    const account = yield* client.request("account/read", {});
    yield* Console.log("account/read", JSON.stringify(account, null, 2));

    const skills = yield* client.request("skills/list", {
      cwds: [process.cwd()],
    });
    yield* Console.log("skills/list", JSON.stringify(skills, null, 2));
  }).pipe(Effect.provide(codexLayer));
});

program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
