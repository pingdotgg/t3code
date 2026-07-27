import * as IAM from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Scheduler from "@/AWS/Scheduler";
import * as SQS from "@/AWS/SQS";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

// Shared Lambda fixture for the EventBridge Scheduler runtime surface:
// - CreateSchedule / GetSchedule / DeleteSchedule bindings, one HTTP route
//   per operation. Runtime-minted one-shot schedules target the sink queue,
//   so the test can observe the fire out-of-band.
// - consumeSchedule (the cron-handler DX): a rate(1 minute) schedule invokes
//   this same Lambda; the handler forwards the typed event into the cron
//   queue for out-of-band observation.
export class SchedulerTestFunction extends Lambda.Function<Lambda.Function>()(
  "SchedulerTestFunction",
) {}

export default SchedulerTestFunction.make(
  {
    main,
    url: true,
    // AWS's 3s default intermittently kills invocations that fan out SDK
    // calls (create + describe schedules) — always set an explicit timeout.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // Queue that runtime-minted one-shot schedules deliver into.
    const sinkQueue = yield* SQS.Queue("SchedulerSinkQueue");
    // Queue the consumeSchedule cron handler forwards its typed events into.
    const cronQueue = yield* SQS.Queue("SchedulerCronQueue");

    // Execution role for runtime-minted schedules: assumable by EventBridge
    // Scheduler, allowed to send into the sink queue. The CreateSchedule
    // binding contributes iam:PassRole on this role to the host's policy.
    const executionRole = yield* IAM.Role("SchedulerExecutionRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "scheduler.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        ScheduleTarget: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: [sinkQueue.queueArn],
            },
          ],
        },
      },
    });

    const createSchedule = yield* Scheduler.CreateSchedule(executionRole);
    const updateSchedule = yield* Scheduler.UpdateSchedule(executionRole);
    const getSchedule = yield* Scheduler.GetSchedule();
    const deleteSchedule = yield* Scheduler.DeleteSchedule();
    const listSchedules = yield* Scheduler.ListSchedules();
    const sendCron = yield* SQS.SendMessage(cronQueue);

    // The cron-handler DX: consume this Lambda's own scheduled invocations
    // and forward the typed event into the cron queue.
    yield* Scheduler.consumeSchedule(Scheduler.every("1 minute"), (event) =>
      sendCron({
        MessageBody: JSON.stringify({
          marker: "alch-schedtest-cron-fired",
          scheduleId: event.scheduleId,
          scheduleArn: event.scheduleArn,
          scheduledTime: event.scheduledTime,
          executionId: event.executionId,
        }),
      }).pipe(Effect.orDie, Effect.asVoid),
    );

    const sinkQueueArn = yield* sinkQueue.queueArn;
    const sinkQueueUrl = yield* sinkQueue.queueUrl;
    const cronQueueUrl = yield* cronQueue.queueUrl;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/info") {
          return yield* HttpServerResponse.json({
            ok: true,
            sinkQueueUrl: yield* sinkQueueUrl,
            cronQueueUrl: yield* cronQueueUrl,
          });
        }

        if (request.method === "GET" && pathname === "/schedules") {
          const namePrefix = url.searchParams.get("namePrefix") ?? undefined;
          // Surface the typed failure in the body (424 so the test's 5xx
          // retry doesn't mask a genuine error) instead of dying to a 500.
          return yield* listSchedules({ NamePrefix: namePrefix }).pipe(
            Effect.flatMap((listed) =>
              HttpServerResponse.json({
                names: (listed.Schedules ?? []).flatMap((s) =>
                  s.Name ? [s.Name] : [],
                ),
              }),
            ),
            Effect.catch((e) =>
              HttpServerResponse.json(
                { error: e._tag, message: String(e) },
                { status: 424 },
              ),
            ),
          );
        }

        if (pathname.startsWith("/schedules/")) {
          const name = pathname.slice("/schedules/".length);

          if (request.method === "POST") {
            const delaySeconds = Number(
              url.searchParams.get("delaySeconds") ?? "30",
            );
            const fireAt = yield* Effect.sync(
              () => new Date(Date.now() + delaySeconds * 1000),
            );
            // One-shot at() expressions take second granularity, no timezone
            // suffix (UTC by default): at(yyyy-mm-ddThh:mm:ss)
            const expression = `at(${fireAt.toISOString().slice(0, 19)})`;

            const created = yield* createSchedule({
              Name: name,
              ScheduleExpression: expression,
              ActionAfterCompletion: "DELETE",
              Target: {
                Arn: yield* sinkQueueArn,
                Input: JSON.stringify({ marker: name }),
              },
            }).pipe(
              Effect.catchTag("ConflictException", () =>
                Effect.succeed(undefined),
              ),
            );

            if (created === undefined) {
              return yield* HttpServerResponse.json(
                { error: "Schedule already exists", name },
                { status: 409 },
              );
            }
            return yield* HttpServerResponse.json({
              scheduleArn: created.ScheduleArn,
              expression,
            });
          }

          if (request.method === "PUT") {
            const delaySeconds = Number(
              url.searchParams.get("delaySeconds") ?? "900",
            );
            const description =
              url.searchParams.get("description") ?? undefined;
            const fireAt = yield* Effect.sync(
              () => new Date(Date.now() + delaySeconds * 1000),
            );
            const expression = `at(${fireAt.toISOString().slice(0, 19)})`;

            // UpdateSchedule is a full PUT — resend the complete config.
            const updated = yield* updateSchedule({
              Name: name,
              ScheduleExpression: expression,
              Description: description,
              ActionAfterCompletion: "DELETE",
              Target: {
                Arn: yield* sinkQueueArn,
                Input: JSON.stringify({ marker: name }),
              },
            }).pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

            if (updated === undefined) {
              return yield* HttpServerResponse.json(
                { error: "Not found", name },
                { status: 404 },
              );
            }
            return yield* HttpServerResponse.json({
              scheduleArn: updated.ScheduleArn,
              expression,
            });
          }

          if (request.method === "GET") {
            const found = yield* getSchedule({ Name: name }).pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );
            if (found === undefined) {
              return yield* HttpServerResponse.json(
                { error: "Not found", name },
                { status: 404 },
              );
            }
            return yield* HttpServerResponse.json({
              arn: found.Arn,
              name: found.Name,
              state: found.State,
              expression: found.ScheduleExpression,
              actionAfterCompletion: found.ActionAfterCompletion,
            });
          }

          if (request.method === "DELETE") {
            const deleted = yield* deleteSchedule({ Name: name }).pipe(
              Effect.as(true),
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(false),
              ),
            );
            return yield* HttpServerResponse.json(
              { deleted },
              { status: deleted ? 200 : 404 },
            );
          }
        }

        return yield* HttpServerResponse.json(
          { error: "Not found", method: request.method, pathname },
          { status: 404 },
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Scheduler.CreateScheduleHttp,
        Scheduler.UpdateScheduleHttp,
        Scheduler.GetScheduleHttp,
        Scheduler.DeleteScheduleHttp,
        Scheduler.ListSchedulesHttp,
        Lambda.ScheduleEventSource,
        SQS.SendMessageHttp,
      ),
    ),
  ),
);
