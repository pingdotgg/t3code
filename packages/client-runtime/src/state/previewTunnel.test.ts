import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";

import { BearerConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { createPreviewTunnelUrlReader } from "./previewTunnel.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PREPARED: PreparedConnection = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.test",
  socketUrl: "wss://remote.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "token" },
  target: new BearerConnectionTarget({
    environmentId: ENVIRONMENT_ID,
    label: "Remote environment",
    connectionId: "connection-1",
  }),
};

describe("preview tunnel url", () => {
  it.live("waits for a reconnecting environment instead of refusing the page", () =>
    Effect.gen(function* () {
      const prepared = Atom.make(Option.none<PreparedConnection>());
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ ticket: "media-ticket", expiresAt: "2999-01-01T00:00:00.000Z" }),
          ),
        ),
      );
      const registry = AtomRegistry.make();
      yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
      const read = createPreviewTunnelUrlReader({
        runtime: Atom.runtime(Layer.succeed(HttpClient.HttpClient, client)),
        registry,
        preparedConnectionAtom: () => prepared,
      });

      const pending = yield* Effect.forkChild(Effect.promise(() => read(ENVIRONMENT_ID)));
      yield* Effect.yieldNow;
      registry.set(prepared, Option.some(PREPARED));

      expect(yield* Fiber.join(pending)).toBe(
        "wss://remote.example.test/api/preview/tunnel?wsTicket=media-ticket",
      );
    }),
  );
});
