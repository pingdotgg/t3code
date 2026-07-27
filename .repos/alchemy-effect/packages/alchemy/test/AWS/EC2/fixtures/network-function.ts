import * as EC2 from "@/AWS/EC2";
import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import path from "pathe";

const main = path.resolve(import.meta.dirname, "network-function.ts");

export class NetworkTestFunction extends Lambda.Function<Lambda.Function>()(
  "NetworkTestFunction",
) {}

/**
 * Runtime-safety regression fixture for the `EC2.Network` composite.
 *
 * The Lambda runtime re-executes this layer at function init, so `Network`
 * must not perform deploy-time-only work on the runtime path:
 *
 * - numeric `availabilityZones` triggers AZ auto-discovery via
 *   `ec2:DescribeAvailabilityZones` — the function role has no EC2
 *   permissions, so calling it at init fails with `UnauthorizedOperation`
 * - `gatewayEndpoints` needs the region, which must come from the `Region`
 *   service (provided by the runtime), not `AWSEnvironment` (deploy-only)
 *
 * A 200 from `/network` proves the composition INITs cleanly and that the
 * resources it yields resolve their attributes from the injected environment.
 */
export default NetworkTestFunction.make(
  {
    main,
    url: true,
  },
  Effect.gen(function* () {
    const network = yield* EC2.Network("Network", {
      cidrBlock: "10.77.0.0/16",
      // numeric — exercises the ec2:DescribeAvailabilityZones discovery path
      availabilityZones: 2,
      // exercises the region lookup for the endpoint service name
      gatewayEndpoints: ["s3"],
    });

    const VpcId = yield* network.vpcId;
    const SubnetId = yield* network.publicSubnetIds[0];

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.originalUrl);

        if (request.method === "GET" && url.pathname === "/network") {
          const vpcId = yield* VpcId;
          const subnetId = yield* SubnetId;
          return yield* HttpServerResponse.json({ vpcId, subnetId });
        }

        return HttpServerResponse.text("ok");
      }).pipe(Effect.orDie),
    };
  }),
);
