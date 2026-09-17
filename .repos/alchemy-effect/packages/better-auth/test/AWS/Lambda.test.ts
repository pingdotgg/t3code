import * as AWS from "alchemy/AWS";
import * as Neon from "alchemy/Neon";
import * as Core from "alchemy/Test/Core";
import * as Test from "alchemy/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import AuthFunctionLive, { AuthFunction } from "./fixtures/auth-handler.ts";
import { AuthHttpError, getJson, postJson, toCookieHeader } from "../http.ts";

const testOptions = {
  providers: Layer.mergeAll(AWS.providers(), Neon.providers()),
};
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "BetterAuthLambda");

let baseUrl: string;

// Lambda function URL cold-start can take well over 60s on a fresh
// deploy — poll readiness before the actual assertions.
const readinessRetry = Effect.retry({
  schedule: Schedule.exponential("2 seconds", 1.5),
  times: 10,
});

beforeAll(
  Effect.gen(function* () {
    yield* sharedStack.destroy();
    const { functionUrl } = yield* sharedStack.deploy(
      Effect.gen(function* () {
        return yield* AuthFunction;
      }).pipe(Effect.provide(AuthFunctionLive)),
    );
    expect(functionUrl).toBeTruthy();
    baseUrl = functionUrl!.replace(/\/+$/, "");

    yield* getJson<{ email: string | null }>(`${baseUrl}/me`).pipe(
      Effect.tapError((error) =>
        Effect.logWarning(`Lambda not ready yet: ${error.message}`),
      ),
      readinessRetry,
    );
  }),
  { timeout: 240_000 },
);

afterAll.skipIf(!!process.env.NO_DESTROY)(sharedStack.destroy(), {
  timeout: 120_000,
});

test(
  "Lambda host: sign-up, sign-in, session against Neon Postgres",
  Effect.gen(function* () {
    const email = "lambda-user@example.com";
    const password = "password1234";

    yield* postJson(`${baseUrl}/auth/sign-up/email`, {
      email,
      password,
      name: "Lambda User",
    }).pipe(
      Effect.filterOrFail(
        (response) =>
          response.status === 200 ||
          response.body.includes("USER_ALREADY_EXISTS"),
        (response) => new AuthHttpError({ url: baseUrl, ...response }),
      ),
    );

    const signIn = yield* postJson(`${baseUrl}/auth/sign-in/email`, {
      email,
      password,
    }).pipe(
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => new AuthHttpError({ url: baseUrl, ...response }),
      ),
    );
    expect(signIn.setCookies.length).toBeGreaterThan(0);
    const cookie = toCookieHeader(signIn.setCookies);

    const me = yield* getJson<{ email: string | null }>(`${baseUrl}/me`, {
      cookie,
    });
    expect(me.email).toBe(email);

    const anonymous = yield* getJson<{ email: string | null }>(`${baseUrl}/me`);
    expect(anonymous.email).toBeNull();
  }),
  { timeout: 120_000 },
);
