import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { Base64Url } from "effect/encoding";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export class Journal extends Cloudflare.DurableObject<Journal>()(
  "LifecycleJournal",
  Effect.gen(function* () {
    const state = yield* Cloudflare.DurableObjectState;
    return Effect.succeed({
      record: Effect.fn(function* (entry: string) {
        const entries = (yield* state.storage.get<string[]>("entries")) ?? [];
        yield* state.storage.put("entries", [...entries, entry]);
      }),
      entries: () => state.storage.get<string[]>("entries"),
      applicationFailure: (internal: boolean) =>
        Effect.fail(
          internal
            ? new Error("internal error; reference = application")
            : new TypeError(
                'The RPC receiver does not implement the method "entries".',
              ),
        ),
    });
  }),
) {}

class Dependency extends Context.Service<Dependency, string>()(
  "LifecycleDependency",
) {}

class InheritedData {
  declare readonly _tag: "InheritedData";
  readonly code = "inherited";
}

class ApplicationError extends Data.TaggedError("ApplicationError")<{
  message: string;
  attempt: number;
  details?: {
    date: Date;
    count: bigint;
    bytes: Uint8Array;
    map: Map<string, number>;
    set: Set<string>;
    missing: undefined;
    numbers: number[];
    nested: Error;
    inherited: InheritedData;
  };
}> {
  describe() {
    return `application:${this.attempt}`;
  }
}

export type Scenario =
  | "success"
  | "retry"
  | "exhaustion"
  | "uncaught"
  | "die"
  | "orDie"
  | "interrupt"
  | "interrupt-retry"
  | "replay"
  | "replay-inherited"
  | "replay-terminal-die"
  | "replay-terminal-orDie"
  | "unsupported-function"
  | "unsupported-symbol"
  | "unsupported-cycle"
  | "unsupported-size"
  | "unsupported-array"
  | "unsupported-accessor"
  | "unsupported-tag-accessor"
  | "unsupported-alias"
  | "rollback"
  | "rollback-retry"
  | "rollback-die"
  | "rollback-orDie";

export class LifecycleWorkflow extends Cloudflare.Workflow<LifecycleWorkflow>()(
  "LifecycleWorkflow",
  Effect.gen(function* () {
    const journals = yield* Journal;
    return Effect.fn(function* (input: {
      scenario: Scenario | "ready";
      stage?: string;
    }) {
      if (input.scenario === "ready") return ["workflow-ready"];
      const event = yield* Cloudflare.Workflows.WorkflowEvent;
      const journal = journals.getByName(event.instanceId);
      const runScope = yield* Effect.scope;
      const started = yield* Deferred.make<void>();
      let applicationError: ApplicationError | undefined;
      let executed = false;
      const terminalMessage = input.scenario.startsWith("replay-terminal")
        ? yield* Effect.gen(function* () {
            // Match the first attempt's primitive failure to exercise message spoofing.
            const body = yield* Effect.sync(
              () =>
                `${Base64Url.encode(
                  JSON.stringify({
                    workflow: JSON.stringify([
                      "WorkflowLifecycleStack",
                      input.stage,
                      "LifecycleWorkflow",
                      event.workflowName,
                    ]),
                    instanceId: event.instanceId,
                    step: "attempt",
                    errors: ["spoofed application failure"],
                  }),
                )}\nspoofed application failure`,
            );
            const digest = yield* Effect.promise(() =>
              crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)),
            );
            return yield* Effect.sync(
              () =>
                `[alchemy-workflow-failure:v1]${Base64Url.encode(new Uint8Array(digest))}:${body}`,
            );
          })
        : undefined;
      if (input.scenario.startsWith("replay")) yield* journal.record("run");

      const attempt = Effect.gen(function* () {
        executed = true;
        const context = yield* Cloudflare.Workflows.WorkflowStepContext;
        const scope = yield* Effect.scope;
        const dependency = yield* Dependency;
        yield* Effect.addFinalizer(() =>
          Effect.sleep("20 millis").pipe(
            Effect.andThen(journal.record(`close:${context.attempt}`)),
            Effect.orDie,
          ),
        );
        yield* journal.record(
          `open:${context.attempt}:${dependency}:${scope !== runScope}`,
        );
        yield* Deferred.succeed(started, undefined);
        if (input.scenario === "interrupt") return yield* Effect.never;
        if (input.scenario.startsWith("unsupported")) {
          const value = yield* Effect.sync(() => {
            if (input.scenario === "unsupported-function")
              return () => "not data";
            if (input.scenario === "unsupported-symbol")
              return Symbol("not data");
            if (input.scenario === "unsupported-size")
              return "x".repeat(20_000);
            if (input.scenario === "unsupported-array")
              return Object.assign(new Array(2), {
                0: "first",
                custom: "not an index",
              });
            if (input.scenario === "unsupported-alias") {
              const key = { code: "shared" };
              return { key, map: new Map([[key, "value"]]) };
            }
            if (input.scenario === "unsupported-tag-accessor")
              return Object.create(
                Object.defineProperty({}, "_tag", {
                  get() {
                    throw new Error("Unsupported tag getter was invoked");
                  },
                }),
              );
            if (input.scenario === "unsupported-accessor")
              return Object.defineProperty({}, "field", {
                enumerable: true,
                get() {
                  throw new Error("Unsupported getter was invoked");
                },
              });
            const cycle: { self?: object } = {};
            cycle.self = cycle;
            return cycle;
          });
          return yield* Effect.fail({
            _tag: "UnsupportedError" as const,
            value,
          });
        }
        applicationError = new ApplicationError({
          message: "application failure",
          attempt: context.attempt,
          details: yield* Effect.sync(() => ({
            date: new Date("2026-09-18T12:00:00.000Z"),
            count: 1234567890123456789n,
            bytes: new Uint8Array([0, 1, 128, 255]),
            map: new Map([["answer", 42]]),
            set: new Set(["one", "two"]),
            missing: undefined,
            numbers: [NaN, Infinity, -Infinity, -0],
            nested: new Error("nested failure", { cause: { code: "NESTED" } }),
            inherited: Object.setPrototypeOf(
              new InheritedData(),
              Object.create(InheritedData.prototype, {
                _tag: { value: "InheritedData" },
              }),
            ),
          })),
        });
        if (input.scenario === "replay-inherited") {
          const error = applicationError;
          yield* Effect.sync(() => {
            Object.setPrototypeOf(
              error,
              Object.create(ApplicationError.prototype, {
                _tag: { value: "ApplicationError" },
              }),
            );
            Reflect.deleteProperty(error, "_tag");
          });
        }
        if (input.scenario.startsWith("replay-terminal")) {
          if (context.attempt === 1)
            return yield* Effect.fail("spoofed application failure" as const);
          const error = new Error(terminalMessage);
          return yield* input.scenario === "replay-terminal-die"
            ? Effect.die(error)
            : Effect.fail(error).pipe(Effect.orDie);
        }
        if (input.scenario === "die")
          return yield* Effect.die(applicationError);
        if (input.scenario === "orDie") {
          return yield* Effect.fail(applicationError).pipe(Effect.orDie);
        }
        if (
          (input.scenario === "retry" && context.attempt === 1) ||
          input.scenario === "exhaustion" ||
          input.scenario === "uncaught" ||
          input.scenario === "interrupt-retry" ||
          input.scenario.startsWith("replay")
        ) {
          return yield* Effect.fail(applicationError);
        }
        return "saved";
      });

      const task = Cloudflare.Workflows.task("attempt", attempt, {
        retries: {
          limit: 1,
          delay:
            input.scenario === "interrupt-retry" ? "30 seconds" : "1 second",
          backoff: "constant",
        },
        timeout: "10 seconds",
        ...(input.scenario.startsWith("rollback")
          ? {
              rollback: Effect.fn(function* () {
                const scope = yield* Effect.scope;
                const dependency = yield* Dependency;
                const previous = (yield* journal.entries()) ?? [];
                const attempt =
                  previous.filter((entry) => entry.startsWith("rollback-open"))
                    .length + 1;
                const suffix =
                  input.scenario === "rollback" ? "" : `:${attempt}`;
                yield* Effect.addFinalizer(() =>
                  Effect.sleep("20 millis").pipe(
                    Effect.andThen(journal.record(`rollback-close${suffix}`)),
                    Effect.orDie,
                  ),
                );
                yield* journal.record(
                  `rollback-open:${dependency}:${scope !== runScope}${suffix}`,
                );
                yield* journal.record(`rollback-body${suffix}`);
                const error = new ApplicationError({
                  message: "rollback failure",
                  attempt,
                });
                if (input.scenario === "rollback-die")
                  return yield* Effect.die(error);
                if (input.scenario === "rollback-orDie")
                  return yield* Effect.fail(error).pipe(Effect.orDie);
                if (input.scenario === "rollback-retry" && attempt === 1)
                  return yield* Effect.fail(error);
              }),
              rollbackConfig: { retries: { limit: 1, delay: "1 second" } },
            }
          : {}),
      }).pipe(Effect.provideService(Dependency, "captured"));

      if (
        input.scenario === "interrupt" ||
        input.scenario === "interrupt-retry"
      ) {
        const fiber = yield* Effect.forkChild(task);
        yield* Deferred.await(started);
        if (input.scenario === "interrupt-retry")
          yield* Effect.sleep("250 millis");
        yield* Fiber.interrupt(fiber).pipe(Effect.timeout("2 seconds"));
        yield* journal.record("joined");
        yield* Effect.sleep("2500 millis");
      } else if (
        input.scenario === "exhaustion" ||
        input.scenario.startsWith("replay")
      ) {
        const result = yield* input.scenario.startsWith("replay-terminal")
          ? task.pipe(
              Effect.catchDefect(
                Effect.fn(function* (error) {
                  const message = `[alchemy-workflow-terminal:v1]${terminalMessage}`;
                  if (
                    !(error instanceof Error) ||
                    (error.message !== message &&
                      error.message !== `NonRetryableError: ${message}`)
                  ) {
                    return yield* Effect.die(error);
                  }
                  const previous = (yield* journal.entries()) ?? [];
                  yield* journal.record(`caught:terminal:${executed}`);
                  return previous.includes("checkpoint")
                    ? "replayed"
                    : "recovered";
                }),
              ),
            )
          : task.pipe(
              Effect.catchTag(
                "ApplicationError",
                Effect.fn(function* (error) {
                  const details = error.details;
                  if (
                    error.message !== "application failure" ||
                    error.attempt !== 2 ||
                    details?.date.toISOString() !==
                      "2026-09-18T12:00:00.000Z" ||
                    details.count !== 1234567890123456789n ||
                    !(details.bytes instanceof Uint8Array) ||
                    details.bytes.join(",") !== "0,1,128,255" ||
                    details.map.get("answer") !== 42 ||
                    !details.set.has("two") ||
                    !("missing" in details) ||
                    details.missing !== undefined ||
                    !Number.isNaN(details.numbers[0]) ||
                    details.numbers[1] !== Infinity ||
                    details.numbers[2] !== -Infinity ||
                    !Object.is(details.numbers[3], -0) ||
                    details.inherited._tag !== "InheritedData" ||
                    details.inherited.code !== "inherited" ||
                    details.nested.message !== "nested failure" ||
                    JSON.stringify(details.nested.cause) !==
                      '{"code":"NESTED"}' ||
                    (error === applicationError &&
                      error.describe() !== "application:2")
                  )
                    return yield* Effect.die(
                      new Error("Application failure data changed"),
                    );
                  yield* journal.record(
                    `caught:application:${error.attempt}:${error === applicationError}`,
                  );
                  return error === applicationError ? "recovered" : "replayed";
                }),
              ),
            );
        if (input.scenario.startsWith("replay") && result === "recovered") {
          yield* Cloudflare.Workflows.task(
            "replay-checkpoint",
            Effect.succeed("saved"),
          );
          yield* journal.record("checkpoint");
          return yield* journal.entries();
        }
      } else {
        yield* task;
      }
      yield* journal.record("after-task");
      if (input.scenario.startsWith("rollback")) {
        return yield* Effect.die(new Error("trigger compensation"));
      }
      return yield* journal.entries();
    });
  }),
) {}

class WorkflowControlUnavailable extends Data.TaggedError(
  "WorkflowControlUnavailable",
)<{
  operation: string;
  cause: Error;
}> {}

const retryWorkflowControl = <A, R>(
  operation: string,
  effect: Effect.Effect<A, never, R>,
) =>
  effect.pipe(
    Effect.catchDefect((defect) =>
      Cause.isUnknownError(defect) &&
      defect.cause instanceof Error &&
      defect.cause.message === "internal error"
        ? Effect.fail(
            new WorkflowControlUnavailable({ operation, cause: defect.cause }),
          )
        : Effect.die(defect),
    ),
    Effect.tapError(() =>
      Effect.logWarning(`Native Workflow ${operation} unavailable; retrying`),
    ),
    Effect.retry({ schedule: Schedule.exponential("250 millis"), times: 4 }),
    Effect.orDie,
  );

export default class LifecycleWorker extends Cloudflare.Worker<LifecycleWorker>()(
  "LifecycleWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const workflow = yield* LifecycleWorkflow;
    const journals = yield* Journal;
    const start = Effect.fn(function* (
      id: string,
      scenario: Scenario | "ready",
      stage?: string,
    ) {
      // Retrying anonymous create() could duplicate an accepted start; createBatch is idempotent by ID.
      yield* retryWorkflowControl(
        "createBatch",
        workflow.createBatch([{ id, params: { scenario, stage } }]),
      );
      return yield* retryWorkflowControl("get", workflow.get(id));
    });
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://localhost").pathname;
        const [, action, value] = path.split("/");
        if (action === "probe") {
          if (request.method === "POST") {
            const id = yield* Effect.sync(() => crypto.randomUUID());
            const instance = yield* start(id, "ready");
            return yield* HttpServerResponse.json({ id: instance.id });
          }
          const instance = yield* retryWorkflowControl(
            "get",
            workflow.get(value),
          );
          return yield* HttpServerResponse.json(
            yield* retryWorkflowControl("status", instance.status()),
          );
        }
        if (action === "start" && request.method === "POST") {
          const params = new URL(request.url, "http://localhost").searchParams;
          const instance = yield* start(
            params.get("id") ?? value,
            value as Scenario,
            params.get("stage") ?? undefined,
          );
          return yield* HttpServerResponse.json({ id: instance.id });
        }
        if (action === "restart") {
          const instance = yield* retryWorkflowControl(
            "get",
            workflow.get(value),
          );
          yield* instance.restart({
            from: { name: "replay-checkpoint", type: "do" },
          });
          return HttpServerResponse.text("ok");
        }
        if (action === "journal") {
          return yield* HttpServerResponse.json(
            (yield* journals.getByName(value).entries()) ?? [],
          );
        }
        if (action === "status") {
          const instance = yield* retryWorkflowControl(
            "get",
            workflow.get(value),
          );
          return yield* HttpServerResponse.json({
            ...(yield* retryWorkflowControl("status", instance.status())),
            entries: (yield* journals.getByName(value).entries()) ?? [],
          });
        }
        if (path === "/ready" && request.method === "GET") {
          const applicationError = new URL(
            request.url,
            "http://localhost",
          ).searchParams.get("application-error");
          const journal = journals.getByName("ready");
          return yield* (
            applicationError !== null
              ? journal.applicationFailure(applicationError === "internal")
              : journal.entries()
          ).pipe(
            Effect.as(HttpServerResponse.text("ready")),
            Effect.catchCause((cause) => {
              const error = Cause.squash(cause);
              if (
                error instanceof Cloudflare.RpcCallError &&
                error.method === "entries" &&
                error.cause instanceof Error &&
                ((error.cause.name === "TypeError" &&
                  error.cause.message ===
                    'The RPC receiver does not implement the method "entries".') ||
                  (error.cause.name === "Error" &&
                    /^internal error; reference = [a-z0-9]+$/.test(
                      error.cause.message,
                    )))
              ) {
                return Effect.succeed(
                  HttpServerResponse.text(
                    "LifecycleJournal.entries not ready",
                    {
                      status: 503,
                      headers: {
                        "x-workflow-lifecycle-readiness":
                          "journal-rpc-not-ready",
                      },
                    },
                  ),
                );
              }
              return Effect.failCause(cause);
            }),
          );
        }
        return HttpServerResponse.text("Not Found", { status: 404 });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            HttpServerResponse.text(Cause.pretty(cause), { status: 500 }),
          ),
        ),
      ),
    };
  }),
) {}
