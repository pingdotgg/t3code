import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { expectUrlContains } from "../Utils/Http.ts";
import Stack from "./fixtures/wait-until/stack.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

// Cache-busting query param on every request: after destroy+recreate of the
// same workers.dev subdomain the edge can serve a cached "nothing here yet"
// placeholder (with a 200) for the bare URL even though busted requests
// already reach the worker. Route matching uses `url.pathname`, so the
// param is invisible to the fixture.
let bust = 0;
const getText = (
  client: HttpClient.HttpClient,
  url: string,
): Effect.Effect<string, unknown> =>
  client
    .get(`${url}?cb=${Date.now()}-${bust++}`)
    .pipe(Effect.flatMap((res) => res.text));

test(
  "waitUntil runs background Effects past the response (worker ctx + DO state)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // Content-based readiness through workers.dev propagation (the
    // placeholder page serves 200s); also asserts the raw escape hatch is
    // the genuine workerd ExecutionContext.
    yield* expectUrlContains(`${url}/raw`, "ok", {
      label: "wait-until worker propagation",
    });

    // Fire both background writes: one from the Worker's ExecutionContext,
    // one from inside the DO via DurableObjectState.waitUntil. Both routes
    // respond before the journal entry is persisted. Probed via
    // expectUrlContains so transient placeholders/5xx during propagation
    // are retried (a duplicate journal entry from a retry is harmless —
    // the assertions below use `toContain`).
    yield* expectUrlContains(`${url}/bg`, "bg-scheduled", {
      label: "waitUntil /bg",
    });
    yield* expectUrlContains(`${url}/bg-do`, "bg-do-scheduled", {
      label: "waitUntil /bg-do",
    });

    // The entries only appear if waitUntil kept the invocations alive until
    // the delayed writes completed.
    const entries = yield* Effect.gen(function* () {
      const text = yield* getText(client, `${url}/entries`);
      // The workers.dev placeholder serves HTML with a 200 during subdomain
      // propagation; a bare JSON.parse throw would be a *defect* that the
      // `Effect.catch` below can't see, so parse as a typed failure.
      const body = yield* Effect.try(
        () => JSON.parse(text) as { entries?: string[] },
      );
      return body.entries ?? [];
    }).pipe(
      Effect.catch(() => Effect.succeed([] as string[])),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (entries) =>
          entries.includes("from-worker-wait-until") &&
          entries.includes("from-do-wait-until"),
        times: 30,
      }),
    );

    expect(entries).toContain("from-worker-wait-until");
    expect(entries).toContain("from-do-wait-until");
  }).pipe(logLevel),
  { timeout: 180_000 },
);

// Scope finalizers piggyback on the same mechanism: the bridge closes the
// per-event scope after the handler completes and registers the close
// promise with waitUntil, so `Effect.addFinalizer` work lands after the
// response without blocking it.
test(
  "Effect.addFinalizer runs after the response (request scope + DO call scope)",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpClient.HttpClient;

    // Content-based readiness: a fresh workers.dev URL serves Cloudflare's
    // placeholder page (with a 200) while the subdomain propagates.
    yield* expectUrlContains(`${url}/raw`, "ok", {
      label: "wait-until worker propagation",
    });

    // Both routes respond before their finalizers persist the entries.
    // Probed via expectUrlContains so transient placeholders/5xx during
    // propagation are retried (duplicate journal entries are harmless —
    // the assertions below use `toContain`).
    yield* expectUrlContains(`${url}/finalizer`, "finalizer-scheduled", {
      label: "finalizer /finalizer",
    });
    yield* expectUrlContains(`${url}/finalizer-do`, "do-finalizer-scheduled", {
      label: "finalizer /finalizer-do",
    });

    const entries = yield* Effect.gen(function* () {
      const text = yield* getText(client, `${url}/entries`);
      // The workers.dev placeholder serves HTML with a 200 during subdomain
      // propagation; a bare JSON.parse throw would be a *defect* that the
      // `Effect.catch` below can't see, so parse as a typed failure.
      const body = yield* Effect.try(
        () => JSON.parse(text) as { entries?: string[] },
      );
      return body.entries ?? [];
    }).pipe(
      Effect.catch(() => Effect.succeed([] as string[])),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        until: (entries) =>
          entries.includes("from-request-finalizer") &&
          entries.includes("from-do-finalizer"),
        times: 30,
      }),
    );

    expect(entries).toContain("from-request-finalizer");
    expect(entries).toContain("from-do-finalizer");

    // Init-phase semantics (documented on the Worker resource): the init
    // closure runs exactly once per isolate — the bridge builds the layer
    // stack on the first event and every later event reuses the built
    // context. The build scope is never closed (workerd has no isolate
    // teardown), so a finalizer added in the init closure NEVER fires;
    // request-coupled cleanup belongs in handlers, where `addFinalizer`
    // attaches to the per-event scope (asserted above). Each observation
    // may come from a different isolate, but every isolate must report
    // exactly one init run and zero init-finalizer runs no matter how many
    // events it has served.
    const observation = yield* Effect.gen(function* () {
      const init = Number(yield* getText(client, `${url}/init-runs`));
      const finalized = Number(
        yield* getText(client, `${url}/init-finalizer-runs`),
      );
      return { init, finalized };
    }).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("500 millis"),
        until: (o) => o.init === 1 && o.finalized === 0,
        times: 10,
      }),
    );
    expect(observation).toEqual({ init: 1, finalized: 0 });
  }).pipe(logLevel),
  { timeout: 180_000 },
);
