import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Test from "alchemy/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import AuthWorker from "./fixtures/auth-worker.ts";
import {
  AuthHttpError,
  edgeRetry,
  getJson,
  postJson,
  toCookieHeader,
} from "../http.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const Stack = Alchemy.Stack(
  "BetterAuthD1TestStack",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* AuthWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "auto-migrated D1 worker: sign-up, sign-in, session",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const email = "d1-user@example.com";
    const password = "password1234";

    // Deploy already ran the schema migration Action — sign-up proves the
    // tables exist. A leftover user from an interrupted prior run (with
    // NO_DESTROY) is fine: fall through to sign-in. The retry also rides
    // out workers.dev subdomain propagation (Cloudflare's 404 HTML page).
    yield* postJson(`${url}/auth/sign-up/email`, {
      email,
      password,
      name: "D1 User",
    }).pipe(
      Effect.filterOrFail(
        (response) =>
          response.status === 200 ||
          response.body.includes("USER_ALREADY_EXISTS"),
        (response) => new AuthHttpError({ url, ...response }),
      ),
      edgeRetry,
    );

    const signIn = yield* postJson(`${url}/auth/sign-in/email`, {
      email,
      password,
    }).pipe(
      Effect.filterOrFail(
        (response) => response.status === 200,
        (response) => new AuthHttpError({ url, ...response }),
      ),
    );
    expect(signIn.setCookies.length).toBeGreaterThan(0);
    const cookie = toCookieHeader(signIn.setCookies);

    // session round-trip through the worker's getSession route
    const me = yield* getJson<{ email: string | null }>(`${url}/me`, {
      cookie,
    });
    expect(me.email).toBe(email);

    // anonymous request resolves a null session, not an error
    const anonymous = yield* getJson<{ email: string | null }>(`${url}/me`);
    expect(anonymous.email).toBeNull();
  }),
  { timeout: 120_000 },
);

test(
  "second deploy is a no-op for the migration Action",
  Effect.gen(function* () {
    // beforeAll deployed once; deploying again must succeed quickly with
    // the migration Action's input hash unchanged (no re-migration, no
    // failure on existing tables).
    const { url } = yield* deploy(Stack);
    const me = yield* getJson<{ email: string | null }>(`${url}/me`).pipe(
      edgeRetry,
    );
    expect(me.email).toBeNull();
  }),
  { timeout: 120_000 },
);
