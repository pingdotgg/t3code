import * as AWS from "@/AWS";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Bindings fixture: a standalone SQS→SQS pipe (no Lambda target, so no
// circularity) plus a Lambda that exercises the four Pipes runtime bindings
// against it — DescribePipe / ListPipes / StopPipe / StartPipe.
export class PipesBindingsFunction extends AWS.Lambda.Function<AWS.Lambda.Function>()(
  "PipesBindingsFunction",
) {}

export class BoundPipe extends Context.Service<
  BoundPipe,
  { pipe: AWS.Pipes.Pipe }
>()("BoundPipe") {}

export const BoundPipeLive = Layer.effect(
  BoundPipe,
  Effect.gen(function* () {
    const source = yield* AWS.SQS.Queue("BindingsSourceQueue");
    const target = yield* AWS.SQS.Queue("BindingsTargetQueue");
    const role = yield* AWS.IAM.Role("BindingsPipeRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "pipes.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      inlinePolicies: {
        PipeAccess: {
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:GetQueueAttributes",
              ],
              Resource: [source.queueArn],
            },
            {
              Effect: "Allow",
              Action: ["sqs:SendMessage"],
              Resource: [target.queueArn],
            },
          ],
        },
      },
    });
    const pipe = yield* AWS.Pipes.Pipe("BindingsPipe", {
      source: source.queueArn,
      target: target.queueArn,
      roleArn: role.roleArn,
      sourceParameters: {
        SqsQueueParameters: { BatchSize: 1 },
      },
    });
    return { pipe };
  }),
);

export default PipesBindingsFunction.make(
  {
    main: import.meta.url,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const { pipe } = yield* BoundPipe;

    const describePipe = yield* AWS.Pipes.DescribePipe(pipe);
    const listPipes = yield* AWS.Pipes.ListPipes();
    const stopPipe = yield* AWS.Pipes.StopPipe(pipe);
    const startPipe = yield* AWS.Pipes.StartPipe(pipe);

    const bound = { describePipe, listPipes, stopPipe, startPipe };

    const pipeName = yield* pipe.pipeName;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);
        const pathname = url.pathname;

        if (request.method === "GET" && pathname === "/bindings") {
          return yield* HttpServerResponse.json({
            bound: Object.keys(bound),
          });
        }

        if (request.method === "GET" && pathname === "/describe") {
          const described = yield* describePipe();
          return yield* HttpServerResponse.json({
            name: described.Name,
            currentState: described.CurrentState,
            desiredState: described.DesiredState,
          });
        }

        if (request.method === "GET" && pathname === "/list") {
          const { Pipes } = yield* listPipes({
            NamePrefix: yield* pipeName,
          });
          return yield* HttpServerResponse.json({
            names: (Pipes ?? []).flatMap((p) =>
              p.Name !== undefined ? [p.Name] : [],
            ),
          });
        }

        if (request.method === "GET" && pathname === "/stop") {
          const response = yield* stopPipe();
          return yield* HttpServerResponse.json({
            desiredState: response.DesiredState,
            currentState: response.CurrentState,
          });
        }

        if (request.method === "GET" && pathname === "/start") {
          const response = yield* startPipe();
          return yield* HttpServerResponse.json({
            desiredState: response.DesiredState,
            currentState: response.CurrentState,
          });
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
        AWS.Pipes.DescribePipeHttp,
        AWS.Pipes.ListPipesHttp,
        AWS.Pipes.StopPipeHttp,
        AWS.Pipes.StartPipeHttp,
        BoundPipeLive,
      ),
    ),
  ),
);
