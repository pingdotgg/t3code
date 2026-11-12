import type { PublicOrigin } from "@alchemy.run/cloudflare/Hyperdrive";
import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

/**
 * Create a Hyperdrive configuration OUTSIDE the stack — standing in for one
 * made in the dashboard or by another system — and delete it when the
 * scope closes, so a failing test never leaks it.
 */
export const outOfBandConfig = (accountId: string, name: string, origin: PublicOrigin) =>
  Effect.acquireRelease(
    hyperdrive
      .createConfig({
        accountId,
        name,
        origin: {
          scheme: origin.scheme,
          host: origin.host,
          port: origin.port ?? 5432,
          database: origin.database,
          user: origin.user,
          password: Redacted.value(origin.password),
        },
      })
      .pipe(
        // A just-provisioned Neon database is briefly unreachable.
        Effect.retry({
          while: (error) => error._tag === "HyperdriveOriginUnavailable",
          schedule: Schedule.spaced("3 seconds"),
          times: 20,
        }),
      ),
    (config) =>
      hyperdrive.deleteConfig({ accountId, hyperdriveId: config.id }).pipe(
        Effect.catchTag("HyperdriveConfigNotFound", () => Effect.void),
        Effect.orDie,
      ),
  );
