import type { SecurityGroupId } from "@alchemy.run/aws/EC2/SecurityGroup";
import type { SubnetId } from "@alchemy.run/aws/EC2/Subnet";
import type { VpcId } from "@alchemy.run/aws/EC2/Vpc";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

// Lightweight half of ProvisionedFixture.ts: the shared-network handle that
// Lambda fixtures read from their init effect. It must NOT import the test
// harness (`@alchemy.run/test/Core`) — anything imported here is bundled into the
// fixture Lambda, and the harness drags in the bundler and engine (a ~19 MB
// bundle that OOMs a 256 MB Lambda at cold start, surfacing as a 502).

export interface ProvisionedNetwork {
  vpcId: VpcId;
  subnetIds: SubnetId[];
  securityGroupId: SecurityGroupId;
  subnetGroupName: string;
}

/** Process-wide state, mutated by ProvisionedFixture.ts in the test process. */
export const networkState = {
  ready: Deferred.makeUnsafe<ProvisionedNetwork, unknown>(),
  started: false,
};

/**
 * Resolved IDs of the process-wide provisioned-cache VPC.
 *
 * Inside a deployed Lambda fixture the init effect re-runs, but the shared
 * network is test-process state that never exists there — and resource
 * declarations ignore their props at runtime anyway. Hand back inert
 * placeholders so the fixture's cold start does not die.
 */
export const getProvisionedNetwork = Effect.suspend(() =>
  globalThis.__ALCHEMY_RUNTIME__
    ? Effect.succeed({
        vpcId: "",
        subnetIds: [],
        securityGroupId: "",
        subnetGroupName: "",
      } as unknown as ProvisionedNetwork)
    : networkState.started
      ? Deferred.await(networkState.ready).pipe(Effect.orDie)
      : Effect.die(
          "provisioned network was not acquired; call shareProvisionedNetwork in the test file",
        ),
);
