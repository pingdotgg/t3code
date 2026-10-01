import * as Lambda from "alchemy/AWS/Lambda";
import * as Neon from "alchemy/Neon";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";
import { BetterAuth } from "../../../src/index.ts";
import { Neon as NeonDatabase } from "../../../src/Neon.ts";

const main = path.resolve(import.meta.dirname, "auth-handler.ts");

export const AuthDb = Neon.Project("BetterAuthLambdaPg");

// connectionUri is an Output: bound into the Lambda environment at deploy,
// read back at runtime; the same source drives the deploy-time migration
// Action. The serverless driver is the optimal Lambda -> Neon pairing —
// WebSocket-based, no `pg` install into the artifact needed.
const AuthDatabase = Layer.unwrap(
  Effect.map(AuthDb, (project) => NeonDatabase(project.connectionUri)),
);

export class AuthFunction extends Lambda.Function<Lambda.Function>()(
  "BetterAuthFunction",
) {}

export default AuthFunction.make(
  {
    main,
    url: true,
    // password hashing (scrypt) + the auth bundle need more than the
    // 128 MB default, and cold start + Neon round-trips more than the
    // 3 s default timeout
    memorySize: 512,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const auth = yield* BetterAuth({
      basePath: "/auth",
      emailAndPassword: { enabled: true },
    });

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        // On Lambda the request url is absolute — route on the pathname.
        const pathname = new URL(request.url, "http://lambda").pathname;
        if (pathname.startsWith("/auth")) {
          return yield* auth.fetch;
        }
        if (pathname.startsWith("/me")) {
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
);
