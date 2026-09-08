import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { CloudflareHyperdrive } from "../../../src/CloudflareHyperdrive.ts";
import { BetterAuth } from "../../../src/index.ts";

export const HdProject = Neon.Project("BetterAuthHdPg");

export const Hyperdrive = Effect.gen(function* () {
  const project = yield* HdProject;
  return yield* Cloudflare.Hyperdrive.Connection("BetterAuthHd", {
    origin: project.origin,
    // auth reads must never be stale
    caching: { disabled: true },
  });
});

// Hyperdrive's connection string only exists inside the Worker — the Neon
// origin URL drives the deploy-time migration Action instead.
const AuthDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const project = yield* HdProject;
    const connection = yield* Hyperdrive;
    return CloudflareHyperdrive(connection, {
      migrate: project.connectionUri,
    });
  }),
);

export default class HyperdriveAuthWorker extends Cloudflare.Worker<HyperdriveAuthWorker>()(
  "BetterAuthHdWorker",
  {
    main: import.meta.url,
    compatibility: {
      date: "2026-03-17",
      flags: ["nodejs_compat"],
    },
  },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: "/auth",
      emailAndPassword: { enabled: true },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/auth")) {
          return yield* auth.fetch;
        }
        if (request.url.startsWith("/me")) {
          const session = yield* auth
            .getSession()
            .pipe(
              Effect.catchTag("BetterAuthApiError", () => Effect.succeed(null)),
            );
          return yield* HttpServerResponse.json({
            email: session?.user.email ?? null,
          });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(Effect.provide(AuthDatabase)),
) {}
