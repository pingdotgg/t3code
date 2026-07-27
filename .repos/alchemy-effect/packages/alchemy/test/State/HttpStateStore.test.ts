import {
  checkHttpStateStoreAuth,
  describeStateStoreFailure,
  makeHttpStateStore,
} from "@/State/HttpStateStore.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

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
    expect(message).toContain("SomeTaggedError");
  });

  it("maps Unauthorized-tagged errors to an actionable message", () => {
    class Unauthorized extends Error {
      readonly _tag = "Unauthorized";
      constructor() {
        super("");
      }
    }
    const message = describeStateStoreFailure(new Unauthorized());
    expect(message).toContain("unauthorized");
    expect(message).toContain("alchemy login");
  });

  it("appends the HTTP status when the error carries a response", () => {
    class WithResponse extends Error {
      readonly _tag = "HttpClientError";
      readonly response = { status: 500 };
      constructor() {
        super("something broke");
      }
    }
    expect(describeStateStoreFailure(new WithResponse())).toContain("500");
  });

  it("appends a distinct cause message", () => {
    const cause = new Error("connection reset by peer");
    const outer = new Error("fetch failed");
    outer.cause = cause;
    const message = describeStateStoreFailure(outer);
    expect(message).toContain("fetch failed");
    expect(message).toContain("connection reset by peer");
  });

  it("stringifies non-Error failures", () => {
    expect(describeStateStoreFailure("boom")).toBe("boom");
  });
});

describe("makeHttpStateStore", () => {
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
      expect(error.message).toContain("alchemy login");
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
