import { adopt } from "@/AdoptPolicy.ts";
import { Project } from "@/Neon/Project.ts";
import {
  ProjectVPCEndpoint,
  validateProjectVPCEndpoint,
} from "@/Neon/ProjectVPCEndpoint.ts";
import { providers } from "@/Neon/Providers.ts";
import * as Output from "@/Output.ts";
import * as Test from "@/Test/Alchemy";
import * as SDK from "@distilled.cloud/neon";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: providers() });
const endpoint = {
  orgId: "org-fixture",
  regionId: "aws-us-east-2",
  vpcEndpointId: "vpce-0123456789abcdef0",
};
const props = {
  project: { projectId: "fixture-project" },
  endpoint,
  label: "Fixture",
};
const context = {
  id: "Restriction",
  fqn: "Restriction",
  instanceId: "restriction-validation",
  oldBindings: [],
  newBindings: [],
};

test(
  "project VPC restriction requires a project and valid organization endpoint scope",
  Effect.gen(function* () {
    yield* validateProjectVPCEndpoint(props);
    expect(
      Result.isFailure(
        yield* validateProjectVPCEndpoint({
          ...props,
          project: { projectId: "" },
        }).pipe(Effect.result),
      ),
    ).toBe(true);
    expect(
      Result.isFailure(
        yield* validateProjectVPCEndpoint({
          ...props,
          endpoint: { ...endpoint, regionId: "azure-eastus2" },
        }).pipe(Effect.result),
      ),
    ).toBe(true);
  }),
  { tags: ["provider:neon", "provider:neon:projectvpcendpoint", "live"] },
);

test.provider(
  "project restriction replaces all changed or unresolved scopes with old-grant cleanup first",
  () =>
    Effect.gen(function* () {
      const provider = yield* ProjectVPCEndpoint.Provider;
      for (const patch of [
        { project: { projectId: "other-project" } },
        { project: { projectId: Output.literal("other-project") } },
        { endpoint: { ...endpoint, orgId: "org-other" } },
        { endpoint: { ...endpoint, regionId: "aws-us-west-2" } },
        { endpoint: { ...endpoint, vpcEndpointId: "vpce-abcdef01234567890" } },
        {
          endpoint: { ...endpoint, regionId: Output.literal("aws-us-west-2") },
        },
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
  { tags: ["provider:neon", "provider:neon:projectvpcendpoint", "live"] },
);

test.provider(
  "project restriction rejects a cached grant from another project before I/O",
  () =>
    Effect.gen(function* () {
      const provider = yield* ProjectVPCEndpoint.Provider;
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
            news: { ...props, project: { projectId: "other-project" } },
            output: {
              ...endpoint,
              projectId: props.project.projectId,
              label: props.label,
              initialLabel: props.label,
              managedLabel: props.label,
            },
          })
          .pipe(
            Effect.as(false),
            Effect.catchTag("InvalidProjectVPCEndpoint", () =>
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
  { tags: ["provider:neon", "provider:neon:projectvpcendpoint", "live"] },
);

const orgId = process.env.NEON_GOVERNANCE_TEST_ORG_ID;
const regionId = process.env.NEON_GOVERNANCE_TEST_VPC_ENDPOINT_REGION;
const vpcEndpointId = process.env.NEON_GOVERNANCE_TEST_VPC_ENDPOINT_ID;
const region = (
  [
    "aws-us-east-1",
    "aws-us-east-2",
    "aws-us-west-2",
    "aws-eu-central-1",
    "aws-eu-west-2",
    "aws-ap-southeast-1",
    "aws-ap-southeast-2",
    "aws-sa-east-1",
  ] as const
).find((value) => value === regionId);
const enabled =
  !!orgId &&
  !!region &&
  !!vpcEndpointId &&
  process.env.NEON_GOVERNANCE_TEST_NETWORK === "1" &&
  process.env.NEON_GOVERNANCE_TEST_VPC_UNREGISTER !== "1";

test.provider.skipIf(!enabled)(
  "dedicated network fixture cleans replaced project grants and preserves adopted restriction labels",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const scope = {
        orgId: orgId!,
        regionId: region!,
        vpcEndpointId: vpcEndpointId!,
      };
      const organizationRequest = {
        org_id: scope.orgId,
        region_id: scope.regionId,
        vpc_endpoint_id: scope.vpcEndpointId,
      };
      const organizationBaseline =
        yield* SDK.getOrganizationVPCEndpointDetails(organizationRequest);
      const base = Effect.gen(function* () {
        const a = yield* Project("PrivateProjectA", {
          orgId: scope.orgId,
          region: region!,
        });
        const b = yield* Project("PrivateProjectB", {
          orgId: scope.orgId,
          region: region!,
        });
        return { a, b };
      });
      const application = (
        second: boolean,
        label: string,
        takeOwnership = false,
      ) =>
        Effect.gen(function* () {
          const projects = yield* base;
          const restriction = yield* ProjectVPCEndpoint("Restriction", {
            project: second ? projects.b : projects.a,
            endpoint: scope,
            label,
          }).pipe(adopt(takeOwnership));
          return { ...projects, restriction };
        });
      const first = yield* stack.deploy(
        application(false, "Alchemy project fixture"),
      );
      const aRequest = {
        project_id: first.a.projectId,
        vpc_endpoint_id: scope.vpcEndpointId,
      };
      const bRequest = {
        project_id: first.b.projectId,
        vpc_endpoint_id: scope.vpcEndpointId,
      };
      expect(first.restriction.initialLabel).toBeNull();
      expect(
        (yield* SDK.listProjectVPCEndpoints(aRequest)).endpoints,
      ).toContainEqual({
        vpc_endpoint_id: scope.vpcEndpointId,
        label: "Alchemy project fixture",
      });
      yield* stack.deploy(application(false, "Alchemy project updated"));
      expect(
        (yield* SDK.listProjectVPCEndpoints(aRequest)).endpoints,
      ).toContainEqual({
        vpc_endpoint_id: scope.vpcEndpointId,
        label: "Alchemy project updated",
      });
      yield* stack.deploy(application(true, "Alchemy replacement fixture"));
      expect((yield* SDK.listProjectVPCEndpoints(aRequest)).endpoints).toEqual(
        [],
      );
      expect(
        (yield* SDK.listProjectVPCEndpoints(bRequest)).endpoints,
      ).toContainEqual({
        vpc_endpoint_id: scope.vpcEndpointId,
        label: "Alchemy replacement fixture",
      });
      yield* stack.deploy(base);
      expect((yield* SDK.listProjectVPCEndpoints(bRequest)).endpoints).toEqual(
        [],
      );

      yield* SDK.assignProjectVPCEndpoint({
        ...aRequest,
        label: "Original fixture restriction",
      });
      const baseline = (yield* SDK.listProjectVPCEndpoints(aRequest)).endpoints;
      expect(
        Result.isFailure(
          yield* stack
            .plan(application(false, "Adopted fixture"))
            .pipe(Effect.result),
        ),
      ).toBe(true);
      const adopted = yield* stack.deploy(
        application(false, "Adopted fixture", true),
      );
      expect(adopted.restriction.initialLabel).toBe(
        "Original fixture restriction",
      );
      yield* stack.deploy(application(false, "Updated adopted fixture"));
      yield* stack.deploy(base);
      expect((yield* SDK.listProjectVPCEndpoints(aRequest)).endpoints).toEqual(
        baseline,
      );
      expect(
        (yield* SDK.getOrganizationVPCEndpointDetails(organizationRequest))
          .label,
      ).toBe(organizationBaseline.label);
      yield* stack.destroy();
      for (const projectId of [first.a.projectId, first.b.projectId]) {
        expect(
          yield* SDK.getProject({ project_id: projectId }).pipe(
            Effect.as(false),
            Effect.catchTag("NotFound", () => Effect.succeed(true)),
          ),
        ).toBe(true);
      }
      yield* stack.destroy();
    }),
  {
    tags: [
      "provider:neon",
      "provider:neon:project",
      "provider:neon:projectvpcendpoint",
      "live",
    ],
    timeout: 120_000,
    exclusive: true,
  },
);
