import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { prepareDevinMcp } from "./DevinMcp.ts";

const decodeConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      mcpServers: Schema.Struct({
        "t3-code": Schema.Struct({
          serverUrl: Schema.String,
          headers: Schema.Struct({ Authorization: Schema.String }),
        }),
      }),
    }),
  ),
);

it.layer(NodeServices.layer)("Devin MCP configuration", (it) => {
  it.effect(
    "isolates simultaneous sessions and removes only the closed session's credentials",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const firstScope = yield* Scope.make();
        const secondScope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(firstScope, Exit.void));
        yield* Effect.addFinalizer(() => Scope.close(secondScope, Exit.void));
        const first = yield* prepareDevinMcp({
          endpoint: "http://127.0.0.1:10001/mcp",
          authorizationHeader: "Bearer first-test-token",
        }).pipe(Effect.provideService(Scope.Scope, firstScope));
        const second = yield* prepareDevinMcp({
          endpoint: "http://127.0.0.1:10002/mcp",
          authorizationHeader: "Bearer second-test-token",
        }).pipe(Effect.provideService(Scope.Scope, secondScope));
        assert.notEqual(first.directory, second.directory);
        const readConfig = (directory: string) =>
          fs
            .readFileString(path.join(directory, ".devin/mcp_config.local.json"))
            .pipe(Effect.map(decodeConfig));
        assert.equal(
          (yield* readConfig(first.directory)).mcpServers["t3-code"].headers.Authorization,
          "Bearer first-test-token",
        );
        assert.equal(
          (yield* readConfig(second.directory)).mcpServers["t3-code"].headers.Authorization,
          "Bearer second-test-token",
        );
        yield* Scope.close(firstScope, Exit.void);
        assert.isFalse(yield* fs.exists(first.directory));
        assert.isTrue(yield* fs.exists(second.directory));
        yield* Scope.close(secondScope, Exit.void);
        assert.isFalse(yield* fs.exists(second.directory));
      }),
  );

  it.effect(
    "fails startup when Devin does not confirm the connection and cleans up credentials",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        let directory = "";
        const failure = yield* Effect.gen(function* () {
          const prepared = yield* prepareDevinMcp({
            endpoint: "http://127.0.0.1:10001/mcp",
            authorizationHeader: "Bearer rejected-test-token",
          });
          directory = prepared.directory;
          yield* prepared.connect({
            request: () => Effect.succeed({ connectionStatus: "auth_required" }),
          });
        }).pipe(Effect.scoped, Effect.flip);
        assert.equal(failure._tag, "AcpTransportError");
        assert.isFalse(yield* fs.exists(directory));
      }),
  );
});
