import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Tracer from "effect/Tracer";

import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as Observability from "./observability.ts";

it.effect("adds schema error fields to spans on the current tracer", () =>
  Effect.gen(function* () {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });

    yield* Effect.fail(
      new EnvironmentConnector.EnvironmentConnectNotAuthorized({
        environmentId: "environment-1",
        operation: "connect",
        reason: "managed_endpoint_allocation_not_ready",
      }),
    ).pipe(
      Effect.withSpan("relay.test.schema_error"),
      Effect.exit,
      Observability.withSchemaErrorSpanAttributes,
      Effect.withTracer(tracer),
    );

    expect(spans.map((span) => span.name)).toEqual(["relay.test.schema_error"]);
    expect(Object.fromEntries(spans[0]!.attributes)).toMatchObject({
      "error.type": "EnvironmentConnectNotAuthorized",
      "error.environmentId": "environment-1",
      "error.operation": "connect",
      "error.reason": "managed_endpoint_allocation_not_ready",
    });
  }),
);
