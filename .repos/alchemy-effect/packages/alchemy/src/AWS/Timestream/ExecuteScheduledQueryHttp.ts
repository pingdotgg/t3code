import * as TSQ from "@distilled.cloud/aws/timestream-query";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import {
  ExecuteScheduledQuery,
  type ExecuteScheduledQueryRequest,
} from "./ExecuteScheduledQuery.ts";
import type { ScheduledQuery } from "./ScheduledQuery.ts";
import { discover, withEndpoint } from "./internal.ts";

// Bespoke (not on the BindingHttp scaffold): the only Timestream binding
// scoped to a ScheduledQuery rather than a Table or the account.
export const ExecuteScheduledQueryHttp = Layer.effect(
  ExecuteScheduledQuery,
  Effect.gen(function* () {
    // Yield-first captures the operations' services (Credentials/Region/
    // HttpClient) at layer init so the runtime callable is requirement-free.
    const executeScheduledQuery = yield* TSQ.executeScheduledQuery;
    const describeEndpoints = yield* TSQ.describeEndpoints;
    const withQueryEndpoint = withEndpoint(
      discover("query", describeEndpoints({})),
    );
    return Effect.fn(function* (scheduledQuery: ScheduledQuery) {
      const ScheduledQueryArn = yield* scheduledQuery.scheduledQueryArn;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          yield* host.bind`Allow(${host}, AWS.Timestream.ExecuteScheduledQuery(${scheduledQuery}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: ["timestream:ExecuteScheduledQuery"],
                  Resource: [
                    Output.interpolate`${scheduledQuery.scheduledQueryArn}`,
                  ],
                },
                // Endpoint discovery is required and is not scoped to a
                // resource.
                {
                  Effect: "Allow",
                  Action: ["timestream:DescribeEndpoints"],
                  Resource: ["*"],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(
        `AWS.Timestream.ExecuteScheduledQuery(${scheduledQuery.LogicalId})`,
      )(function* (request: ExecuteScheduledQueryRequest) {
        return yield* withQueryEndpoint(
          executeScheduledQuery({
            ...request,
            ScheduledQueryArn: yield* ScheduledQueryArn,
          }),
        );
      });
    });
  }),
);
