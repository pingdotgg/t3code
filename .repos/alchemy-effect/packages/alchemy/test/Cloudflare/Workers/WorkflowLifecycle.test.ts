import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy.ts";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import LifecycleWorker, {
  type Scenario,
} from "./fixtures/workflow-lifecycle/worker.ts";

interface Status {
  status: string;
  output?: string[];
  error?: { name?: string; message?: string } | null;
  rollback?: { outcome: string } | null;
  entries: string[];
}

const request = Effect.fn(function* (
  url: string,
  method: "GET" | "POST" = "GET",
) {
  const response = yield* requestWorker(
    method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url),
  );
  const body = yield* response.text;
  if (response.status !== 200) {
    return yield* Effect.fail(
      new Error(`${method} ${url}: ${response.status}: ${body}`),
    );
  }
  return body;
});

const waitForReady = Effect.fn(function* (url: string) {
  const ready = yield* Effect.gen(function* () {
    const response = yield* requestWorker(HttpClientRequest.get(url), {
      retryDelay: "3 seconds",
    });
    const body = yield* response.text;
    if (
      response.status === 503 &&
      response.headers["x-workflow-lifecycle-readiness"] ===
        "journal-rpc-not-ready" &&
      body === "LifecycleJournal.entries not ready"
    ) {
      yield* Effect.logInfo(
        `Workflow readiness: native journal RPC not ready at ${url}`,
      );
      return false;
    }
    if (response.status !== 200) {
      return yield* Effect.fail(
        new Error(`GET ${url}: ${response.status}: ${body}`),
      );
    }
    if (body === "Alchemy worker is being deployed...") return false;
    expect(body).toBe("ready");
    return true;
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 8,
      until: (ready) => ready,
    }),
    Effect.timeout("45 seconds"),
  );
  expect(ready, "Journal entries method did not propagate").toBe(true);
});

const probeWorkflow = Effect.fn(function* (
  url: string,
  className = "LifecycleWorkflow",
) {
  const ready = yield* Effect.gen(function* () {
    const started = yield* request(`${url}/probe`, "POST");
    const { id } = yield* Effect.try(
      () => JSON.parse(started) as { id: string },
    );
    const status = yield* request(`${url}/probe/${id}`).pipe(
      Effect.flatMap((body) =>
        Effect.try(() => JSON.parse(body) as Omit<Status, "entries">),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("1 second"),
        times: 10,
        until: (status) =>
          status.status === "complete" || status.status === "errored",
      }),
    );
    yield* Effect.logInfo(
      `Workflow readiness probe ${id}: ${JSON.stringify(status)}`,
    );
    // Only a probe may be recreated when Workflow execution still sees the stub.
    if (
      status.status === "errored" &&
      status.error?.name === "TypeError" &&
      status.error.message ===
        `The entrypoint name ${className} was not found in this worker. Ensure the worker exports an entrypoint with that name.`
    ) {
      return false;
    }
    expect(status, JSON.stringify(status)).toMatchObject({
      status: "complete",
      output: ["workflow-ready"],
    });
    return true;
  }).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      times: 8,
      until: (ready) => ready,
    }),
    Effect.timeout("45 seconds"),
  );
  expect(ready, "Workflow entrypoint did not propagate").toBe(true);
});

const cases: Array<{ scenario: Scenario; entries: string[] }> = [
  ...(
    [
      "unsupported-function",
      "unsupported-symbol",
      "unsupported-cycle",
      "unsupported-size",
      "unsupported-array",
      "unsupported-accessor",
      "unsupported-tag-accessor",
      "unsupported-alias",
    ] as const
  ).map((scenario) => ({
    scenario,
    entries: ["open:1:captured:true", "close:1"],
  })),
  {
    scenario: "success",
    entries: ["open:1:captured:true", "close:1", "after-task"],
  },
  {
    scenario: "retry",
    entries: [
      "open:1:captured:true",
      "close:1",
      "open:2:captured:true",
      "close:2",
      "after-task",
    ],
  },
  {
    scenario: "exhaustion",
    entries: [
      "open:1:captured:true",
      "close:1",
      "open:2:captured:true",
      "close:2",
      "caught:application:2:true",
      "after-task",
    ],
  },
  {
    scenario: "uncaught",
    entries: [
      "open:1:captured:true",
      "close:1",
      "open:2:captured:true",
      "close:2",
    ],
  },
  {
    scenario: "die",
    entries: ["open:1:captured:true", "close:1"],
  },
  {
    scenario: "orDie",
    entries: ["open:1:captured:true", "close:1"],
  },
  {
    scenario: "interrupt",
    entries: ["open:1:captured:true", "close:1", "joined", "after-task"],
  },
  {
    scenario: "interrupt-retry",
    entries: ["open:1:captured:true", "close:1", "joined", "after-task"],
  },
  {
    scenario: "rollback-retry",
    entries: [
      "open:1:captured:true",
      "close:1",
      "after-task",
      "rollback-open:captured:true:1",
      "rollback-body:1",
      "rollback-close:1",
      "rollback-open:captured:true:2",
      "rollback-body:2",
      "rollback-close:2",
    ],
  },
  ...(["rollback-die", "rollback-orDie"] as const).map((scenario) => ({
    scenario,
    entries: [
      "open:1:captured:true",
      "close:1",
      "after-task",
      "rollback-open:captured:true:1",
      "rollback-body:1",
      "rollback-close:1",
    ],
  })),
  {
    scenario: "rollback",
    entries: [
      "open:1:captured:true",
      "close:1",
      "after-task",
      "rollback-open:captured:true",
      "rollback-body",
      "rollback-close",
    ],
  },
];

describe.concurrent.each([
  { dev: true, stage: "workflow-lifecycle-local" },
  { dev: false, stage: "workflow-lifecycle-live" },
])(
  "Workflow lifecycle (dev: $dev)",
  ({ dev, stage }) => {
    const state = dev ? Alchemy.inMemoryState() : Cloudflare.state();
    const Stack = Alchemy.Stack(
      "WorkflowLifecycleStack",
      { providers: Cloudflare.providers(), state },
      Effect.gen(function* () {
        const worker = yield* LifecycleWorker;
        return { url: worker.url.as<string>() };
      }),
    );
    const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
      providers: Cloudflare.providers(),
      state,
      dev,
      stage,
    });
    const stack = beforeAll(
      Effect.gen(function* () {
        yield* destroy(Stack);
        const output = yield* deploy(Stack);
        yield* waitForReady(`${output.url}/ready`);
        yield* probeWorkflow(output.url);
        return output;
      }),
      { timeout: 120_000 },
    );
    afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack), {
      timeout: 30_000,
    });

    for (const [kind, message] of [
      ["missing", 'The RPC receiver does not implement the method "entries".'],
      ["internal", "internal error; reference = application"],
    ]) {
      test(
        `does not mask an application ${kind} failure as readiness`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          const failure = yield* waitForReady(
            `${url}/ready?application-error=${kind}`,
          ).pipe(Effect.flip);
          expect(failure.message).toContain(": 500:");
          expect(failure.message).toContain(message);
          expect(failure.message).not.toContain(
            "LifecycleJournal.entries not ready",
          );
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 60_000 },
      );
    }

    test(
      "repeated starts keep the same instance and execute the scenario once",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const startUrl = `${url}/start/success?id=repeated-start`;
        const first = yield* request(startUrl, "POST");
        expect(yield* request(startUrl, "POST")).toBe(first);
        const { id } = yield* Effect.try(
          () => JSON.parse(first) as { id: string },
        );
        expect(id).toBe("repeated-start");
        const status = yield* request(`${url}/status/${id}`).pipe(
          Effect.flatMap((body) =>
            Effect.try(() => JSON.parse(body) as Status),
          ),
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            times: 10,
            until: (status) => status.status === "complete",
          }),
        );
        expect(status).toMatchObject({
          status: "complete",
          entries: ["open:1:captured:true", "close:1", "after-task"],
        });
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 60_000 },
    );

    test(
      "preserves native validation failures when starting an instance",
      Effect.gen(function* () {
        const { url } = yield* stack;
        const response = yield* requestWorker(
          HttpClientRequest.post(`${url}/start/success?id=invalid%2Fid`),
        );
        expect(response.status).toBe(500);
        const body = yield* response.text;
        expect(body).not.toContain("WorkflowControlUnavailable");
        expect(body.toLowerCase()).toContain("invalid");
      }),
      { tags: [...(dev ? ["local"] : ["live"])], timeout: 60_000 },
    );

    for (const scenario of [
      "replay",
      "replay-inherited",
      "replay-terminal-die",
      "replay-terminal-orDie",
    ] as const) {
      test(
        `preserves ${scenario} error semantics after checkpoint replay`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          const terminal = scenario.startsWith("replay-terminal");
          const caught = terminal ? "caught:terminal" : "caught:application:2";
          const { id } = yield* request(
            `${url}/start/${scenario}?stage=${encodeURIComponent(stage)}`,
            "POST",
          ).pipe(
            Effect.flatMap((body) =>
              Effect.try(() => JSON.parse(body) as { id: string }),
            ),
          );
          const recovered = yield* request(`${url}/journal/${id}`).pipe(
            Effect.flatMap((body) =>
              Effect.try(() => JSON.parse(body) as string[]),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              times: 10,
              until: (entries) => entries.includes("checkpoint"),
            }),
          );
          if (!recovered.includes(`${caught}:true`)) {
            yield* Effect.logInfo(
              "Workflow replay recovery status",
              yield* request(`${url}/status/${id}`),
            );
          }
          expect(recovered).toContain(`${caught}:true`);
          // A journal write does not acknowledge native run completion.
          const completed = yield* request(`${url}/status/${id}`).pipe(
            Effect.flatMap((body) =>
              Effect.try(() => JSON.parse(body) as Status),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              times: 10,
              until: (status) =>
                status.status === "complete" || status.status === "errored",
            }),
          );
          expect(completed, JSON.stringify(completed)).toMatchObject({
            status: "complete",
            output: recovered,
          });
          yield* request(`${url}/restart/${id}`, "POST");
          const journal = yield* request(`${url}/journal/${id}`).pipe(
            Effect.flatMap((body) =>
              Effect.try(() => JSON.parse(body) as string[]),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              times: 10,
              until: (entries) => entries.includes("after-task"),
            }),
          );
          yield* Effect.logInfo(
            `Replay journal ${id}: ${JSON.stringify(journal)}`,
          );
          if (!journal.includes("after-task")) {
            yield* Effect.logInfo(
              "Workflow checkpoint restart status",
              yield* request(`${url}/status/${id}`),
            );
          }
          expect(journal).toContain("after-task");
          // Native terminal failures may rerun on an explicit checkpoint restart.
          const reranTerminal =
            terminal && journal.includes("open:3:captured:true");
          expect(journal).toContain(`${caught}:${reranTerminal}`);
          const replayed = yield* request(`${url}/status/${id}`).pipe(
            Effect.flatMap((body) =>
              Effect.try(() => JSON.parse(body) as Status),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("1 second"),
              times: 10,
              until: (status) =>
                status.status === "complete" || status.status === "errored",
            }),
          );
          expect(replayed, JSON.stringify(replayed)).toMatchObject({
            status: "complete",
            entries: [
              "run",
              "open:1:captured:true",
              "close:1",
              "open:2:captured:true",
              "close:2",
              `${caught}:true`,
              "checkpoint",
              "run",
              ...(reranTerminal ? ["open:3:captured:true", "close:3"] : []),
              `${caught}:${reranTerminal}`,
              "after-task",
            ],
          });
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 60_000 },
      );
    }

    for (const { scenario, entries } of cases) {
      test(
        `closes and owns ${scenario} attempt resources`,
        Effect.gen(function* () {
          const { url } = yield* stack;
          const started = yield* request(`${url}/start/${scenario}`, "POST");
          const { id } = yield* Effect.try(
            () => JSON.parse(started) as { id: string },
          );
          if (scenario.startsWith("rollback")) {
            // Native status() can reject during compensation; observe cleanup first.
            const journal = yield* request(`${url}/journal/${id}`).pipe(
              Effect.flatMap((body) =>
                Effect.try(() => JSON.parse(body) as string[]),
              ),
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                times: 10,
                until: (actual) => actual.includes(entries[entries.length - 1]),
              }),
            );
            expect(journal).toEqual(entries);
          }
          const status = yield* request(`${url}/status/${id}`).pipe(
            Effect.flatMap((body) =>
              Effect.try(() => JSON.parse(body) as Status),
            ),
            Effect.repeat({
              schedule: Schedule.spaced("2 seconds"),
              times: 10,
              until: (status) =>
                status.status === "complete" || status.status === "errored",
            }),
          );
          const failed =
            scenario.startsWith("rollback") ||
            scenario.startsWith("unsupported") ||
            ["uncaught", "die", "orDie"].includes(scenario);
          expect(status, JSON.stringify(status)).toMatchObject({
            status: failed ? "errored" : "complete",
            entries,
          });
          if (scenario.startsWith("rollback")) {
            if (!dev) {
              expect(status.rollback).toMatchObject({
                outcome:
                  scenario === "rollback-die" || scenario === "rollback-orDie"
                    ? "failed"
                    : "complete",
              });
            }
            expect(status.error).toMatchObject({
              message: "trigger compensation",
            });
          } else if (scenario.startsWith("unsupported")) {
            expect(status.error?.message).toContain(
              "Workflow application failure is not serializable",
            );
            if (scenario === "unsupported-array")
              expect(status.error?.message).toContain(
                "sparse arrays or custom array properties",
              );
            if (
              scenario === "unsupported-accessor" ||
              scenario === "unsupported-tag-accessor"
            ) {
              expect(status.error?.message).toContain("accessor error data");
              expect(status.error?.message).not.toContain("getter was invoked");
            }
            if (scenario === "unsupported-alias")
              expect(status.error?.message).toContain(
                "shared references in error data",
              );
          } else if (failed) {
            expect(status.error?.message).toContain("application failure");
          } else {
            expect(status.output).toEqual(entries);
          }
        }),
        { tags: [...(dev ? ["local"] : ["live"])], timeout: 60_000 },
      );
    }
  },
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:worker",
      "provider:cloudflare:workflow",
    ],
  },
);
