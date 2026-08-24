import * as EMRContainers from "@/AWS/EMRContainers";
import { Role } from "@/AWS/IAM";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class EmrcTestFunction extends Lambda.Function<Lambda.Function>()(
  "EmrcTestFunction",
) {}

export default EmrcTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The job template the template-scoped binding is bound to. Templates
    // are free, account-level, and never run anything by themselves.
    const jobRole = yield* Role("JobRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "pods.eks.amazonaws.com" },
            Action: ["sts:AssumeRole", "sts:TagSession"],
          },
        ],
      },
    });
    const template = yield* EMRContainers.JobTemplate("BindingTemplate", {
      jobTemplateData: {
        executionRoleArn: jobRole.roleArn,
        releaseLabel: "emr-7.5.0-latest",
        jobDriver: {
          sparkSubmitJobDriver: {
            entryPoint: "s3://alchemy-test-emrc/scripts/etl.py",
          },
        },
      },
    });

    // Event source: subscribe the host to EMR on EKS job run state changes.
    // The deploy proves the EventBridge rule + invoke permission wiring.
    yield* EMRContainers.consumeJobRunEvents(
      { states: ["FAILED", "COMPLETED"] },
      (events) =>
        Stream.runForEach(events, (event) =>
          Effect.log(`job run ${event.detail.id} -> ${event.detail.state}`),
        ),
    );

    const describeJobTemplate =
      yield* EMRContainers.DescribeJobTemplate(template);
    const listJobTemplates = yield* EMRContainers.ListJobTemplates();
    const listVirtualClusters = yield* EMRContainers.ListVirtualClusters();
    const templateId = yield* template.jobTemplateId;

    const bound = {
      describeJobTemplate,
      listJobTemplates,
      listVirtualClusters,
    };

    // Drain a bounded number of pages on every observation. AWS list APIs may
    // return a short (or empty) page with a continuation token while the
    // account is being mutated by other test files, so repeatedly reading only
    // page one makes the full-concurrency sweep flaky.
    const listAllJobTemplates = Effect.fn(function* () {
      const templates: Array<{ readonly id?: string }> = [];
      let nextToken: string | undefined;
      for (let page = 0; page < 10; page++) {
        const response = yield* listJobTemplates({
          maxResults: 100,
          nextToken,
        });
        templates.push(...(response.templates ?? []));
        nextToken = response.nextToken;
        if (nextToken === undefined) break;
      }
      return templates;
    });

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

        // Template-scoped read: the template id is injected by the binding.
        if (request.method === "GET" && pathname === "/template") {
          const { jobTemplate } = yield* describeJobTemplate();
          return yield* HttpServerResponse.json({
            id: jobTemplate?.id,
            name: jobTemplate?.name,
            releaseLabel: jobTemplate?.jobTemplateData.releaseLabel,
          });
        }

        // Account-level list.
        if (request.method === "GET" && pathname === "/templates") {
          const expectedTemplateId = yield* templateId;
          const templates = yield* Effect.repeat(listAllJobTemplates(), {
            schedule: Schedule.fixed("2 seconds"),
            until: (items) =>
              items.some((item) => item.id === expectedTemplateId),
            times: 10,
          });
          return yield* HttpServerResponse.json({
            ids: templates.map((template) => template.id),
          });
        }

        // Account-level virtual cluster list (proves IAM grant + call path
        // without needing an EKS-backed virtual cluster to exist).
        if (request.method === "GET" && pathname === "/virtual-clusters") {
          const { virtualClusters } = yield* listVirtualClusters({
            states: ["RUNNING"],
          });
          return yield* HttpServerResponse.json({
            ids: (virtualClusters ?? []).map((vc) => vc.id),
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
        Lambda.EventSource,
        EMRContainers.DescribeJobTemplateHttp,
        EMRContainers.ListJobTemplatesHttp,
        EMRContainers.ListVirtualClustersHttp,
      ),
    ),
  ),
);
