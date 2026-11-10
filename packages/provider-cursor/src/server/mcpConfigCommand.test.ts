import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { loadMcpConfigCommand } from "./mcpConfigCommand.ts";
import { cursorMcpServers } from "./adapter.ts";

it.live("resolves project MCPs in the thread cwd and preserves t3-code", () =>
  Effect.gen(function* () {
    const script = `process.stdout.write(JSON.stringify({mcpServers:{ditto:{type:'http',url:'https://example.test/ditto',headers:{session:process.env.T3CODE_THREAD_ID,cwd:process.cwd()}},'ditto-backroom':{type:'http',url:'https://example.test/backroom'},'t3-code':{type:'http',url:'https://wrong.test'}}}));`;
    const servers = yield* loadMcpConfigCommand({
      environment: {
        ...process.env,
        T3CODE_CURSOR_MCP_CONFIG_COMMAND: JSON.stringify([process.execPath, "-e", script]),
      },
      cwd: process.cwd(),
      threadId: "fresh-cursor-thread",
    });
    assert.deepEqual(Object.keys(servers), ["ditto", "ditto-backroom"]);
    assert.deepEqual(servers.ditto, {
      type: "http",
      url: "https://example.test/ditto",
      headers: { session: "fresh-cursor-thread", cwd: process.cwd() },
    });
    const merged = cursorMcpServers(undefined, servers);
    assert.deepEqual(Object.keys(merged ?? {}), ["ditto", "ditto-backroom"]);
  }).pipe(Effect.provide(NodeServices.layer)),
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
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    assert.equal(result._tag, "Failure");
    assert.notInclude(JSON.stringify(result), "secret-");
  }).pipe(Effect.provide(NodeServices.layer)),
);
