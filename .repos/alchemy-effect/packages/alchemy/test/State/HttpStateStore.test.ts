import {
  checkHttpStateStoreAuth,
  describeStateStoreFailure,
  makeHttpStateStore,
} from "@/State/HttpStateStore.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";

/**
 * Hermetic tests driven by the production failure modes observed in
 * Axiom (`prod-traces`, spans `state_store.*`):
 *
 * - `StateStoreError` with an EMPTY message (31 hits / 14 users on
 *   beta.57–59) — thrown from `mapStateStoreError` when the client
 *   error carried no message (e.g. the no-content 401).
 * - opaque `Decode error (500 PUT <url>)` — worker 5xx bodies that
 *   fail response decoding.
 * - `Transport error (GET .../state/stacks)` / `fetch failed` — not
 *   retried by `checkHttpStateStoreAuth`.
 *
 * All HTTP traffic is stubbed through the `FetchHttpClient.Fetch`
 * reference — no sockets, no cloud.
 */

/** Minimal fetch signature — Bun's `typeof fetch` also demands `preconnect`. */
type FetchStub = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Build an HttpClient layer whose transport is the given fetch stub. */
const stubHttpClient = (stub: FetchStub) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, stub as typeof globalThis.fetch),
    ),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const sampleValue = { fqn: "stack/scope/a", props: { hello: "world" } };

const makeStore = makeHttpStateStore({
  url: "https://state-store.test",
  authToken: "token",
  id: "test-http",
});

describe("describeStateStoreFailure", () => {
  it("never returns an empty message", () => {
    class Empty extends Error {
      readonly _tag = "SomeTaggedError";
      constructor() {
        super("");
      }
    }
    const message = describeStateStoreFailure(new Empty());
    expect(message.length).toBeGreaterThan(0);
  });

  it("maps Unauthorized errors to an actionable message", () => {
    const message = describeStateStoreFailure(new HttpApiError.Unauthorized());
    expect(message).toContain("unauthorized");
    expect(message).toContain("alchemy profile edit");
  });

  it("appends the HTTP status when the error carries a response", () => {
    const request = HttpClientRequest.put("https://state-store.test");
    const response = HttpClientResponse.fromWeb(
      request,
      new Response(null, { status: 500 }),
    );
    const error = new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({ request, response }),
    });
    expect(describeStateStoreFailure(error)).toContain("500");
  });

  it("omits arbitrary error and cause messages", () => {
    const cause = new Error("secret cause");
    const outer = new Error("secret message");
    outer.cause = cause;
    const message = describeStateStoreFailure(outer);
    expect(message).not.toContain("secret");
    expect(message.length).toBeGreaterThan(0);
  });

  it("omits non-Error failures that may contain state", () => {
    expect(describeStateStoreFailure("secret state")).not.toContain("secret");
  });
});

describe("makeHttpStateStore", () => {
  // Regression: https://github.com/reve-ai/kommunikasie/commit/f2e7320ff261833092b84d8aa25e3563710661e8
  // State encoding unwraps Redacted values before HTTP. Neither the request
  // object nor transport/decoder messages may escape through diagnostics.
  for (const failure of ["status", "decode", "transport"] as const) {
    it.live(
      `does not expose serialized state after a ${failure} failure`,
      () => {
        const secret = "STATE_PAYLOAD_SENTINEL_91f4";
        const logs: string[] = [];
        let requestBody = "";
        const logger = Logger.make(({ cause, message }) => {
          logs.push(JSON.stringify({ cause, message }));
        });
        const stub: FetchStub = async (_input, init) => {
          requestBody = await new Response(init?.body).text();
          if (failure === "transport") throw new Error(secret);
          return new Response(secret, {
            status: failure === "status" ? 400 : 200,
            headers: { "content-type": "application/json" },
          });
        };
        return Effect.gen(function* () {
          const store = yield* makeStore;
          const error = yield* store
            .set({
              stack: "s",
              stage: "dev",
              fqn: "secret",
              value: {
                kind: "action",
                actionType: "SecretState",
                namespace: undefined,
                fqn: "secret",
                logicalId: "secret",
                status: "ran",
                downstream: [],
                inputHash: "input-hash",
                input: { token: Redacted.make(secret) },
                output: null,
              },
            })
            .pipe(Effect.flip);
          expect(requestBody).toContain(secret);
          expect(JSON.stringify({ error, logs })).not.toContain(secret);
          expect(error.cause).toBeUndefined();
          expect(error.message).not.toContain(secret);
          expect(error.message.length).toBeGreaterThan(0);
        }).pipe(
          Effect.provide(stubHttpClient(stub)),
          Effect.provide(Logger.layer([logger])),
        );
      },
    );
  }

  it.live("retries transient 5xx and then succeeds", () => {
    let calls = 0;
    const stub: FetchStub = async () => {
      calls++;
      return calls < 3
        ? new Response("internal error", { status: 500 })
        : json(sampleValue);
    };
    return Effect.gen(function* () {
      const store = yield* makeStore;
      const result = yield* store.set({
        stack: "s",
        stage: "dev",
        fqn: "stack/scope/a",
        value: sampleValue as never,
      });
      expect(result).toEqual(sampleValue);
      expect(calls).toBe(3);
    }).pipe(Effect.provide(stubHttpClient(stub)));
  });

  it.live(
    "surfaces a persistent 5xx as a StateStoreError with status context",
    () => {
      let calls = 0;
      const stub: FetchStub = async () => {
        calls++;
        return new Response("secrets store binding unavailable", {
          status: 500,
        });
      };
      return Effect.gen(function* () {
        const store = yield* makeStore;
        const error = yield* store
          .set({
            stack: "s",
            stage: "dev",
            fqn: "stack/scope/a",
            value: sampleValue as never,
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("StateStoreError");
        expect(error.message.trim().length).toBeGreaterThan(0);
        expect(error.message).toContain("500");
        // initial attempt + 5 bounded retries
        expect(calls).toBe(6);
      }).pipe(Effect.provide(stubHttpClient(stub)));
    },
    30_000,
  );

  it.live("maps a no-content 401 to a non-empty, actionable error", () => {
    const stub: FetchStub = async () => new Response(null, { status: 401 });
    return Effect.gen(function* () {
      const store = yield* makeStore;
      const error = yield* store.listStacks().pipe(Effect.flip);
      expect(error._tag).toBe("StateStoreError");
      expect(error.message.trim().length).toBeGreaterThan(0);
      expect(error.message).toContain("unauthorized");
      expect(error.message).toContain("alchemy profile edit");
    }).pipe(Effect.provide(stubHttpClient(stub)));
  });

  it.live(
    "maps a non-JSON 200 body to a non-empty StateStoreError instead of a bare SyntaxError",
    () => {
      const stub: FetchStub = async () =>
        new Response("Alchemy State Store", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      return Effect.gen(function* () {
        const store = yield* makeStore;
        const error = yield* store.listStacks().pipe(Effect.flip);
        expect(error._tag).toBe("StateStoreError");
        expect(error.message.trim().length).toBeGreaterThan(0);
      }).pipe(Effect.provide(stubHttpClient(stub)));
    },
  );
});

describe("checkHttpStateStoreAuth", () => {
  const check = checkHttpStateStoreAuth({
    url: "https://state-store.test",
    authToken: "token",
  });

  it.live("retries transport-level failures before succeeding", () => {
    let calls = 0;
    const stub: FetchStub = async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return json([]);
    };
    return Effect.gen(function* () {
      const isAuthed = yield* check;
      expect(isAuthed).toBe(true);
      expect(calls).toBe(3);
    }).pipe(Effect.provide(stubHttpClient(stub)));
  });

  it.live("returns false on 401 without retrying", () => {
    let calls = 0;
    const stub: FetchStub = async () => {
      calls++;
      return new Response(null, { status: 401 });
    };
    return Effect.gen(function* () {
      const isAuthed = yield* check;
      expect(isAuthed).toBe(false);
      expect(calls).toBe(1);
    }).pipe(Effect.provide(stubHttpClient(stub)));
  });
});
