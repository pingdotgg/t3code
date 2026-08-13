import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DevinSettings } from "@t3tools/contracts";

import { checkDevinProviderStatus } from "./DevinProvider.ts";

const decodeDevinSettings = Schema.decodeSync(DevinSettings);

const settings = decodeDevinSettings({});

it.layer(NodeServices.layer)("DevinProvider smoke", (it) => {
  it.effect("validates a real Devin CLI when installed and authenticated", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkDevinProviderStatus(settings).pipe(Effect.timeout(60_000));

      if (!snapshot.installed) {
        yield* Effect.logWarning("Devin CLI not available on PATH; skipping smoke test.");
        return;
      }

      if (snapshot.status !== "ready") {
        yield* Effect.logWarning(
          `Devin CLI installed but status is ${snapshot.status}; skipping smoke test.`,
        );
        return;
      }

      yield* Effect.sync(() => {
        expect(snapshot.models.length).toBeGreaterThan(0);
      });
    }),
  );
});
