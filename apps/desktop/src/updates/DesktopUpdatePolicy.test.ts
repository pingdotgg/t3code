import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import * as DesktopUpdatePolicy from "./DesktopUpdatePolicy.ts";

it.effect("keeps T3 Learn's own feed when a T3 Code policy names a mirror", () =>
  Effect.gen(function* () {
    const policy = yield* DesktopUpdatePolicy.DesktopUpdatePolicy;
    assert.equal(policy.feedUrl, undefined);
    assert.equal(policy.mode, "auto");
    assert.isFalse(policy.allowNightly);
  }).pipe(
    Effect.provide(
      DesktopUpdatePolicy.layer.pipe(
        Layer.provide(
          DesktopManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: {
              updates: {
                mode: "auto",
                feedUrl: "https://updates.example.com/t3code",
                allowNightly: false,
              },
            },
          }),
        ),
      ),
    ),
  ),
);
