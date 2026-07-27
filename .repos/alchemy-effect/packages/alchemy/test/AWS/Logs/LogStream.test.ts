import * as AWS from "@/AWS";
import { LogGroup } from "@/AWS/Logs/LogGroup.ts";
import { LogStream } from "@/AWS/Logs/LogStream.ts";
import * as Test from "@/Test/Alchemy";
import * as logs from "@distilled.cloud/aws/cloudwatch-logs";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const describeLogStream = Effect.fn(function* (
  logGroupName: string,
  logStreamName: string,
) {
  const described = yield* logs
    .describeLogStreams({ logGroupName, logStreamNamePrefix: logStreamName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed({ logStreams: [] }),
      ),
    );
  return (described.logStreams ?? []).find(
    (stream) => stream.logStreamName === logStreamName,
  );
});

class LogStreamStillExists extends Data.TaggedError("LogStreamStillExists")<{
  readonly logStreamName: string;
}> {}

const assertLogStreamDeleted = (logGroupName: string, logStreamName: string) =>
  describeLogStream(logGroupName, logStreamName).pipe(
    Effect.flatMap((stream) =>
      stream === undefined
        ? Effect.void
        : Effect.fail(new LogStreamStillExists({ logStreamName })),
    ),
    Effect.retry({
      while: (e) => e._tag === "LogStreamStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create, replace on rename, delete log stream",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const logGroup = yield* LogGroup("StreamLogGroup", {
            retention: "1 day",
          });
          return yield* LogStream("AuditStream", {
            logGroupName: logGroup.logGroupName,
          });
        }),
      );

      expect(created.logStreamName).toBeDefined();
      expect(created.logStreamArn).toContain(":log-group:");

      // out-of-band verification via distilled
      expect(
        yield* describeLogStream(created.logGroupName, created.logStreamName),
      ).toBeDefined();

      // no-op deploy keeps the same stream
      const noop = yield* stack.deploy(
        Effect.gen(function* () {
          const logGroup = yield* LogGroup("StreamLogGroup", {
            retention: "1 day",
          });
          return yield* LogStream("AuditStream", {
            logGroupName: logGroup.logGroupName,
          });
        }),
      );
      expect(noop.logStreamName).toBe(created.logStreamName);

      // explicit logStreamName triggers a replacement
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          const logGroup = yield* LogGroup("StreamLogGroup", {
            retention: "1 day",
          });
          return yield* LogStream("AuditStream", {
            logGroupName: logGroup.logGroupName,
            logStreamName: "alchemy-test-audit-stream-renamed",
          });
        }),
      );
      expect(replaced.logStreamName).toBe("alchemy-test-audit-stream-renamed");
      expect(
        yield* describeLogStream(replaced.logGroupName, replaced.logStreamName),
      ).toBeDefined();
      yield* assertLogStreamDeleted(
        created.logGroupName,
        created.logStreamName,
      );

      yield* stack.destroy();
      yield* assertLogStreamDeleted(
        replaced.logGroupName,
        replaced.logStreamName,
      );
    }).pipe(Effect.onError(() => stack.destroy().pipe(Effect.ignore))),
  { timeout: 120_000 },
);
