import * as AIOps from "@/AWS/AIOps";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class AIOpsTestFunction extends Lambda.Function<Lambda.Function>()(
  "AIOpsTestFunction",
) {}

export default AIOpsTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(30),
  },
  Effect.gen(function* () {
    // The one-per-Region investigation group the group-scoped bindings are
    // bound to. The role is what CloudWatch investigations assumes to read
    // telemetry — required at create time.
    const role = yield* Role("AIOpsBindingRole", {
      assumeRolePolicyDocument: {
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "aiops.amazonaws.com" },
            Action: ["sts:AssumeRole"],
          },
        ],
      },
      managedPolicyArns: ["arn:aws:iam::aws:policy/AIOpsAssistantPolicy"],
    });
    const group = yield* AIOps.InvestigationGroup("BindingGroup", {
      roleArn: role.roleArn,
      retention: "7 days",
      tags: { Purpose: "bindings-test" },
    });

    const getInvestigationGroup = yield* AIOps.GetInvestigationGroup(group);
    const getInvestigationGroupPolicy =
      yield* AIOps.GetInvestigationGroupPolicy(group);
    const listTagsForResource = yield* AIOps.ListTagsForResource(group);
    const listInvestigationGroups = yield* AIOps.ListInvestigationGroups();

    const bound = {
      getInvestigationGroup,
      getInvestigationGroupPolicy,
      listTagsForResource,
      listInvestigationGroups,
    };

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

        // Group-scoped read: the group ARN is injected from the binding.
        if (request.method === "GET" && pathname === "/group") {
          const detail = yield* getInvestigationGroup();
          return yield* HttpServerResponse.json({
            name: detail.name,
            arn: detail.arn,
            retentionInDays: detail.retentionInDays,
          });
        }

        // Group-scoped policy read: no policy is attached to the fixture's
        // group, so the typed ResourceNotFoundException proves the grant and
        // ARN injection end-to-end.
        if (request.method === "GET" && pathname === "/policy") {
          const policy = yield* getInvestigationGroupPolicy().pipe(
            Effect.map((r) => r.policy),
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
          return yield* HttpServerResponse.json({
            hasPolicy: policy !== undefined,
          });
        }

        // Group-scoped tag read.
        if (request.method === "GET" && pathname === "/tags") {
          const { tags } = yield* listTagsForResource();
          return yield* HttpServerResponse.json({ tags: tags ?? {} });
        }

        // Account-level list: at most one group exists per Region, and it is
        // the fixture's own group.
        if (request.method === "GET" && pathname === "/groups") {
          const { investigationGroups } = yield* listInvestigationGroups();
          return yield* HttpServerResponse.json({
            groupArns: (investigationGroups ?? []).map((g) => g.arn),
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
        AIOps.GetInvestigationGroupHttp,
        AIOps.GetInvestigationGroupPolicyHttp,
        AIOps.ListTagsForResourceHttp,
        AIOps.ListInvestigationGroupsHttp,
      ),
    ),
  ),
);
