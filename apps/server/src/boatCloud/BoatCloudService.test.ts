import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as BoatCloud from "./BoatCloudService.ts";

const ACCOUNT = "me@example.com";

// Boat knows the account and nothing else, so every refresh after the key check fails.
const boatHttp = HttpClient.make((request) =>
  Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      request.url.endsWith("/me")
        ? Response.json({ user: { login: ACCOUNT, email: ACCOUNT } })
        : Response.json({ code: "not_found" }, { status: 404 }),
    ),
  ),
);

const dependencies = Layer.mergeAll(
  ServerSecretStore.layer,
  Layer.succeed(HttpClient.HttpClient, boatHttp),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-boat-cloud-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

it.layer(dependencies)("BoatCloudService", (it) => {
  it.effect("reports connected when the key belongs to the account it already knows", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(config.stateDir, "boat-cloud");
      yield* fs.makeDirectory(directory, { recursive: true });
      // A disconnect keeps the account, so a reconnect finds it already recorded.
      yield* fs.writeFileString(
        path.join(directory, "state.json"),
        JSON.stringify({ account: ACCOUNT, machines: [], environment: "base" }),
      );

      const status = yield* Effect.gen(function* () {
        const boatCloud = yield* BoatCloud.BoatCloudService;
        return yield* boatCloud.connect({ apiKey: "boat_test" });
      }).pipe(Effect.provide(BoatCloud.layer));

      assert.isTrue(status.connected);
      assert.strictEqual(status.account, ACCOUNT);
    }),
  );
});
