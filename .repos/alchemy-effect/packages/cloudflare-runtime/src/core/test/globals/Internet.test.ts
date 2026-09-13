import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Internet from "../../globals/Internet.ts";

const services = Layer.provide(Internet.InternetLive, NodeServices.layer);

describe("globals/Internet", () => {
  it.effect(
    "produces an internet service config that allows public + private addresses",
    () =>
      Effect.gen(function* () {
        const internet = yield* Internet.Internet;
        expect(internet.name).toBe("internet");
        expect(internet).toMatchObject({
          network: {
            allow: expect.arrayContaining(["public", "private"]),
            deny: expect.any(Array),
            tlsOptions: expect.objectContaining({ trustBrowserCas: true }),
          },
        });
      }).pipe(Effect.provide(services)),
  );
});
