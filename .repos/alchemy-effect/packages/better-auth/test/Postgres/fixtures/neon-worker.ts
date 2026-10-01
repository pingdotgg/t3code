import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BetterAuth } from "../../../src/index.ts";
import { Neon as NeonDatabase } from "../../../src/Neon.ts";

export const PgProject = Neon.Project("BetterAuthNeonWorkerPg");

// The serverless driver speaks WebSocket straight from the Worker — no
// Hyperdrive, no pg, no TCP. The connectionUri Output binds into the
// Worker env at deploy and drives the migration Action.
const AuthDatabase = Layer.unwrap(
  Effect.map(PgProject, (project) => NeonDatabase(project.connectionUri)),
);

export default class NeonAuthWorker extends Cloudflare.Worker<NeonAuthWorker>()(
  "BetterAuthNeonWorker",
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
