import { ensureFloci } from "@alchemy.run/aws/Local/Floci";
import { expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";

for (const mode of ["config", "environment"] as const) {
  it.live(
    `external Floci fails without Docker fallback (${mode})`,
    () =>
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const previous = {
              PATH: process.env.PATH,
              ALCHEMY_FLOCI_EXTERNAL: process.env.ALCHEMY_FLOCI_EXTERNAL,
            };
            process.env.PATH = "";
            if (mode === "environment") {
              process.env.ALCHEMY_FLOCI_EXTERNAL = "1";
            } else {
              delete process.env.ALCHEMY_FLOCI_EXTERNAL;
            }
            return previous;
          }),
          (previous) =>
            Effect.sync(() => {
              for (const [key, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[key];
                else process.env[key] = value;
              }
            }),
        );
        // Port zero cannot be a reachable gateway; Docker is also unavailable.
        const error = yield* ensureFloci({
          // Omitted in environment mode: an explicit value overrides the env var.
          external: mode === "config" ? true : undefined,
          port: 0,
          elbListenerPorts: [],
          cloudfrontEdgePorts: [],
        }).pipe(Effect.flip);
        expect(error._tag).toBe("FlociError");
        expect(error.message).toBe("external floci server unavailable at http://localhost:0");
      }),
    { exclusive: true, timeout: 15_000, tags: ["unit", "provider:aws", "local"] },
  );
}
