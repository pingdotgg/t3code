/**
 * Actions under `alchemy dev`: the common shapes a deploy-time binding client
 * takes, each proven to land on the floci emulator rather than the real
 * cloud.
 *
 * In a dev run every dualized resource resolves to its LOCAL provider, so the
 * physical resource exists only on the emulator. An Action body runs at
 * deploy time in the plan process — whose ambient AWS environment is the
 * live `testing` profile — so without per-resource routing its binding
 * clients would miss the emulated resource or mutate the real cloud. #1308
 * routes each client to the bound resource's registered data plane; this
 * suite pins that for the shapes users actually write:
 *
 *   - one Action binding several services (S3 + SQS + DynamoDB) — each
 *     client routed independently;
 *   - an Action's output feeding a downstream resource's props;
 *   - a single-resource binding on a hand-written floci dual
 *     (`InvokeFunction(fn)`) — the case that used to be left UNROUTED and
 *     silently hit the real cloud;
 *   - a multi-resource binding spanning a `flociDual` and a hand-written
 *     dual (`RunTask(cluster, task)`) — the reported "mixed data planes"
 *     failure;
 *   - a binding that genuinely spans modes (`Alchemy.remote()` on one side)
 *     fails at bind time with a per-resource explanation.
 *
 * Out-of-band checks use the distilled SDK under `flociServices()` (the
 * emulator) and, where it matters, the ambient live environment (to prove
 * absence). Requires Docker (floci runs as a container).
 */
import { Action } from "@/Action";
import * as AWS from "@/AWS";
import { flociServices } from "@/AWS/Local/FlociServices.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { liveContext } from "./fixtures/live.ts";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import * as S3 from "@distilled.cloud/aws/s3";
import * as SQS from "@distilled.cloud/aws/sqs";
import * as SSM from "@distilled.cloud/aws/ssm";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { fileURLToPath } from "node:url";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const echoHandlerPath = fileURLToPath(
  new URL("./fixtures/actions/echo.mjs", import.meta.url),
);

/** The emulator runs task containers on THIS machine. */
const hostRuntimePlatform = {
  cpuArchitecture:
    process.arch === "arm64" ? ("ARM64" as const) : ("X86_64" as const),
  operatingSystemFamily: "LINUX" as const,
};

/** Collect a streaming SDK body into its decoded text. */
const readBody = (body: Stream.Stream<Uint8Array, Error>) =>
  Stream.runCollect(body).pipe(
    Effect.map((chunks) =>
      new TextDecoder().decode(Buffer.concat([...chunks])),
    ),
  );

test.provider(
  "one Action binding S3, SQS and DynamoDB routes every client to the emulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* AWS.S3.Bucket("ActionsBucket", {
            forceDestroy: true,
          });
          const queue = yield* AWS.SQS.Queue("ActionsQueue");
          const table = yield* AWS.DynamoDB.Table("ActionsTable", {
            partitionKey: "id",
            attributes: { id: "S" },
          });

          // A realistic "ingest" Action: write the object, record it, and
          // enqueue its key — three services behind one body.
          const Ingest = Action(
            "Ingest",
            Effect.gen(function* () {
              const putObject = yield* AWS.S3.PutObject(bucket);
              const getObject = yield* AWS.S3.GetObject(bucket);
              const sendMessage = yield* AWS.SQS.SendMessage(queue);
              const putItem = yield* AWS.DynamoDB.PutItem(table);
              return Effect.fn(function* (input: { key: string }) {
                yield* putObject({ Key: input.key, Body: "ingested" });
                const object = yield* getObject({ Key: input.key });
                const body = yield* readBody(object.Body!);
                yield* putItem({
                  Item: { id: { S: input.key }, body: { S: body } },
                });
                const sent = yield* sendMessage({ MessageBody: input.key });
                return { body, messageId: sent.MessageId };
              });
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  AWS.S3.PutObjectHttp,
                  AWS.S3.GetObjectHttp,
                  AWS.SQS.SendMessageHttp,
                  AWS.DynamoDB.PutItemHttp,
                ),
              ),
            ),
          );
          const ingested = yield* Ingest({ key: "uploads/hello.txt" });
          return {
            bucketName: bucket.bucketName,
            queueUrl: queue.queueUrl,
            tableName: table.tableName,
            ingested,
          };
        }),
      );

      // The Action read back what it wrote — through the emulator.
      expect(outputs.ingested.body).toBe("ingested");
      expect(outputs.ingested.messageId).toBeTruthy();

      // Every side effect landed on the emulator…
      const head = yield* S3.headObject({
        Bucket: outputs.bucketName,
        Key: "uploads/hello.txt",
      }).pipe(Effect.provide(flociServices()));
      expect(head.ContentLength).toBe("ingested".length);

      const item = yield* DynamoDB.getItem({
        TableName: outputs.tableName,
        Key: { id: { S: "uploads/hello.txt" } },
      }).pipe(Effect.provide(flociServices()));
      expect(item.Item?.body).toEqual({ S: "ingested" });

      const received = yield* SQS.receiveMessage({
        QueueUrl: outputs.queueUrl,
        MaxNumberOfMessages: 1,
        WaitTimeSeconds: 5,
      }).pipe(Effect.provide(flociServices()));
      expect(received.Messages?.[0]?.Body).toBe("uploads/hello.txt");

      // …and the bucket never existed on the real cloud. The ambient
      // environment in a dev run is the emulator, so the real cloud is
      // reached EXPLICITLY via the live environment chain.
      const live = yield* S3.headBucket({ Bucket: outputs.bucketName }).pipe(
        Effect.map(() => "found" as const),
        Effect.catchTag("NotFound", () => Effect.succeed("not-found" as const)),
        Effect.provide(liveContext),
      );
      expect(live).toBe("not-found");

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);

test.provider(
  "an Action's output feeds a downstream resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* AWS.SSM.Parameter("ActionsSource", {
            value: "region-a",
          });
          // Read one parameter through its binding, derive a value, and
          // hand the Action's Output to a second resource's props.
          const Derive = Action(
            "Derive",
            Effect.gen(function* () {
              const getParameter = yield* AWS.SSM.GetParameter(source);
              return Effect.fn(function* () {
                const current = yield* getParameter({ WithDecryption: true });
                const raw = current.Parameter?.Value;
                const value =
                  typeof raw === "string" ? raw : Redacted.value(raw!);
                return { derived: `${value}:derived` };
              });
            }).pipe(Effect.provide(AWS.SSM.GetParameterHttp)),
          );
          const derived = yield* Derive({});
          const target = yield* AWS.SSM.Parameter("ActionsTarget", {
            value: derived.derived,
          });
          return { sourceArn: source.parameterArn, target };
        }),
      );

      expect(outputs.sourceArn).toContain(":000000000000:");
      expect(outputs.target.parameterArn).toContain(":000000000000:");

      // The downstream parameter carries the Action-derived value — on the
      // emulator, where the Action's GetParameter read from.
      const stored = yield* SSM.getParameter({
        Name: outputs.target.parameterName,
      }).pipe(Effect.provide(flociServices()));
      const value = stored.Parameter?.Value;
      expect(typeof value === "string" ? value : Redacted.value(value!)).toBe(
        "region-a:derived",
      );

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);

test.provider(
  "InvokeFunction(fn) Action invokes the dev Lambda on the emulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const fn = yield* AWS.Lambda.Function("ActionsEcho", {
            main: echoHandlerPath,
            handler: "handler",
            bundle: false,
            functionUrl: false,
          });
          // A single-resource binding on a hand-written floci dual. Before
          // Lambda.Function declared its data plane this client was left
          // unrouted and the invoke went to the real cloud.
          const Ping = Action(
            "Ping",
            Effect.gen(function* () {
              const invoke = yield* AWS.Lambda.InvokeFunction(fn);
              return Effect.fn(function* (input: { message: string }) {
                const response = yield* invoke({
                  Payload: new TextEncoder().encode(JSON.stringify(input)),
                });
                const result = JSON.parse(
                  yield* readBody(response.Payload!),
                ) as { echoed: { message: string }; from: string };
                return { statusCode: response.StatusCode, result };
              });
            }).pipe(Effect.provide(AWS.Lambda.InvokeFunctionHttp)),
          );
          return {
            functionArn: fn.functionArn,
            ping: yield* Ping({ message: "hello" }),
          };
        }),
      );

      expect(outputs.functionArn).toContain(":000000000000:");
      expect(outputs.ping.statusCode).toBe(200);
      expect(outputs.ping.result.from).toBe("floci-echo");
      expect(outputs.ping.result.echoed).toEqual({ message: "hello" });

      yield* stack.destroy();
    }),
  // First invoke pulls the Lambda runtime image on a cold machine.
  { timeout: 600_000 },
);

test.provider(
  "RunTask(cluster, task) Action launches the task on the emulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const cluster = yield* AWS.ECS.Cluster("ActionsCluster");
          const task = yield* AWS.ECS.Task("ActionsTask", {
            image: "busybox:stable",
            command: ["true"],
            cpu: 256,
            memory: 512,
            requiresCompatibilities: ["EC2"],
            runtimePlatform: hostRuntimePlatform,
          });
          // A multi-resource binding spanning a `flociDual` (Cluster) and a
          // hand-written dual (Task). The reported bug: with Task
          // undeclared this bind died with "mixed data planes".
          const Launch = Action(
            "Launch",
            Effect.gen(function* () {
              const runTask = yield* AWS.ECS.RunTask(cluster, task);
              return () =>
                runTask({ launchType: "EC2", count: 1 }).pipe(
                  Effect.map((response) => ({
                    taskArn: response.tasks?.[0]?.taskArn,
                    failures: response.failures ?? [],
                  })),
                );
            }).pipe(Effect.provide(AWS.ECS.RunTaskHttp)),
          );
          return {
            clusterArn: cluster.clusterArn,
            launched: yield* Launch({}),
          };
        }),
      );

      expect(outputs.clusterArn).toContain(":000000000000:");
      expect(outputs.launched.failures).toEqual([]);
      expect(outputs.launched.taskArn).toContain(":000000000000:");

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);

test.provider(
  "a binding spanning a remote() resource and a local one fails at bind with a per-resource explanation",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const exit = yield* Effect.exit(
        stack.deploy(
          Effect.gen(function* () {
            // Pinned live: its clients belong to the real cloud…
            const cluster = yield* AWS.ECS.Cluster("MixedCluster").pipe(
              Alchemy.remote(),
            );
            // …while the task is emulated. One API call cannot span both.
            const task = yield* AWS.ECS.Task("MixedTask", {
              image: "busybox:stable",
              command: ["true"],
              cpu: 256,
              memory: 512,
              requiresCompatibilities: ["EC2"],
              runtimePlatform: hostRuntimePlatform,
            });
            const Launch = Action(
              "MixedLaunch",
              Effect.gen(function* () {
                const runTask = yield* AWS.ECS.RunTask(cluster, task);
                return () => runTask({ launchType: "EC2", count: 1 });
              }).pipe(Effect.provide(AWS.ECS.RunTaskHttp)),
            );
            return { launched: yield* Launch({}) };
          }),
        ),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      const message = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
      // Each resource is named with WHERE it lands and WHY — never the old
      // "(some local, some live)" that hid which one and for what reason.
      expect(message).toContain("Binding client spans mixed data planes");
      expect(message).toContain("MixedCluster → real cloud (live mode)");
      expect(message).toContain("MixedTask → local emulator");

      yield* stack.destroy();
    }),
  { timeout: 300_000 },
);
