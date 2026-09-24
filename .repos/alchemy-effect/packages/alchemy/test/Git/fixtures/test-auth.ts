/**
 * The suites' auth, in user land, the way a host builds it: one `HttpRouter`
 * middleware in front of every git route. Two shared secrets name two
 * users; anything else is anonymous, and anonymous may read public
 * repositories and nothing more. The engine never sees a credential.
 *
 * So that the suites work out of the box (local dev especially), a
 * deterministic default `GIT_SERVICE_SECRET` is installed into
 * `process.env` at module load unless the caller already exported one.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { GitApi, isRead, RegistryStore } from "@/Git/index.ts";
import { RuntimeContext } from "@/RuntimeContext.ts";

/**
 * The secret every suite authenticates with. Honors a caller-provided
 * `GIT_SERVICE_SECRET` (the deployed-cloud suites may point at a
 * standing deployment); otherwise a deterministic test-only value.
 */
export const TEST_SECRET: string =
  process.env.GIT_SERVICE_SECRET ?? "test-secret-git-service-suite";
/** A second credential, resolved to a second user (for the hook tests). */
export const TEST_SECRET_DEV = "test-secret-git-service-suite-dev";
export const TEST_USER = { id: "e2e", name: "Suite" } as const;
export const TEST_USER_DEV = { id: "dev", name: "Dev" } as const;
process.env.GIT_SERVICE_SECRET ??= TEST_SECRET;

export interface TestUser {
  readonly id: string;
  readonly name: string;
}

/** 401 — no usable credential, on a route that needs one. */
export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  {},
  { httpApiStatus: 401 },
) {}

/**
 * Who is calling, as the middleware resolved it: a user, or `null` for an
 * anonymous read of a public repository. Routes and hooks read it.
 */
export class TestCaller extends Context.Service<
  TestCaller,
  { readonly user: TestUser | null }
>()("test/Git/Caller") {}

/** API schema for typed clients. Authentication is applied to router layers. */
// Client-only error declaration: router middleware returns this error on 401.
class AuthenticationErrors extends HttpApiMiddleware.Service<AuthenticationErrors>()(
  "test/Git/AuthenticationErrors",
  { error: Unauthorized },
) {}
export class TestApi extends GitApi.middleware(AuthenticationErrors) {}

/**
 * The credential a request carries: `git` sends HTTP Basic with the
 * token in the password field, the REST clients a bearer token.
 */
const credential = (
  headers: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  const header = headers.authorization;
  if (header === undefined) return undefined;
  const space = header.indexOf(" ");
  if (space === -1) return undefined;
  const scheme = header.slice(0, space).toLowerCase();
  const rest = header.slice(space + 1).trim();
  if (scheme === "bearer" || scheme === "token") return rest || undefined;
  if (scheme === "basic") {
    const decoded = Buffer.from(rest, "base64").toString("utf8");
    const colon = decoded.indexOf(":");
    return colon === -1 ? undefined : decoded.slice(colon + 1) || undefined;
  }
  return undefined;
};

/** A 401 that makes `git` ask for credentials (or fail with "Authentication failed"). */
const unauthorized = HttpServerResponse.jsonUnsafe(
  { _tag: "Unauthorized" },
  { status: 401, headers: { "www-authenticate": 'Basic realm="git"' } },
);

/**
 * Two secrets, two users; anything else is anonymous. Anonymous callers
 * may read a public repository: the REST and raw reads, the GitHub
 * facade's `GET`s, and a clone or fetch over the wire. Everything else
 * is a 401 with `WWW-Authenticate`, so `git` prompts.
 */
export const TestAuthLive = HttpRouter.middleware<{ provides: TestCaller }>()(
  Effect.gen(function* () {
    const registry = yield* RegistryStore;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const presented = credential(request.headers);
        if (presented === TEST_SECRET) {
          return yield* Effect.provideService(httpEffect, TestCaller, {
            user: TEST_USER,
          });
        }
        if (presented === TEST_SECRET_DEV) {
          return yield* Effect.provideService(httpEffect, TestCaller, {
            user: TEST_USER_DEV,
          });
        }
        if (presented !== undefined) return unauthorized;

        // Anonymous: a read of one public repository, or nothing. A
        // repository that does not exist is the route's 404, so a 401
        // never confirms a private one.
        if (!isRead(request)) return unauthorized;
        const params = yield* HttpRouter.params;
        const owner = params.owner?.toLowerCase();
        const name = params.repo?.toLowerCase().replace(/\.git$/, "");
        if (owner === undefined || name === undefined) return unauthorized;
        const entry = yield* registry
          .resolve(owner, name)
          .pipe(Effect.catchTag("StoreError", () => Effect.succeed(undefined)));
        if (entry !== undefined && !entry.public) return unauthorized;
        return yield* Effect.provideService(httpEffect, TestCaller, {
          user: null,
        });
      }).pipe(Effect.provide(RuntimeContext.phantom));
  }),
).layer;
