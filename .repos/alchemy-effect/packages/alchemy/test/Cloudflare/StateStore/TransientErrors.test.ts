import { EdgeSessionError } from "@/Cloudflare/EdgeSession.ts";
import {
  isTransientBootstrapWriteError,
  isTransientEdgeSessionError,
} from "@/Cloudflare/StateStore/State.ts";
import { makeHttpStateStore } from "@/State/HttpStateStore.ts";
import type { StateStoreError } from "@/State/State.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";

/**
 * Predicate coverage for the retry policies added in response to
 * production failures (Axiom `prod-traces`):
 *
 * - bootstrap hoist writes failing on 401 (Secrets Store token binding
 *   not propagated yet — surfaced as EMPTY-message StateStoreErrors),
 *   404 (route propagation) and 5xx (encryption-key binding
 *   propagation).
 * - edge-preview secret reads failing with Cloudflare HTML error pages
 *   ("Secret probe returned 400/502: <!DOCTYPE html>..."), session
 *   creation flakes and transport errors ("fetch failed").
 *
 * `isTransientBootstrapWriteError` inspects the `cause` of the
 * `StateStoreError` the real HTTP client produces, so each case drives
 * an actual `makeHttpStateStore().set` against a stubbed fetch and
 * feeds the resulting failure into the predicate.
 */

/** Minimal fetch signature — Bun's `typeof fetch` also demands `preconnect`. */
type FetchStub = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const stubHttpClient = (stub: FetchStub) =>
  FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, stub as typeof globalThis.fetch),
    ),
  );

/** Run a state-store write against a stubbed transport, return its failure. */
const failingWrite = (stub: FetchStub): Effect.Effect<StateStoreError> =>
  Effect.gen(function* () {
    const store = yield* makeHttpStateStore({
      url: "https://state-store.test",
      authToken: "token",
      id: "test-http",
    });
    return yield* store
      .set({
        stack: "s",
        stage: "dev",
        fqn: "stack/scope/a",
        value: { hello: "world" } as never,
      })
      .pipe(Effect.flip);
  }).pipe(Effect.provide(stubHttpClient(stub)), Effect.orDie);

describe("isTransientBootstrapWriteError", () => {
  it.live(
    "retries 401 Unauthorized (token-binding propagation) but not other 4xx",
    () =>
      Effect.gen(function* () {
        const unauthorized = yield* failingWrite(
          async () => new Response(null, { status: 401 }),
        );
        expect(isTransientBootstrapWriteError(unauthorized)).toBe(true);

        const badRequest = yield* failingWrite(
          async () => new Response("no", { status: 400 }),
        );
        expect(isTransientBootstrapWriteError(badRequest)).toBe(false);
      }),
  );

  it.live(
    "retries 404 (route propagation), 5xx (binding propagation) and transport failures",
    () =>
      Effect.gen(function* () {
        for (const stub of [
          async () => new Response("not found", { status: 404 }),
          async () => new Response("secret unavailable", { status: 500 }),
          async () => {
            throw new TypeError("fetch failed");
          },
        ]) {
          const error = yield* failingWrite(stub);
          expect(isTransientBootstrapWriteError(error)).toBe(true);
        }
      }),
    60_000,
  );

  it("does not retry errors without a cause", () => {
    expect(isTransientBootstrapWriteError({ cause: undefined })).toBe(false);
  });
});

describe("isTransientEdgeSessionError", () => {
  it("retries non-200 secret-probe responses (Cloudflare HTML error pages)", () => {
    const error = new EdgeSessionError({
      message: 'Secret probe returned 400: <!DOCTYPE html>\n<html class="no-',
    });
    expect(isTransientEdgeSessionError(error)).toBe(true);
  });

  it("retries session-creation failures with transient causes", () => {
    const error = new EdgeSessionError({
      message: "Failed to create edge preview session",
      cause: new TypeError("fetch failed"),
    });
    expect(isTransientEdgeSessionError(error)).toBe(true);
  });

  it("does not retry permanent auth causes", () => {
    for (const tag of ["Unauthorized", "Forbidden", "InvalidRoute"]) {
      const cause = Object.assign(new Error("denied"), { _tag: tag });
      const error = new EdgeSessionError({
        message: "Failed to create edge preview session",
        cause,
      });
      expect(isTransientEdgeSessionError(error)).toBe(false);
    }
  });

  it("ignores non-EdgeSessionError values", () => {
    expect(isTransientEdgeSessionError(new Error("boom"))).toBe(false);
  });
});
