import { assert, describe, it } from "@effect/vitest";
import { OpenWithEntryId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as DesktopOpenWith from "../../shell/DesktopOpenWith.ts";
import { openWith, resolveOpenWithPresentations } from "./openWith.ts";

describe("Open With IPC methods", () => {
  it.effect("encodes presentations and delegates launch inputs", () =>
    Effect.gen(function* () {
      const opened = yield* Ref.make<unknown>(null);
      const entryId = OpenWithEntryId.make("terminal");
      const layer = Layer.succeed(
        DesktopOpenWith.DesktopOpenWith,
        DesktopOpenWith.DesktopOpenWith.of({
          resolvePresentations: Effect.succeed([
            { entryId, available: true, iconDataUrl: "data:image/png;base64,abc" },
          ]),
          open: (input) => Ref.set(opened, input),
        }),
      );

      assert.deepEqual(
        yield* resolveOpenWithPresentations.handler(undefined).pipe(Effect.provide(layer)),
        [{ entryId: "terminal", available: true, iconDataUrl: "data:image/png;base64,abc" }],
      );
      yield* openWith
        .handler({
          environmentId: "primary",
          entryId: "terminal",
          directory: "/tmp/project",
        })
        .pipe(Effect.provide(layer));
      assert.deepEqual(yield* Ref.get(opened), {
        environmentId: "primary",
        entryId: "terminal",
        directory: "/tmp/project",
      });
    }),
  );
});
