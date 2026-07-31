import * as EC2 from "@/AWS/EC2";
import * as GlobalAccelerator from "@/AWS/GlobalAccelerator";
import * as Lambda from "@/AWS/Lambda";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "handler.ts");

export class GaTestFunction extends Lambda.Function<Lambda.Function>()(
  "GaTestFunction",
) {}

// Global Accelerator serializes config changes per accelerator; a mutation
// racing an in-flight transaction is rejected with
// TransactionInProgressException. Retry briefly inside the Lambda (bounded
// well under the function timeout).
const retryGaTransaction = <A, E extends { _tag: string }, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(self, {
    while: (e): boolean =>
      e._tag === "TransactionInProgressException" ||
      e._tag === "ConflictException",
    schedule: Schedule.max([Schedule.fixed("3 seconds"), Schedule.recurs(10)]),
  });

export default GaTestFunction.make(
  {
    main,
    url: true,
    timeout: Duration.seconds(60),
  },
  Effect.gen(function* () {
    // The accelerator/listener/endpoint group the bindings are bound to. The
    // endpoint group starts empty; the Add/RemoveEndpoints bindings register
    // and deregister the Elastic IP below at runtime.
    const accelerator = yield* GlobalAccelerator.Accelerator(
      "BindingAccelerator",
      {},
    );
    const listener = yield* GlobalAccelerator.Listener("BindingListener", {
      acceleratorArn: accelerator.acceleratorArn,
      portRanges: [{ fromPort: 80, toPort: 80 }],
      protocol: "TCP",
    });
    const group = yield* GlobalAccelerator.EndpointGroup("BindingGroup", {
      listenerArn: listener.listenerArn,
      endpointGroupRegion: "us-west-2",
    });
    // An Elastic IP is the cheapest endpoint type Global Accelerator accepts
    // (no instance/load balancer required).
    const eip = yield* EC2.EIP("BindingEip", {});
    const AllocationId = yield* eip.allocationId;

    const describeAccelerator =
      yield* GlobalAccelerator.DescribeAccelerator(accelerator);
    const describeEndpointGroup =
      yield* GlobalAccelerator.DescribeEndpointGroup(group);
    const addEndpoints = yield* GlobalAccelerator.AddEndpoints(group);
    const removeEndpoints = yield* GlobalAccelerator.RemoveEndpoints(group);

    const bound = {
      describeAccelerator,
      describeEndpointGroup,
      addEndpoints,
      removeEndpoints,
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

        // The Elastic IP the test uses to drive Add/RemoveEndpoints.
        if (request.method === "GET" && pathname === "/context") {
          const allocationId = yield* AllocationId;
          return yield* HttpServerResponse.json({ allocationId });
        }

        // Accelerator-scoped read: the ARN is injected from the binding.
        if (request.method === "GET" && pathname === "/accelerator") {
          const { Accelerator } = yield* describeAccelerator();
          return yield* HttpServerResponse.json({
            name: Accelerator?.Name,
            status: Accelerator?.Status,
            dnsName: Accelerator?.DnsName,
            enabled: Accelerator?.Enabled,
          });
        }

        // Endpoint-group-scoped read: per-endpoint health.
        if (request.method === "GET" && pathname === "/group") {
          const { EndpointGroup } = yield* describeEndpointGroup({});
          return yield* HttpServerResponse.json({
            region: EndpointGroup?.EndpointGroupRegion,
            endpoints: (EndpointGroup?.EndpointDescriptions ?? []).map(
              (endpoint) => ({
                endpointId: endpoint.EndpointId,
                healthState: endpoint.HealthState,
              }),
            ),
          });
        }

        // Register the Elastic IP as an endpoint at runtime. Failures are
        // surfaced as a 400 JSON body (with the typed tag) so the test fails
        // fast and diagnostically instead of retrying an opaque 5xx.
        if (request.method === "POST" && pathname === "/endpoints/add") {
          const allocationId = yield* AllocationId;
          const added = yield* Effect.result(
            retryGaTransaction(
              addEndpoints({
                EndpointConfigurations: [
                  { EndpointId: allocationId, Weight: 64 },
                ],
              }),
            ),
          );
          if (Result.isFailure(added)) {
            return yield* HttpServerResponse.json(
              { error: "addEndpoints", failure: JSON.stringify(added.failure) },
              { status: 400 },
            );
          }
          return yield* HttpServerResponse.json({
            added: (added.success.EndpointDescriptions ?? []).map(
              (endpoint) => endpoint.EndpointId,
            ),
          });
        }

        // Deregister the Elastic IP endpoint.
        if (request.method === "POST" && pathname === "/endpoints/remove") {
          const allocationId = yield* AllocationId;
          const removed = yield* Effect.result(
            retryGaTransaction(
              removeEndpoints({
                EndpointIdentifiers: [{ EndpointId: allocationId }],
              }),
            ),
          );
          if (Result.isFailure(removed)) {
            return yield* HttpServerResponse.json(
              {
                error: "removeEndpoints",
                failure: JSON.stringify(removed.failure),
              },
              { status: 400 },
            );
          }
          return yield* HttpServerResponse.json({ removed: allocationId });
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
        GlobalAccelerator.DescribeAcceleratorHttp,
        GlobalAccelerator.DescribeEndpointGroupHttp,
        GlobalAccelerator.AddEndpointsHttp,
        GlobalAccelerator.RemoveEndpointsHttp,
      ),
    ),
  ),
);
