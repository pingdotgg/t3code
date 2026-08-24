import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { PiAgentSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type { PiRpcClient } from "../provider/pi/PiRpcClient.ts";
import type { PiRpcCommand, PiRpcResponse } from "../provider/pi/PiRpcProtocol.ts";
import { makePiTextGeneration } from "./PiTextGeneration.ts";

const decodePiSettings = Schema.decodeSync(PiAgentSettings);

it.layer(NodeServices.layer)("PiTextGeneration", (it) =>
  it.effect("generates structured text through an isolated Pi RPC session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: PiRpcCommand[] = [];
        let spawnArgs: ReadonlyArray<string> | undefined;
        const client: PiRpcClient = {
          request: (command) => {
            commands.push(command);
            if (command.type === "get_last_assistant_text") {
              return Effect.succeed({
                type: "response",
                command: command.type,
                success: true,
                data: { text: JSON.stringify({ title: "Connect Pi Coding Agent" }) },
              } satisfies PiRpcResponse);
            }
            return Effect.succeed({
              type: "response",
              command: command.type,
              success: true,
            } satisfies PiRpcResponse);
          },
          send: () => Effect.void,
          events: Stream.make({ type: "agent_end" as const }),
          terminated: Effect.never,
          close: Effect.void,
        };
        const textGeneration = yield* makePiTextGeneration(
          decodePiSettings({ binaryPath: "/opt/bin/pi", homePath: "/tmp/pi-home" }),
          {},
          {
            createClient: (input) => {
              spawnArgs = input.args;
              expect(input.env?.PI_CODING_AGENT_DIR).toBe("/tmp/pi-home");
              return Effect.succeed(client);
            },
          },
        );

        const result = yield* textGeneration.generateThreadTitle({
          cwd: "/tmp/project",
          message: "please connect pi",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("piAgent"),
            "openai/gpt-5.4",
            [{ id: "effort", value: "high" }],
          ),
        });

        expect(result.title).toBe("Connect Pi Coding Agent");
        expect(spawnArgs).toEqual([
          "--no-tools",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
        ]);
        expect(commands).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: "set_model",
              provider: "openai",
              modelId: "gpt-5.4",
            }),
            expect.objectContaining({ type: "set_thinking_level", level: "high" }),
            expect.objectContaining({ type: "prompt" }),
            expect.objectContaining({ type: "get_last_assistant_text" }),
          ]),
        );

        let ompSpawnArgs: ReadonlyArray<string> | undefined;
        const ompTextGeneration = yield* makePiTextGeneration(
          decodePiSettings({ binaryPath: "/opt/bin/omp", homePath: "/tmp/omp-home" }),
          {},
          {
            providerName: "Oh My Pi",
            defaultBinaryPath: "omp",
            args: ["--no-tools", "--no-session", "--no-extensions", "--no-skills"],
            createClient: (input) => {
              ompSpawnArgs = input.args;
              expect(input.env?.PI_CODING_AGENT_DIR).toBe("/tmp/omp-home");
              return Effect.succeed(client);
            },
          },
        );

        yield* ompTextGeneration.generateThreadTitle({
          cwd: "/tmp/project",
          message: "please connect omp",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("omp"),
            "openai/gpt-5.4",
            [],
          ),
        });

        expect(ompSpawnArgs).toEqual([
          "--no-tools",
          "--no-session",
          "--no-extensions",
          "--no-skills",
        ]);
      }),
    ),
  ),
);
