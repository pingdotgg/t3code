import * as AppRunner from "@/AWS/AppRunner";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

/**
 * Bindings fixture: a Lambda that manages an App Runner service through the
 * ListOperations / PauseService / ResumeService / StartDeployment bindings.
 * The service itself is the cheap public-ECR hello image (no access role, no
 * Docker build).
 */
export class AppRunnerTestFunction extends Lambda.Function<Lambda.Function>()(
  "AppRunnerTestFunction",
) {}

export default AppRunnerTestFunction.make(
  {
    main,
    url: true,
    // Pause/resume calls fan out SDK calls; AWS's 3s default intermittently
    // times out on a cold start.
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    const service = yield* AppRunner.Service("BindingsService", {
      serviceName: "alchemy-test-apprunner-bind",
      imageRepository: {
        imageIdentifier:
          "public.ecr.aws/aws-containers/hello-app-runner:latest",
        imageRepositoryType: "ECR_PUBLIC",
        port: "8000",
      },
      instanceConfiguration: { cpu: "256", memory: "512" },
    });

    const listOperations = yield* AppRunner.ListOperations(service);
    const pauseService = yield* AppRunner.PauseService(service);
    const resumeService = yield* AppRunner.ResumeService(service);
    const startDeployment = yield* AppRunner.StartDeployment(service);
    const describeCustomDomains =
      yield* AppRunner.DescribeCustomDomains(service);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;

        if (request.method === "GET" && pathname === "/operations") {
          const result = yield* listOperations({ MaxResults: 20 });
          return yield* HttpServerResponse.json({
            operations: (result.OperationSummaryList ?? []).map((op) => ({
              id: op.Id,
              type: op.Type,
              status: op.Status,
            })),
          });
        }

        if (request.method === "POST" && pathname === "/pause") {
          const result = yield* pauseService();
          return yield* HttpServerResponse.json({
            serviceArn: result.Service.ServiceArn,
            status: result.Service.Status,
            operationId: result.OperationId,
          });
        }

        if (request.method === "POST" && pathname === "/resume") {
          const result = yield* resumeService();
          return yield* HttpServerResponse.json({
            serviceArn: result.Service.ServiceArn,
            status: result.Service.Status,
            operationId: result.OperationId,
          });
        }

        if (request.method === "POST" && pathname === "/deploy") {
          const result = yield* startDeployment();
          return yield* HttpServerResponse.json({
            operationId: result.OperationId,
          });
        }

        if (request.method === "GET" && pathname === "/custom-domains") {
          const result = yield* describeCustomDomains();
          return yield* HttpServerResponse.json({
            dnsTarget: result.DNSTarget,
            customDomains: (result.CustomDomains ?? []).map((domain) => ({
              domainName: domain.DomainName,
              status: domain.Status,
            })),
          });
        }

        if (request.method === "GET" && pathname === "/ping") {
          return yield* HttpServerResponse.json({ ok: true });
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
        AppRunner.DescribeCustomDomainsHttp,
        AppRunner.ListOperationsHttp,
        AppRunner.PauseServiceHttp,
        AppRunner.ResumeServiceHttp,
        AppRunner.StartDeploymentHttp,
      ),
    ),
  ),
);
