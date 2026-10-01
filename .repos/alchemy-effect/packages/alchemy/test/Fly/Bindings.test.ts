import * as Fly from "@/Fly";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import BindingsApi from "./fixtures/bindings-api.ts";
import {
  BoxKey,
  Marker,
  PLAINTEXT,
  PublicIp,
  SECRET_NAME,
  SignKey,
  Site,
} from "./fixtures/bindings-shared.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Fly.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class NotReady extends Data.TaggedError("NotReady")<{
  status: number;
  body?: unknown;
}> {
  override get message() {
    return this.body === undefined
      ? `status ${this.status}`
      : `status ${this.status}: ${JSON.stringify(this.body)}`;
  }
}

const Stack = Alchemy.Stack(
  "FlyBindingsFixture",
  {
    providers: Fly.providers(),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const site = yield* Site;
    const secret = yield* Marker;
    const box = yield* BoxKey;
    const signing = yield* SignKey;
    const ip = yield* PublicIp;
    const api = yield* BindingsApi;
    return {
      appName: site.appName,
      secretName: secret.name,
      boxName: box.name,
      signName: signing.name,
      ip: ip.ip,
      url: api.url ?? `https://${site.appName}.fly.dev`,
    };
  }),
);

const stack = beforeAll(deploy(Stack), { timeout: 180_000 });

afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
  timeout: 120_000,
});

const retryTransient = {
  while: (e: { _tag?: string; status?: number }) =>
    e._tag === "NotReady" &&
    (e.status === 0 ||
      e.status === 404 ||
      e.status === 502 ||
      e.status === 503),
  schedule: Schedule.exponential("500 millis"),
  times: 20,
} as const;

/** Decode the body, turning any non-200 (or undecodable body) into `NotReady`. */
const readJson = (
  res: HttpClientResponse.HttpClientResponse,
): Effect.Effect<unknown, NotReady> =>
  res.json.pipe(
    Effect.catch(() => Effect.fail(new NotReady({ status: res.status }))),
    Effect.flatMap((body) =>
      res.status === 200
        ? Effect.succeed(body)
        : Effect.fail(new NotReady({ status: res.status, body })),
    ),
  );

const getJson = (path: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(`${url}${path}`).pipe(
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () => Effect.fail(new NotReady({ status: 0 })),
      }),
      Effect.flatMap(readJson),
      Effect.retry(retryTransient),
    );
  });

const postJson = (path: string, body: unknown) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(
      HttpClientRequest.post(`${url}${path}`).pipe(
        HttpClientRequest.bodyJsonUnsafe(body),
      ),
    ).pipe(
      Effect.timeoutOrElse({
        duration: "8 seconds",
        orElse: () => Effect.fail(new NotReady({ status: 0 })),
      }),
      Effect.flatMap(readJson),
      Effect.retry(retryTransient),
    );
  });

describe("Fly Bindings", () => {
  test(
    "fixture is reachable over fly.dev",
    Effect.gen(function* () {
      const out = yield* stack;
      expect(out.url).toContain(".fly.dev");
      expect(out.ip).toEqual(expect.any(String));
      const body = (yield* getJson("/health")) as {
        ok: boolean;
        hasToken?: boolean;
        hasAppName?: boolean;
        hasSecretName?: boolean;
      };
      expect(body.ok).toEqual(true);
      expect(body.hasToken).toEqual(true);
      expect(body.hasAppName).toEqual(true);
      expect(body.hasSecretName).toEqual(true);
    }).pipe(logLevel),
    { timeout: 120_000 },
  );

  describe("GetSecret", () => {
    test(
      "reads the App secret from the Service",
      Effect.gen(function* () {
        const out = yield* stack;
        const body = (yield* getJson("/secret")) as {
          ok: boolean;
          name: string;
          hasValue: boolean;
        };
        expect(body.ok).toEqual(true);
        expect(body.name).toEqual(out.secretName);
        expect(body.name).toEqual(SECRET_NAME);
        expect(body.hasValue).toEqual(true);
      }).pipe(logLevel),
      { timeout: 60_000 },
    );
  });

  describe("ListSecrets", () => {
    test(
      "lists secrets on the App from the Service",
      Effect.gen(function* () {
        const out = yield* stack;
        const body = (yield* getJson("/secrets")) as { names: string[] };
        expect(body.names).toContain(out.secretName);
      }).pipe(logLevel),
      { timeout: 60_000 },
    );
  });

  describe("WriteSecret", () => {
    test(
      "creates a secret from the Service",
      Effect.gen(function* () {
        const created = (yield* postJson("/secret", {
          name: "BINDING_CREATED",
          value: "from-fixture",
        })) as { ok: boolean; name: string };
        expect(created.ok).toEqual(true);
        const listed = (yield* getJson("/secrets")) as { names: string[] };
        expect(listed.names).toContain("BINDING_CREATED");
      }).pipe(logLevel),
      { timeout: 60_000 },
    );
  });

  describe("Encrypt", () => {
    test(
      "encrypts and decrypts on the Service",
      Effect.gen(function* () {
        const enc = (yield* postJson("/encrypt", { text: PLAINTEXT })) as {
          ciphertext: string;
        };
        expect(enc.ciphertext.length).toBeGreaterThan(0);
        const dec = (yield* postJson("/decrypt", {
          ciphertext: enc.ciphertext,
        })) as { text: string };
        expect(dec.text).toEqual(PLAINTEXT);
      }).pipe(logLevel),
      { timeout: 60_000 },
    );
  });

  describe("Sign", () => {
    test(
      "signs and verifies on the Service",
      Effect.gen(function* () {
        const signed = (yield* postJson("/sign", { text: PLAINTEXT })) as {
          signature: string;
        };
        expect(signed.signature.length).toBeGreaterThan(0);
        const checked = (yield* postJson("/verify", {
          text: PLAINTEXT,
          signature: signed.signature,
        })) as { valid: boolean };
        expect(checked.valid).toEqual(true);
      }).pipe(logLevel),
      { timeout: 60_000 },
    );
  });
});
