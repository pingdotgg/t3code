import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/http/HttpClient";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { spawnSync } from "node:child_process";

/**
 * Harness for GCP binding tests, the counterpart of the AWS Lambda binding
 * fixtures (e.g. test/AWS/DynamoDB/handler.ts): each service's bindings run
 * inside a deployed Effect-native Cloud Run service, as that service's own
 * runtime service account, so the IAM grant every binding registers is what
 * authorizes the call.
 *
 * Fixture side (`fixtures/bindings-host.ts`): build a `routes` record of
 * probe Effects and serve it with {@link serveProbes}. Test side: call
 * {@link callProbe} with the deployed URL and a route name.
 */

/** Whether Docker is available to build the fixture image. */
export const dockerAvailable = (() => {
  try {
    return (
      spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 })
        .status === 0
    );
  } catch {
    return false;
  }
})();

/** What a probe route answers: the value, or the typed failure it hit. */
export type ProbeOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly error: { readonly _tag: string; readonly message?: string };
    };

export type Probe = Effect.Effect<unknown, { readonly _tag: string }, any>;

const toJsonSafe = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item) =>
      item instanceof Uint8Array
        ? { $bytes: Buffer.from(item).toString("base64") }
        : typeof item === "bigint"
          ? item.toString()
          : item,
    ) ?? "null",
  );

/**
 * Fixture-side `fetch`: `GET /probe/<name>` runs `routes[name]` and answers
 * its {@link ProbeOutcome} as JSON. `GET /` answers 200 for readiness.
 */
export const serveProbes = (routes: Record<string, Probe>) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest;
    const pathname = new URL(request.url, "http://host").pathname;
    const name = /^\/probe\/([^/]+)$/.exec(pathname)?.[1];
    if (name === undefined) return HttpServerResponse.text("ok");
    const probe = routes[decodeURIComponent(name)];
    if (probe === undefined) {
      return HttpServerResponse.text(`no probe ${name}`, { status: 404 });
    }
    const outcome: ProbeOutcome<unknown> = yield* probe.pipe(
      Effect.map((value) => ({ ok: true as const, value: toJsonSafe(value) })),
      Effect.catch((error) =>
        Effect.succeed({
          ok: false as const,
          error: {
            _tag: error._tag,
            message: (error as { readonly message?: string }).message,
          },
        }),
      ),
    );
    return yield* HttpServerResponse.json(outcome);
  });

class ProbeNotReady extends Data.TaggedError("ProbeNotReady")<{
  readonly reason: string;
}> {}

/**
 * Call a probe route on the deployed fixture. Retries (bounded, ~7 min) while
 * the service is still starting (non-200) or the binding's fresh IAM grant is
 * still propagating (the probe hit `Forbidden`/`PermissionDenied`), then
 * returns the outcome.
 */
export const callProbe = <A = unknown>(baseUrl: string, name: string) =>
  HttpClient.get(`${baseUrl.replace(/\/+$/, "")}/probe/${name}`).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? (response.json as Effect.Effect<ProbeOutcome<A>, never>)
        : Effect.fail(new ProbeNotReady({ reason: `HTTP ${response.status}` })),
    ),
    Effect.flatMap((outcome) =>
      !outcome.ok &&
      (outcome.error._tag === "Forbidden" ||
        outcome.error._tag === "PermissionDenied")
        ? Effect.fail(
            new ProbeNotReady({ reason: `IAM: ${outcome.error._tag}` }),
          )
        : Effect.succeed(outcome),
    ),
    Effect.mapError((error) =>
      error._tag === "ProbeNotReady"
        ? error
        : new ProbeNotReady({ reason: String(error) }),
    ),
    Effect.retry({
      while: (error) => error._tag === "ProbeNotReady",
      schedule: Schedule.spaced("10 seconds"),
      times: 42,
    }),
  );

/** {@link callProbe}, failing the test unless the probe succeeded. */
export const expectProbe = <A = unknown>(baseUrl: string, name: string) =>
  callProbe<A>(baseUrl, name).pipe(
    Effect.flatMap((outcome) =>
      outcome.ok
        ? Effect.succeed(outcome.value)
        : Effect.die(
            new Error(
              `probe ${name} failed: ${outcome.error._tag} ${outcome.error.message ?? ""}`,
            ),
          ),
    ),
  );
