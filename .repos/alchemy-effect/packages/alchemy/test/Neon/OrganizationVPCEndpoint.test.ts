import { adopt } from "@/AdoptPolicy.ts";
import {
  OrganizationVPCEndpoint,
  validateOrganizationVPCEndpoint,
} from "@/Neon/OrganizationVPCEndpoint.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Output from "@/Output.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: providers() });
const props = {
  orgId: "org-network-fixture",
  regionId: "aws-us-east-2",
  vpcEndpointId: "vpce-0123456789abcdef0",
  label: "Fixture",
};
const context = {
  id: "Network",
  fqn: "Network",
  instanceId: "network-validation",
  oldBindings: [],
  newBindings: [],
};

test(
  "organization registration validates AWS scope and endpoint identities",
  Effect.gen(function* () {
    yield* validateOrganizationVPCEndpoint(props);
    for (const patch of [
      { orgId: "" },
      { regionId: "azure-eastus2" },
      { vpcEndpointId: "vpc-0123456789abcdef0" },
      { label: " " },
    ]) {
      expect(
        Result.isFailure(
          yield* validateOrganizationVPCEndpoint({ ...props, ...patch }).pipe(
            Effect.result,
          ),
        ),
      ).toBe(true);
    }
  }),
  { tags: ["provider:neon", "provider:neon:organizationvpcendpoint", "live"] },
);

test.provider(
  "organization registration scope replacements delete the old scope first",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationVPCEndpoint.Provider;
      for (const patch of [
        { orgId: "org-other" },
        { regionId: "aws-us-west-2" },
        { vpcEndpointId: "vpce-abcdef01234567890" },
        { regionId: Output.literal("aws-us-west-2") },
      ]) {
        expect(
          yield* provider.diff!({
            ...context,
            olds: props,
            news: { ...props, ...patch },
            output: undefined,
          }),
        ).toEqual({ action: "replace", deleteFirst: true });
      }
      for (const news of [Output.literal(props), Effect.succeed(props)]) {
        expect(
          yield* provider.diff!({
            ...context,
            olds: props,
            news,
            output: undefined,
          }),
        ).toEqual({ action: "replace", deleteFirst: true });
      }
      expect(
        yield* provider.diff!({
          ...context,
          olds: props,
          news: { ...props, label: Output.literal("Updated") },
          output: undefined,
        }),
      ).toBeUndefined();
    }).pipe(
      Effect.provideService(
        SDK.Credentials,
        Effect.die("Unexpected Neon request in a no-I/O guard test"),
      ),
    ),
  { tags: ["provider:neon", "provider:neon:organizationvpcendpoint", "live"] },
);

test.provider(
  "organization registration rejects a cached endpoint from another region before I/O",
  () =>
    Effect.gen(function* () {
      const provider = yield* OrganizationVPCEndpoint.Provider;
      expect(
        yield* provider
          .reconcile({
            ...context,
            bindings: [],
            session: {
              emit: () => Effect.void,
              done: () => Effect.void,
              note: () => Effect.void,
            },
            olds: undefined,
            news: { ...props, regionId: "aws-us-west-2" },
            output: {
              ...props,
              initialLabel: props.label,
              managedLabel: props.label,
              state: "accepted",
            },
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidOrganizationVPCEndpoint", () =>
              Effect.succeed(true),
            ),
          ),
      ).toBe(true);
    }).pipe(
      Effect.provideService(
        SDK.Credentials,
        Effect.die("Unexpected Neon request in a no-I/O guard test"),
      ),
    ),
  { tags: ["provider:neon", "provider:neon:organizationvpcendpoint", "live"] },
);

const orgId = process.env.NEON_GOVERNANCE_TEST_ORG_ID;
const regionId = process.env.NEON_GOVERNANCE_TEST_VPC_ENDPOINT_REGION;
const vpcEndpointId = process.env.NEON_GOVERNANCE_TEST_VPC_ENDPOINT_ID;
const enabled =
  !!orgId &&
  !!regionId &&
  !!vpcEndpointId &&
  process.env.NEON_GOVERNANCE_TEST_NETWORK === "1";
const disposable = process.env.NEON_GOVERNANCE_TEST_VPC_UNREGISTER === "1";

// The ordinary fixture must already be registered; unregistering it is irreversible.
test.provider.skipIf(!enabled || disposable)(
  "dedicated existing organization registration requires adoption and restores its exact label",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const scope = {
        orgId: orgId!,
        regionId: regionId!,
        vpcEndpointId: vpcEndpointId!,
      };
      const request = {
        org_id: scope.orgId,
        region_id: scope.regionId,
        vpc_endpoint_id: scope.vpcEndpointId,
      };
      const baseline = yield* SDK.getOrganizationVPCEndpointDetails(request);
      const application = (label: string, takeOwnership = false) =>
        OrganizationVPCEndpoint("Network", { ...scope, label }).pipe(
          adopt(takeOwnership),
        );
      expect(
        Result.isFailure(
          yield* stack
            .plan(application("Alchemy governance fixture"))
            .pipe(Effect.result),
        ),
      ).toBe(true);
      const adopted = yield* stack.deploy(
        application("Alchemy governance fixture", true),
      );
      expect(adopted.initialLabel).toBe(baseline.label);
      expect(
        (yield* SDK.getOrganizationVPCEndpointDetails(request)).label,
      ).toBe("Alchemy governance fixture");
      yield* stack.deploy(application("Alchemy governance updated"));
      yield* SDK.assignOrganizationVPCEndpoint({
        ...request,
        label: "External fixture label",
      });
      expect(Result.isFailure(yield* stack.destroy().pipe(Effect.result))).toBe(
        true,
      );
      expect(
        (yield* SDK.getOrganizationVPCEndpointDetails(request)).label,
      ).toBe("External fixture label");
      yield* SDK.assignOrganizationVPCEndpoint({
        ...request,
        label: "Alchemy governance updated",
      });
      yield* stack.destroy();
      const restored = yield* SDK.getOrganizationVPCEndpointDetails(request);
      expect(restored.label).toBe(baseline.label);
      expect(restored.vpc_endpoint_id).toBe(baseline.vpc_endpoint_id);
      expect(restored.num_restricted_projects).toBe(
        baseline.num_restricted_projects,
      );
      yield* stack.destroy();
    }),
  {
    tags: ["provider:neon", "provider:neon:organizationvpcendpoint", "live"],
    timeout: 120_000,
    exclusive: true,
  },
);

test.provider.skipIf(!enabled || !disposable)(
  "explicit disposable endpoint registration is removed from Neon",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const scope = {
        orgId: orgId!,
        regionId: regionId!,
        vpcEndpointId: vpcEndpointId!,
      };
      const request = {
        org_id: scope.orgId,
        region_id: scope.regionId,
        vpc_endpoint_id: scope.vpcEndpointId,
      };
      const list = yield* SDK.listOrganizationVPCEndpoints(request);
      expect(
        list.endpoints.some(
          (endpoint) => endpoint.vpc_endpoint_id === scope.vpcEndpointId,
        ),
      ).toBe(false);
      const created = yield* stack.deploy(
        OrganizationVPCEndpoint("Network", {
          ...scope,
          label: "Alchemy disposable fixture",
        }),
      );
      expect(created.initialLabel).toBeNull();
      expect(
        (yield* SDK.getOrganizationVPCEndpointDetails(request)).label,
      ).toBe("Alchemy disposable fixture");
      yield* stack.destroy();
      expect(
        (yield* SDK.listOrganizationVPCEndpoints(request)).endpoints.some(
          (endpoint) => endpoint.vpc_endpoint_id === scope.vpcEndpointId,
        ),
      ).toBe(false);
      yield* stack.destroy();
    }),
  {
    tags: ["provider:neon", "provider:neon:organizationvpcendpoint", "live"],
    timeout: 120_000,
    exclusive: true,
  },
);
