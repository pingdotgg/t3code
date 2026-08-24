import * as AWS from "@/AWS";
import * as Core from "@/Test/Core";
import * as Test from "@/Test/Alchemy";
import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as SQS from "@distilled.cloud/aws/sqs";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import SchedulerTestFunctionLive, { SchedulerTestFunction } from "./handler";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "SchedulerBindings");

// Every schedule the fixture mints at runtime carries this deterministic
// prefix so leftovers can be purged out-of-band before and after the suite.
const SCHEDULE_PREFIX = "alch-schedtest-";

// Lambda function URL cold-start (DNS, IAM propagation, init) can take well
// over 60s on a fresh deploy under parallel-suite load.
const readinessPolicy = Schedule.max([
  Schedule.fixed("2 seconds"),
  Schedule.recurs(75),
]);

let baseUrl: string;
let sinkQueueUrl: string;
let cronQueueUrl: string;

class TransientUpstream extends Data.TaggedError("TransientUpstream")<{
  readonly status: number;
  readonly body: string;
}> {}

class MessageNotDelivered extends Data.TaggedError("MessageNotDelivered") {}

class ScheduleStillExists extends Data.TaggedError("ScheduleStillExists") {}

// The shared Lambda fixture occasionally answers a transient 5xx under
// parallel load (cold re-init, IAM propagation). Retry 5xx only; a genuine
// 4xx/assertion failure surfaces immediately.
const send = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.status >= 500
        ? response.text.pipe(
            Effect.flatMap((body) =>
              Effect.fail(
                new TransientUpstream({ status: response.status, body }),
              ),
            ),
          )
        : Effect.succeed(response),
    ),
    Effect.retry({
      while: (e) => e._tag === "TransientUpstream",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(6),
      ]),
    }),
  );

// Out-of-band purge of runtime-minted schedules (default group, deterministic
// prefix) so a crashed previous run can't ConflictException this one. Wrapped
// in Core.withProviders because the distilled ops need the AWS environment
// (Credentials/Region) that test.provider bodies get implicitly but
// beforeAll/afterAll hooks do not.
const purgeTestSchedules = Core.withProviders(
  Effect.gen(function* () {
    const listed = yield* scheduler.listSchedules({
      NamePrefix: SCHEDULE_PREFIX,
    });
    const names = (listed.Schedules ?? []).flatMap((s) =>
      s.Name ? [s.Name] : [],
    );
    if (names.length > 0) {
      yield* Effect.logInfo(
        `Scheduler test cleanup: deleting leftover schedules ${names.join(", ")}`,
      );
    }
    yield* Effect.forEach(
      names,
      (name) =>
        scheduler
          .deleteSchedule({ Name: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          ),
      { concurrency: 5 },
    );
  }),
  testOptions,
  "SchedulerBindingsPurge",
);

// Bounded poll until a message whose JSON body matches the predicate shows up
// on the queue; matched messages are deleted so re-polls stay clean.
const receiveMatching = (
  queueUrl: string,
  matches: (body: any) => boolean,
  options?: { times?: number },
) =>
  Effect.gen(function* () {
    const result = yield* SQS.receiveMessage({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 5,
      VisibilityTimeout: 15,
    });
    const match = (result.Messages ?? []).find((message) => {
      try {
        return message.Body !== undefined && matches(JSON.parse(message.Body));
      } catch {
        return false;
      }
    });
    if (!match?.ReceiptHandle) {
      return yield* Effect.fail(new MessageNotDelivered());
    }
    yield* SQS.deleteMessage({
      QueueUrl: queueUrl,
      ReceiptHandle: match.ReceiptHandle,
    });
    return JSON.parse(match.Body!) as any;
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "MessageNotDelivered",
      schedule: Schedule.max([
        Schedule.fixed("1 seconds"),
        Schedule.recurs(options?.times ?? 12),
      ]),
    }),
  );

// Typed wait-until-gone: retries while GetSchedule still succeeds.
const waitUntilScheduleGone = (name: string) =>
  Effect.gen(function* () {
    const found = yield* scheduler
      .getSchedule({ Name: name })
      .pipe(
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(undefined),
        ),
      );
    if (found !== undefined) {
      return yield* Effect.fail(new ScheduleStillExists());
    }
  }).pipe(
    Effect.retry({
      while: (error) => error._tag === "ScheduleStillExists",
      schedule: Schedule.max([
        Schedule.fixed("3 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

describe("Scheduler Bindings", () => {
  beforeAll(
    Effect.gen(function* () {
      yield* Effect.logInfo(
        "Scheduler test setup: destroying previous resources",
      );
      yield* sharedStack.destroy();
      yield* purgeTestSchedules;

      yield* Effect.logInfo("Scheduler test setup: deploying fixture");
      const { functionUrl } = yield* sharedStack.deploy(
        Effect.gen(function* () {
          return yield* SchedulerTestFunction;
        }).pipe(Effect.provide(SchedulerTestFunctionLive)),
      );

      expect(functionUrl).toBeTruthy();
      baseUrl = functionUrl!.replace(/\/+$/, "");
      const readinessUrl = `${baseUrl}/info`;

      yield* Effect.logInfo(
        `Scheduler test setup: probing readiness at ${readinessUrl}`,
      );
      const info = yield* HttpClient.get(readinessUrl).pipe(
        Effect.flatMap((response) =>
          response.status === 200
            ? (response.json as Effect.Effect<{
                sinkQueueUrl?: string;
                cronQueueUrl?: string;
              }>)
            : Effect.fail(new Error(`Function not ready: ${response.status}`)),
        ),
        Effect.flatMap((body) =>
          body.sinkQueueUrl && body.cronQueueUrl
            ? Effect.succeed(
                body as { sinkQueueUrl: string; cronQueueUrl: string },
              )
            : Effect.fail(new Error("Function returned empty queue urls")),
        ),
        Effect.tapError((error) =>
          Effect.logWarning(
            `Scheduler test setup: fixture not ready yet (${String(error)})`,
          ),
        ),
        Effect.retry({ schedule: readinessPolicy }),
      );
      sinkQueueUrl = info.sinkQueueUrl;
      cronQueueUrl = info.cronQueueUrl;
    }),
    { timeout: 240_000 },
  );

  afterAll(
    Effect.gen(function* () {
      // NO_DESTROY=1 keeps the deployment (and its log group) around while
      // iterating locally — standard escape hatch, default is full cleanup.
      if (process.env.NO_DESTROY) return;
      // Leak guard: no runtime-minted schedules may outlive the suite.
      yield* purgeTestSchedules;
      yield* sharedStack.destroy();
    }),
    { timeout: 120_000 },
  );

  describe("CreateSchedule", () => {
    test.provider(
      "mints a one-shot at() schedule whose target fires (iam:PassRole end-to-end)",
      (_stack) =>
        Effect.gen(function* () {
          const name = `${SCHEDULE_PREFIX}oneshot`;

          const created = (yield* send(
            HttpClientRequest.post(
              `${baseUrl}/schedules/${name}?delaySeconds=15`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            scheduleArn: string;
            expression: string;
          };

          expect(created.scheduleArn).toContain(`:schedule/default/${name}`);
          expect(created.expression).toMatch(/^at\(/);

          // Out-of-band: the schedule exists with the one-shot config the
          // fixture requested.
          const observed = yield* scheduler.getSchedule({ Name: name });
          expect(observed.Name).toBe(name);
          expect(observed.ActionAfterCompletion).toBe("DELETE");
          expect(observed.Target?.RoleArn).toBeTruthy();

          // The schedule fires ~15s after creation; the execution role (which
          // the binding contributed iam:PassRole for) delivers the marker into
          // the sink queue. Bounded: ~15s delay + poll ≤ ~75s.
          const message = yield* receiveMatching(
            sinkQueueUrl,
            (body) => body.marker === name,
          );
          expect(message.marker).toBe(name);

          // ActionAfterCompletion=DELETE reaps the fired one-shot: typed
          // wait-until-gone doubles as the no-leak proof.
          yield* waitUntilScheduleGone(name);
        }),
      { timeout: 150_000 },
    );
  });

  describe("GetSchedule", () => {
    test.provider("reads a pending schedule through the binding", (_stack) =>
      Effect.gen(function* () {
        const name = `${SCHEDULE_PREFIX}get`;

        yield* send(
          HttpClientRequest.post(
            `${baseUrl}/schedules/${name}?delaySeconds=900`,
          ),
        );

        const found = (yield* send(
          HttpClientRequest.get(`${baseUrl}/schedules/${name}`),
        ).pipe(Effect.flatMap((r) => r.json))) as {
          arn: string;
          name: string;
          state: string;
          expression: string;
        };

        expect(found.name).toBe(name);
        expect(found.state).toBe("ENABLED");
        expect(found.expression).toMatch(/^at\(/);

        // cleanup via the DeleteSchedule binding route
        const deleted = yield* send(
          HttpClientRequest.delete(`${baseUrl}/schedules/${name}`),
        );
        expect(deleted.status).toBe(200);
      }),
    );

    test.provider("surfaces the typed not-found as a 404", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.get(
            `${baseUrl}/schedules/${SCHEDULE_PREFIX}missing`,
          ),
        );
        expect(response.status).toBe(404);
      }),
    );
  });

  describe("UpdateSchedule", () => {
    test.provider(
      "reschedules a pending schedule (full PUT + iam:PassRole)",
      (_stack) =>
        Effect.gen(function* () {
          const name = `${SCHEDULE_PREFIX}upd`;

          yield* send(
            HttpClientRequest.post(
              `${baseUrl}/schedules/${name}?delaySeconds=900`,
            ),
          );

          // Update: push the fire time out further and set a description.
          const updated = (yield* send(
            HttpClientRequest.put(
              `${baseUrl}/schedules/${name}?delaySeconds=1800&description=rescheduled`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            scheduleArn: string;
            expression: string;
          };
          expect(updated.scheduleArn).toContain(`:schedule/default/${name}`);

          // Out-of-band: the new expression and description landed.
          const observed = yield* scheduler.getSchedule({ Name: name });
          expect(observed.ScheduleExpression).toBe(updated.expression);
          expect(observed.Description).toBe("rescheduled");

          // cleanup via the DeleteSchedule binding route
          const deleted = yield* send(
            HttpClientRequest.delete(`${baseUrl}/schedules/${name}`),
          );
          expect(deleted.status).toBe(200);
        }),
      { timeout: 120_000 },
    );

    test.provider("surfaces the typed not-found as a 404", (_stack) =>
      Effect.gen(function* () {
        const response = yield* send(
          HttpClientRequest.put(
            `${baseUrl}/schedules/${SCHEDULE_PREFIX}missing-upd`,
          ),
        );
        expect(response.status).toBe(404);
      }),
    );
  });

  describe("ListSchedules", () => {
    test.provider(
      "lists runtime-minted schedules by prefix (default-group scoped)",
      (_stack) =>
        Effect.gen(function* () {
          const nameA = `${SCHEDULE_PREFIX}list-a`;
          const nameB = `${SCHEDULE_PREFIX}list-b`;

          yield* send(
            HttpClientRequest.post(
              `${baseUrl}/schedules/${nameA}?delaySeconds=900`,
            ),
          );
          yield* send(
            HttpClientRequest.post(
              `${baseUrl}/schedules/${nameB}?delaySeconds=900`,
            ),
          );

          const listed = (yield* send(
            HttpClientRequest.get(
              `${baseUrl}/schedules?namePrefix=${SCHEDULE_PREFIX}list-`,
            ),
          ).pipe(Effect.flatMap((r) => r.json))) as {
            names: string[];
            error?: string;
            message?: string;
          };

          // A typed failure inside the Lambda surfaces here with its tag.
          expect(listed.error, listed.message).toBeUndefined();
          expect(listed.names).toContain(nameA);
          expect(listed.names).toContain(nameB);

          // cleanup via the DeleteSchedule binding route
          for (const name of [nameA, nameB]) {
            const deleted = yield* send(
              HttpClientRequest.delete(`${baseUrl}/schedules/${name}`),
            );
            expect(deleted.status).toBe(200);
          }
        }),
      { timeout: 120_000 },
    );
  });

  describe("DeleteSchedule", () => {
    test.provider(
      "deletes a pending schedule and reports not-found on repeat",
      (_stack) =>
        Effect.gen(function* () {
          const name = `${SCHEDULE_PREFIX}del`;

          yield* send(
            HttpClientRequest.post(
              `${baseUrl}/schedules/${name}?delaySeconds=900`,
            ),
          );

          // out-of-band: it exists before deletion
          const observed = yield* scheduler.getSchedule({ Name: name });
          expect(observed.Name).toBe(name);

          const first = yield* send(
            HttpClientRequest.delete(`${baseUrl}/schedules/${name}`),
          );
          expect(first.status).toBe(200);
          expect(((yield* first.json) as any).deleted).toBe(true);

          // out-of-band typed wait-until-gone
          yield* waitUntilScheduleGone(name);

          // idempotent repeat surfaces the typed ResourceNotFoundException
          const second = yield* send(
            HttpClientRequest.delete(`${baseUrl}/schedules/${name}`),
          );
          expect(second.status).toBe(404);
        }),
      { timeout: 120_000 },
    );
  });

  describe("ScheduleEventSource", () => {
    test.provider(
      "the cron handler consumes its own scheduled invocations",
      (_stack) =>
        Effect.gen(function* () {
          // The fixture registered consumeSchedule(every("1 minute"), ...) at
          // deploy time; the first fire lands within a minute of schedule
          // creation (usually before the tests start), forwarded into the
          // cron queue as the typed ScheduleEvent envelope. Bounded: long-poll
          // ~90s to ride out one full rate window.
          const event = yield* receiveMatching(
            cronQueueUrl,
            (body) => body.marker === "alch-schedtest-cron-fired",
            { times: 15 },
          );

          expect(event.scheduleArn).toContain(":schedule/default/");
          expect(event.scheduleId).toMatch(/^Scheduler[0-9a-f]{10}$/);
          expect(event.scheduledTime).toBeTruthy();
          expect(event.executionId).toBeTruthy();
        }),
      { timeout: 120_000 },
    );
  });
});
