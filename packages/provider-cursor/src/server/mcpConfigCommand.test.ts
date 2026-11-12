import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { loadMcpConfigCommand } from "./mcpConfigCommand.ts";

it.live("resolves project MCPs in the thread cwd and preserves t3-code", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-mcp-cwd-" });
    const script = `process.stdout.write(JSON.stringify({mcpServers:{ditto:{type:'http',url:'https://example.test/ditto',headers:{session:process.env.T3CODE_THREAD_ID,cwd:process.cwd()}},'ditto-backroom':{type:'http',url:'https://example.test/backroom'},'t3-code':{type:'http',url:'https://wrong.test'}}}));`;
    const servers = yield* loadMcpConfigCommand({
      environment: {
        ...process.env,
        T3CODE_CURSOR_MCP_CONFIG_COMMAND: JSON.stringify([process.execPath, "-e", script]),
      },
      cwd,
      threadId: "fresh-cursor-thread",
    });
    assert.deepEqual(Object.keys(servers), ["ditto", "ditto-backroom"]);
    assert.deepEqual(servers.ditto, {
      type: "http",
      url: "https://example.test/ditto",
      headers: { session: "fresh-cursor-thread", cwd },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.each([
  "process.stdout.write('secret-invalid-json')",
  "process.stdout.write(JSON.stringify({mcpServers:{bad:{type:'http',url:'file:///secret'}}}))",
  "process.stderr.write('secret-stderr');process.exit(1)",
])("rejects failed or invalid commands without exposing output: %s", (script) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      loadMcpConfigCommand({
        environment: {
          ...process.env,
          T3CODE_CURSOR_MCP_CONFIG_COMMAND: JSON.stringify([process.execPath, "-e", script]),
        },
        cwd: null,
        threadId: "fresh-thread",
      }),
    );
    assert.equal(result._tag, "Failure");
    assert.notInclude(JSON.stringify(result), "secret-");
  }).pipe(Effect.provide(NodeServices.layer)),
);
