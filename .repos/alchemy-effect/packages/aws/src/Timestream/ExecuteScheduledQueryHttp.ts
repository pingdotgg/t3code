import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import {
  ExecuteScheduledQuery,
  type ExecuteScheduledQueryRequest,
} from "./ExecuteScheduledQuery.ts";
import { discover, withEndpoint } from "./internal.ts";
import type { ScheduledQuery } from "./ScheduledQuery.ts";

// Bespoke (not on the BindingHttp scaffold): the only Timestream binding
// scoped to a ScheduledQuery rather than a Table or the account.
export const ExecuteScheduledQueryHttp = Layer.effect(
  ExecuteScheduledQuery,
  Effect.gen(function* () {
    const bind = yield* AWSBindings.Bind;
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const executeScheduledQuery = yield* AWSBindings.withCredentials(TSQ.executeScheduledQuery);
    const describeEndpoints = yield* AWSBindings.withCredentials(TSQ.describeEndpoints);
    const withQueryEndpoint = withEndpoint(discover("query", describeEndpoints({})));
    return Effect.fn(function* (scheduledQuery: ScheduledQuery) {
      const ScheduledQueryArn = yield* scheduledQuery.scheduledQueryArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`AWS.Timestream.ExecuteScheduledQuery(${scheduledQuery})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: ["timestream:ExecuteScheduledQuery"],
              Resource: [Output.interpolate`${scheduledQuery.scheduledQueryArn}`],
            },
            // Endpoint discovery is required and is not scoped to a
            // resource.
            {
              Effect: "Allow",
              Action: ["timestream:DescribeEndpoints"],
              Resource: ["*"],
            },
          ],
        });
      }
      return Effect.fn(`AWS.Timestream.ExecuteScheduledQuery(${scheduledQuery.LogicalId})`)(
        function* (request: ExecuteScheduledQueryRequest) {
          return yield* withQueryEndpoint(
            executeScheduledQuery({
              ...request,
              ScheduledQueryArn: yield* ScheduledQueryArn,
            }),
          );
        },
      );
    });
  }),
);
