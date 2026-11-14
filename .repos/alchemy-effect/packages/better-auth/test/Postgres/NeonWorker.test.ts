import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Neon from "@alchemy.run/neon";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AuthHttpError, edgeRetry, getJson, postJson, toCookieHeader } from "../http.ts";
import NeonAuthWorker from "./fixtures/neon-worker.ts";

const providers = Layer.mergeAll(Cloudflare.providers(), Neon.providers());
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers,
});

const Stack = Alchemy.Stack(
  "BetterAuthNeonWorkerTestStack",
  { providers, state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* NeonAuthWorker;
    return { url: worker.url.as<string>() };
  }),
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "Worker -> Neon over the serverless driver (no Hyperdrive, no pg)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const email = "neon-worker@example.com";
    const password = "password1234";

    yield* postJson(`${url}/auth/sign-up/email`, {
      email,
      password,
      name: "Neon Worker User",
    }).pipe(
      Effect.filterOrFail(
        (response) => response.status === 200 || response.body.includes("USER_ALREADY_EXISTS"),
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

    const me = yield* getJson<{ email: string | null }>(`${url}/me`, {
      cookie: toCookieHeader(signIn.setCookies),
    });
    expect(me.email).toBe(email);
  }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:neon",
      "provider:neon:project",
      "live",
    ],
    timeout: 120_000,
  },
);
