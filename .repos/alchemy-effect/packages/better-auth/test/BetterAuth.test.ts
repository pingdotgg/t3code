import { RuntimeContext } from "alchemy";
import { APIError } from "better-auth/api";
import { anonymous } from "better-auth/plugins/anonymous";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  BetterAuth,
  BetterAuthApiError,
  isAPIErrorLike,
  Memory,
  mergeAPIErrorHeaders,
} from "@/index.ts";

const baseOptions = {
  baseURL: "http://localhost:3000",
  emailAndPassword: { enabled: true },
  secret: "test-secret-test-secret-test-secret",
} as const;

/** Serve one web Request through the instance's `fetch` HttpEffect. */
const serve = (
  fetch: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    unknown,
    | RuntimeContext
    | HttpServerRequest.HttpServerRequest
    | import("effect/Scope").Scope
  >,
  request: Request,
) =>
  fetch.pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(request),
    ),
    Effect.flatMap((response) =>
      Effect.sync(() => HttpServerResponse.toWeb(response)),
    ),
    Effect.orDie,
  );

const provideTestEnv = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, Exclude<R, RuntimeContext>> =>
  effect.pipe(Effect.provide(RuntimeContext.phantom)) as Effect.Effect<
    A,
    E,
    Exclude<R, RuntimeContext>
  >;

describe("BetterAuth (memory)", () => {
  it.live("signs up, signs in over HTTP, reads the session", () =>
    Effect.gen(function* () {
      const auth = yield* BetterAuth({
        ...baseOptions,
        basePath: "/auth",
      });

      // sign up through the effectified api proxy
      const signUp = yield* auth.api.signUpEmail({
        body: {
          email: "user@example.com",
          password: "password1234",
          name: "Test User",
        },
      });
      expect(signUp.user.email).toBe("user@example.com");

      // sign in over the HTTP surface to capture the session cookie
      const signInResponse = yield* serve(
        auth.fetch,
        new Request("http://localhost:3000/auth/sign-in/email", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: "user@example.com",
            password: "password1234",
          }),
        }),
      );
      expect(signInResponse.status).toBe(200);
      const setCookies = signInResponse.headers.getSetCookie();
      expect(setCookies.length).toBeGreaterThan(0);
      const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");

      // read the session back with explicit headers
      const session = yield* auth.getSession(new Headers({ cookie }));
      expect(session).not.toBeNull();
      expect(session!.user.email).toBe("user@example.com");

      // and via the ambient request overload
      const ambient = yield* auth.getSession().pipe(
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("http://localhost:3000/anything", {
              headers: { cookie },
            }),
          ),
        ),
      );
      expect(ambient?.user.email).toBe("user@example.com");
    }).pipe(Effect.provide(Memory()), provideTestEnv),
  );

  it.live("maps APIError to BetterAuthApiError with typed fields", () =>
    Effect.gen(function* () {
      const auth = yield* BetterAuth(baseOptions);
      yield* auth.api.signUpEmail({
        body: {
          email: "wrong-pass@example.com",
          password: "password1234",
          name: "Wrong Pass",
        },
      });
      const error = yield* auth.api
        .signInEmail({
          body: {
            email: "wrong-pass@example.com",
            password: "not-the-password",
          },
        })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(BetterAuthApiError);
      expect(error._tag).toBe("BetterAuthApiError");
      expect(error.statusCode).toBe(401);
      expect(error.status).toBe("UNAUTHORIZED");
      expect(error.body?.code).toBeDefined();
      expect(error.headers).toBeInstanceOf(Headers);
    }).pipe(Effect.provide(Memory()), provideTestEnv),
  );

  it.live("plugin endpoints surface on the typed api proxy", () =>
    Effect.gen(function* () {
      const auth = yield* BetterAuth({
        ...baseOptions,
        plugins: [anonymous()],
      });
      // `signInAnonymous` only exists because the anonymous() plugin is in
      // the options — this call type-checks AND runs through the proxy.
      const result = yield* auth.api.signInAnonymous({});
      expect(result?.user.isAnonymous).toBe(true);
    }).pipe(Effect.provide(Memory()), provideTestEnv),
  );

  it("api proxy is not a thenable and caches wrappers", () => {
    const program = Effect.gen(function* () {
      const auth = yield* BetterAuth(baseOptions);
      const api = auth.api as Record<string, unknown>;
      expect(api.then).toBeUndefined();
      expect(api.getSession).toBe(api.getSession);
      expect(typeof api.getSession).toBe("function");
    }).pipe(Effect.provide(Memory()), provideTestEnv, Effect.scoped);
    return Effect.runPromise(program as Effect.Effect<void>);
  });

  it("mergeAPIErrorHeaders preserves symbol-carried set-cookie headers", () => {
    const error = new APIError(
      "UNAUTHORIZED",
      { message: "nope", code: "INVALID_EMAIL_OR_PASSWORD" },
      { "x-visible": "yes" },
    );
    const hidden = new Headers();
    hidden.append("set-cookie", "a=1; Path=/");
    hidden.append("set-cookie", "b=2; Path=/");
    hidden.set("x-hidden", "also");
    (error as unknown as Record<symbol, unknown>)[
      Symbol.for("better-call:api-error-headers")
    ] = hidden;

    expect(isAPIErrorLike(error)).toBe(true);
    const merged = mergeAPIErrorHeaders(error);
    expect(merged.get("x-visible")).toBe("yes");
    expect(merged.get("x-hidden")).toBe("also");
    expect(merged.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);

    const wrapped = BetterAuthApiError.fromAPIError(error);
    expect(wrapped.statusCode).toBe(401);
    expect(wrapped.headers.getSetCookie()).toEqual([
      "a=1; Path=/",
      "b=2; Path=/",
    ]);
  });

  it("isAPIErrorLike rejects non-APIError values", () => {
    expect(isAPIErrorLike(new Error("plain"))).toBe(false);
    expect(isAPIErrorLike({ name: "APIError", statusCode: 401 })).toBe(false);
    expect(isAPIErrorLike(null)).toBe(false);
  });
});
