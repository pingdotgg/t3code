import * as AWS from "@/AWS";
import { Subnet, Vpc } from "@/AWS/EC2";
import {
  Listener,
  Rule,
  Service,
  ServiceNetwork,
  ServiceNetworkServiceAssociation,
  TargetGroup,
} from "@/AWS/VpcLattice";
import * as Test from "@/Test/Alchemy";
import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

class StillExists extends Data.TaggedError("StillExists")<{
  readonly id: string;
}> {}

const assertTargetGroupDeleted = (id: string) =>
  vpclattice.getTargetGroup({ targetGroupIdentifier: id }).pipe(
    Effect.flatMap(() => Effect.fail(new StillExists({ id }))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e): boolean => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

const assertServiceDeleted = (id: string) =>
  vpclattice.getService({ serviceIdentifier: id }).pipe(
    Effect.flatMap(() => Effect.fail(new StillExists({ id }))),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e): boolean => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

test.provider(
  "service chain: target group, listener, rule, service association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (options: {
        defaultStatusCode: number;
        rulePriority: number;
        targetIp: string;
        healthCheckEnabled: boolean;
      }) =>
        Effect.gen(function* () {
          const vpc = yield* Vpc("ChainVpc", { cidrBlock: "10.31.0.0/16" });
          // IP targets must fall inside a subnet of the VPC.
          const subnet = yield* Subnet("ChainSubnet", {
            vpcId: vpc.vpcId,
            cidrBlock: "10.31.0.0/24",
          });
          const network = yield* ServiceNetwork("ChainNetwork", {});
          const service = yield* Service("ChainService", {});
          const association = yield* ServiceNetworkServiceAssociation(
            "ChainAssociation",
            {
              serviceNetworkIdentifier: network.serviceNetworkId,
              serviceIdentifier: service.serviceId,
            },
          );
          const targetGroup = yield* TargetGroup("ChainTargets", {
            type: "IP",
            port: 80,
            protocol: "HTTP",
            // Reference the VPC through the subnet so target registration
            // (which requires a subnet covering the target IP) is ordered
            // after the subnet exists.
            vpcIdentifier: subnet.vpcId,
            healthCheck: {
              enabled: options.healthCheckEnabled,
              protocol: "HTTP",
              path: "/health",
              healthCheckInterval: "30 seconds",
              healthCheckTimeout: "5 seconds",
            },
            targets: [{ id: options.targetIp, port: 80 }],
          });
          const listener = yield* Listener("ChainListener", {
            serviceIdentifier: service.serviceId,
            protocol: "HTTP",
            port: 80,
            defaultAction: {
              fixedResponse: { statusCode: options.defaultStatusCode },
            },
          });
          const rule = yield* Rule("ChainRule", {
            serviceIdentifier: service.serviceId,
            listenerIdentifier: listener.listenerId,
            priority: options.rulePriority,
            match: {
              httpMatch: { pathMatch: { match: { prefix: "/api" } } },
            },
            action: {
              forward: {
                targetGroups: [
                  {
                    targetGroupIdentifier: targetGroup.targetGroupId,
                    weight: 100,
                  },
                ],
              },
            },
          });
          return { association, listener, network, rule, service, targetGroup };
        });

      const first = yield* stack.deploy(
        program({
          defaultStatusCode: 404,
          rulePriority: 10,
          targetIp: "10.31.0.10",
          healthCheckEnabled: false,
        }),
      );

      expect(first.targetGroup.targetGroupId).toMatch(/^tg-/);
      expect(first.targetGroup.type).toBe("IP");
      expect(first.listener.listenerId).toMatch(/^listener-/);
      expect(first.rule.ruleId).toMatch(/^rule-/);
      expect(first.association.associationId).toMatch(/^snsa-/);

      // Live listener has the fixed default action.
      const liveListener = yield* vpclattice.getListener({
        serviceIdentifier: first.service.serviceId,
        listenerIdentifier: first.listener.listenerId,
      });
      expect(liveListener.defaultAction).toEqual({
        fixedResponse: { statusCode: 404 },
      });

      // Live rule forwards /api to the target group at priority 10.
      const liveRule = yield* vpclattice.getRule({
        serviceIdentifier: first.service.serviceId,
        listenerIdentifier: first.listener.listenerId,
        ruleIdentifier: first.rule.ruleId,
      });
      expect(liveRule.priority).toBe(10);
      expect(liveRule.action).toEqual({
        forward: {
          targetGroups: [
            {
              targetGroupIdentifier: first.targetGroup.targetGroupId,
              weight: 100,
            },
          ],
        },
      });

      // The IP target is registered.
      const liveTargets = yield* vpclattice.listTargets({
        targetGroupIdentifier: first.targetGroup.targetGroupId,
      });
      expect(liveTargets.items.map((t) => t.id)).toEqual(["10.31.0.10"]);

      // The service is associated with the network.
      const liveAssociation =
        yield* vpclattice.getServiceNetworkServiceAssociation({
          serviceNetworkServiceAssociationIdentifier:
            first.association.associationId,
        });
      expect(liveAssociation.serviceId).toBe(first.service.serviceId);
      expect(["ACTIVE", "CREATE_IN_PROGRESS"]).toContain(
        liveAssociation.status,
      );

      // Update in place: default action, rule priority, health check, target.
      const second = yield* stack.deploy(
        program({
          defaultStatusCode: 500,
          rulePriority: 20,
          targetIp: "10.31.0.11",
          healthCheckEnabled: true,
        }),
      );
      expect(second.listener.listenerId).toBe(first.listener.listenerId);
      expect(second.rule.ruleId).toBe(first.rule.ruleId);
      expect(second.targetGroup.targetGroupId).toBe(
        first.targetGroup.targetGroupId,
      );
      expect(second.association.associationId).toBe(
        first.association.associationId,
      );

      const updatedListener = yield* vpclattice.getListener({
        serviceIdentifier: first.service.serviceId,
        listenerIdentifier: first.listener.listenerId,
      });
      expect(updatedListener.defaultAction).toEqual({
        fixedResponse: { statusCode: 500 },
      });

      const updatedRule = yield* vpclattice.getRule({
        serviceIdentifier: first.service.serviceId,
        listenerIdentifier: first.listener.listenerId,
        ruleIdentifier: first.rule.ruleId,
      });
      expect(updatedRule.priority).toBe(20);

      const updatedGroup = yield* vpclattice.getTargetGroup({
        targetGroupIdentifier: first.targetGroup.targetGroupId,
      });
      expect(updatedGroup.config?.healthCheck?.enabled).toBe(true);
      expect(updatedGroup.config?.healthCheck?.path).toBe("/health");
      expect(updatedGroup.config?.healthCheck?.healthCheckIntervalSeconds).toBe(
        30,
      );

      const updatedTargets = yield* vpclattice.listTargets({
        targetGroupIdentifier: first.targetGroup.targetGroupId,
      });
      expect(
        updatedTargets.items
          .filter((t) => t.status !== "DRAINING")
          .map((t) => t.id),
      ).toEqual(["10.31.0.11"]);

      yield* stack.destroy();
      yield* assertTargetGroupDeleted(first.targetGroup.targetGroupId);
      yield* assertServiceDeleted(first.service.serviceId);
    }).pipe(
      // A mid-test failure must not orphan the VPC (default quota is 5 per
      // region) — always tear the stack down.
      Effect.ensuring(Effect.ignore(stack.destroy())),
    ),
  { timeout: 600_000 },
);
