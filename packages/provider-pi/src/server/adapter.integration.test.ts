import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { makePiAdapterV2 } from "./adapter.ts";
import { parsePiDiscoveredCommands } from "./commands.ts";
import { makePiRpcConnection, type PiRpcSpawnOptions } from "./rpc.ts";

it.live("Pi 1.6.0 projects, expands, and reads only allowed skills in a delegated session", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-pi-skill-policy-" });
    const agentDir = `${cwd}/agent`;
    const allowed = `${agentDir}/extension-skills/allowed/SKILL.md`;
    const denied = `${agentDir}/skills/denied/SKILL.md`;
    const symlink = `${cwd}/linked-skill.md`;
    const allowedMarker = "FIXTURE_ALLOWED_BODY_7235";
    const deniedMarker = "FIXTURE_DENIED_BODY_1864";
    for (const [path, name, marker] of [
      [allowed, "allowed", allowedMarker],
      [denied, "denied", deniedMarker],
    ] as const) {
      yield* fs.makeDirectory(path.slice(0, path.lastIndexOf("/")), { recursive: true });
      yield* fs.writeFileString(
        path,
        `---\nname: ${name}\ndescription: Fixture skill\n---\n${marker}\n`,
      );
    }
    yield* fs.symlink(denied, symlink);
    yield* fs.makeDirectory(`${agentDir}/extensions`);
    yield* fs.writeFileString(
      `${agentDir}/extensions/fixture.ts`,
      `export default function (pi) {
      pi.on("resources_discover", () => ({ skillPaths: ${JSON.stringify([allowed])} }));
      pi.registerCommand("fixture-extension", { handler: async () => {} });
    }`,
    );

    const providerRequests: string[] = [];
    yield* HttpServer.serveEffect()(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        providerRequests.push(yield* request.text);
        const toolCalls = [denied, symlink, allowed].map((path, index) => ({
          index,
          id: `call_fixture_${index}`,
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ path }) },
        }));
        const sendToolCalls = providerRequests.length === 1;
        const chunk = {
          id: `fixture-${providerRequests.length}`,
          object: "chat.completion.chunk",
          model: "test",
          choices: [
            {
              index: 0,
              delta: sendToolCalls
                ? { role: "assistant", tool_calls: toolCalls }
                : { role: "assistant", content: "Done" },
              finish_reason: sendToolCalls ? "tool_calls" : "stop",
            },
          ],
        };
        return HttpServerResponse.text(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          contentType: "text/event-stream",
        });
      }),
    );
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === "UnixPathAddress") return yield* Effect.die("Missing fixture server port");
    yield* fs.writeFileString(
      `${agentDir}/models.json`,
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "fixture-api-key",
            models: [{ id: "test", name: "Fixture", contextWindow: 32_000, maxTokens: 1024 }],
          },
        },
      }),
    );
    const host = yield* HostProcess.Environment;
    // Version-manager shims read the real HOME, so put the real pi and node first on PATH.
    const realBinaryDirectories = yield* spawner.string(
      ChildProcess.make(
        "sh",
        [
          "-c",
          'for tool in pi node; do path=$(mise which "$tool" 2>/dev/null || command -v "$tool") || exit; dirname "$path"; done',
        ],
        { env: host, extendEnv: false },
      ),
    );
    const PATH = [...realBinaryDirectories.trim().split("\n"), host.PATH].join(":");
    const environment = { PATH, HOME: cwd, PI_CODING_AGENT_DIR: agentDir };
    const version = yield* spawner.string(
      ChildProcess.make("pi", ["--version"], { cwd, env: environment, extendEnv: false }),
    );
    assert.equal(version.trim(), "1.6.0");

    const delegatedLaunches: PiRpcSpawnOptions[] = [];
    const recordingSpawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command) && command.args.includes("--no-skills")) {
        delegatedLaunches.push({
          command: command.command,
          args: command.args.map(String),
          cwd,
          env: Object.fromEntries(
            Object.entries(command.options.env ?? {}).map(([key, value]) => [
              key,
              typeof value === "string" ? value : undefined,
            ]),
          ),
        });
      }
      return spawner.spawn(command);
    });
    const instanceId = ProviderInstanceId.make("pi");
    yield* Effect.gen(function* () {
      const adapter = yield* makePiAdapterV2({
        instanceId,
        settings: {
          enabled: true,
          binaryPath: "pi",
          launchArgs: "--approve --offline --provider fixture --model test",
          customModels: [],
        },
        environment,
      });
      const openSession = (sessionId: string, deniedSkills: ReadonlyArray<string>) =>
        adapter.openSession({
          threadId: ThreadId.make(sessionId),
          providerSessionId: ProviderSessionId.make(sessionId),
          modelSelection: { instanceId, model: "fixture/test" },
          runtimePolicy: {
            cwd,
            runtimeMode: "full-access",
            interactionMode: "default",
            deniedSkills,
          },
        });
      yield* openSession("delegated-pi", ["denied"]);
      const error = yield* Effect.flip(
        openSession("delegated-pi-denied-extension-skill", ["allowed"]),
      );
      assert.include(error.message, "denied skill 'allowed'");
      assert.include(error.message, allowed);
      assert.deepEqual(providerRequests, []);
    }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recordingSpawner),
    );
    const [delegatedLaunch] = delegatedLaunches;
    if (delegatedLaunch === undefined) return yield* Effect.die("Missing delegated Pi launch");
    const rpc = yield* makePiRpcConnection(delegatedLaunch);
    const { skills, slashCommands } = parsePiDiscoveredCommands(
      yield* rpc.request({ type: "get_commands" }),
    );
    assert.equal(rpc.sessionCwd, yield* fs.realPath(cwd));
    assert.include(
      slashCommands.map((command) => command.name),
      "fixture-extension",
    );
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["allowed"],
    );

    yield* rpc.request({ type: "prompt", message: "/skill:denied Use $denied and $allowed" });
    const toolResults = new Map<unknown, { isError: unknown; result: unknown }>();
    while (true) {
      const event = yield* Queue.take(rpc.events);
      if (event.type === "agent_end") break;
      if (event.type === "tool_execution_end")
        toolResults.set(event.toolCallId, { isError: event.isError, result: event.result });
    }
    assert.equal(providerRequests.length, 2);
    assert.include(providerRequests[0], allowedMarker);
    assert.notInclude(providerRequests[0], deniedMarker);
    for (const index of [0, 1]) {
      const result = toolResults.get(`call_fixture_${index}`);
      assert.isTrue(result?.isError);
      assert.include(JSON.stringify(result?.result), "belongs to a denied Pi skill");
    }
    const allowedResult = toolResults.get("call_fixture_2");
    assert.isFalse(allowedResult?.isError);
    assert.include(JSON.stringify(allowedResult?.result), allowedMarker);

    yield* rpc.request({ type: "new_session" });
    assert.equal(rpc.sessionCwd, yield* fs.realPath(cwd));
    yield* rpc.request({ type: "prompt", message: "/skill:allowed" });
    yield* Stream.fromQueue(rpc.events).pipe(
      Stream.filter((event) => event.type === "agent_end"),
      Stream.runHead,
    );
    assert.include(providerRequests[2], allowedMarker);
    assert.notInclude(providerRequests[2], deniedMarker);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeHttpServer.layerTest,
        IdAllocator.layer,
        McpProviderSessions.layer,
        TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  ),
);
