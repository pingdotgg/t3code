import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as SecureRandom from "effect/crypto/SecureRandom";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { CLAUDE_DEFAULT_INSTANCE_ID, makeClaudeQueryOptions } from "./ClaudeAdapterV2.ts";

it.effect(
  "Claude SDK hides a denied skill, blocks slash and Skill invocation, and denies Read",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const env = yield* HostProcess.Environment;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-skills-" });
      const allowedName = "allowed-fixture";
      const deniedName = "denied-fixture";
      const allowedBody = "ALLOWED_FIXTURE_BODY_60442";
      const deniedBody = "DENIED_FIXTURE_BODY_58229";
      const deniedDirectory = path.join(directory, "skills", deniedName);
      const deniedPath = path.join(deniedDirectory, "SKILL.md");
      for (const [name, marker] of [
        [allowedName, allowedBody],
        [deniedName, deniedBody],
      ] as const) {
        const skillDir = path.join(directory, "skills", name);
        yield* fileSystem.makeDirectory(skillDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(skillDir, "SKILL.md"),
          `---\nname: ${name}\ndescription: Fixture for ${name}\n---\n${marker}\n`,
        );
      }
      const requests: string[] = [];
      const toolCalls = [
        {
          type: "tool_use",
          id: "toolu_fixture_skill",
          name: "Skill",
          input: { skill: deniedName },
        },
        {
          type: "tool_use",
          id: "toolu_fixture_read",
          name: "Read",
          input: { file_path: deniedPath },
        },
      ];
      yield* Layer.build(
        HttpServer.serve(
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            if (!request.url.startsWith("/v1/messages"))
              return HttpServerResponse.empty({ status: 404 });
            const body = yield* request.text;
            requests.push(body);
            const invokeTools =
              body.includes(allowedBody) && !body.includes('"type":"tool_result"');
            const message = {
              id: "msg_fixture",
              type: "message",
              role: "assistant",
              model: "claude-haiku-4-5",
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            };
            let events = "";
            const send = (type: string, data = {}) => {
              events += `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
            };
            send("message_start", { message });
            if (invokeTools) {
              for (const [index, call] of toolCalls.entries()) {
                send("content_block_start", { index, content_block: { ...call, input: {} } });
                send("content_block_delta", {
                  index,
                  delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) },
                });
                send("content_block_stop", { index });
              }
            } else {
              send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
              send("content_block_delta", {
                index: 0,
                delta: { type: "text_delta", text: "Fixture complete." },
              });
              send("content_block_stop", { index: 0 });
            }
            send("message_delta", {
              delta: { stop_reason: invokeTools ? "tool_use" : "end_turn", stop_sequence: null },
              usage: { output_tokens: 1 },
            });
            send("message_stop");
            return HttpServerResponse.text(events, { contentType: "text/event-stream" });
          }),
        ),
      );
      const { address } = yield* HttpServer.HttpServer;
      if (address._tag === "UnixPathAddress") throw new Error("Expected a loopback port");
      const random = yield* SecureRandom.SecureRandom;
      const run = async (name: string, nativeThreadId: string) => {
        const options = makeClaudeQueryOptions({
          modelSelection: { instanceId: CLAUDE_DEFAULT_INSTANCE_ID, model: "haiku" },
          nativeThreadId,
          resume: false,
          cwd: directory,
          environment: {
            PATH: env.PATH,
            HOME: directory,
            CLAUDE_CONFIG_DIR: directory,
            ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
            ANTHROPIC_API_KEY: "fixture-key",
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            DISABLE_TELEMETRY: "1",
          },
          skillDeny: { names: [deniedName], readRules: [`Read(/${deniedDirectory}/**)`] },
          permissionMode: "dontAsk",
          allowedTools: ["Skill", "Read"],
        });
        await using session = query({
          prompt: `/${name}`,
          options: {
            ...options,
            pathToClaudeCodeExecutable: "claude",
            persistSession: false,
            maxTurns: 2,
          },
        });
        const commands = await session.supportedCommands();
        expect(commands.map((command) => command.name)).toContain(allowedName);
        expect(commands.map((command) => command.name)).not.toContain(deniedName);
        const messages: SDKMessage[] = [];
        for await (const message of session) messages.push(message);
        return messages;
      };
      const deniedSessionId = yield* random.uuidV4();
      const slash = yield* Effect.promise(() => run(deniedName, deniedSessionId));
      expect(JSON.stringify(slash)).not.toContain(deniedBody);
      expect(JSON.stringify(slash)).toContain("skillOverrides");
      const allowedSessionId = yield* random.uuidV4();
      const allowed = yield* Effect.promise(() => run(allowedName, allowedSessionId));
      expect(allowed).toContainEqual(
        expect.objectContaining({ type: "result", subtype: "success" }),
      );
      expect(requests[0]).toContain(allowedBody);
      expect(requests.join("\n")).not.toContain(deniedBody);
      for (const tool of toolCalls) {
        const results = allowed.flatMap((entry) =>
          entry.type === "user" && Array.isArray(entry.message.content)
            ? entry.message.content
            : [],
        );
        expect(results).toContainEqual(
          expect.objectContaining({ type: "tool_result", tool_use_id: tool.id, is_error: true }),
        );
      }
    }).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeCrypto.layer))),
);
