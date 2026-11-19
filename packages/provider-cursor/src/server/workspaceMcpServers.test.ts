// Verifies conversation-specific MCP environments without starting a model.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { cursorWorkspaceMcpServers } from "./workspaceMcpServers.ts";

it.effect("resolves each session's identity for stdio MCPs in the same folder", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "cursor-mcp-thread-" });
    yield* fileSystem.makeDirectory(path.join(root, ".cursor"));
    yield* fileSystem.writeFileString(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          inbox: {
            command: "inbox-server",
            env: {
              T3CODE_THREAD_ID: "${env:T3CODE_THREAD_ID}",
              KEEP: "configured",
            },
          },
          ordinary: { command: "other-server" },
        },
      }),
    );
    for (const threadId of ["thread-one", "thread-two"]) {
      const servers = yield* cursorWorkspaceMcpServers(root, { T3CODE_THREAD_ID: threadId }).pipe(
        Effect.provideService(HostProcess.HomeDirectory, root),
        Effect.provideService(HostProcess.Environment, {}),
      );
      assert.deepEqual(servers.inbox, {
        command: "inbox-server",
        cwd: root,
        env: { T3CODE_THREAD_ID: threadId, KEEP: "configured" },
      });
      assert.notProperty(servers, "ordinary");
    }
    const unbound = yield* cursorWorkspaceMcpServers(root, {}).pipe(
      Effect.provideService(HostProcess.HomeDirectory, root),
      Effect.provideService(HostProcess.Environment, {}),
    );
    assert.deepEqual(unbound.inbox, {
      command: "inbox-server",
      cwd: root,
      env: { T3CODE_THREAD_ID: "", KEEP: "configured" },
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
