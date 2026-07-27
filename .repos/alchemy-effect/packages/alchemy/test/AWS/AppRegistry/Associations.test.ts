import * as AWS from "@/AWS";
import {
  Application,
  AttributeGroup,
  AttributeGroupAssociation,
  ResourceAssociation,
} from "@/AWS/AppRegistry";
import { Stack } from "@/AWS/CloudFormation";
import * as Test from "@/Test/Alchemy";
import * as appregistry from "@distilled.cloud/aws/service-catalog-appregistry";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { makeAppRegistryTestLease } from "./TestLease.ts";

const { test, beforeAll, afterAll } = Test.make({ providers: AWS.providers() });
const serviceLease = makeAppRegistryTestLease();

beforeAll(serviceLease.acquire, { timeout: 3_600_000 });
afterAll(serviceLease.release);

class ApplicationStillExists extends Data.TaggedError(
  "ApplicationStillExists",
)<{ specifier: string }> {}

const assertApplicationGone = (specifier: string) =>
  appregistry.getApplication({ application: specifier }).pipe(
    Effect.flatMap(() =>
      Effect.fail(new ApplicationStillExists({ specifier })),
    ),
    Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "ApplicationStillExists",
      schedule: Schedule.max([
        Schedule.fixed("2 seconds"),
        Schedule.recurs(10),
      ]),
    }),
  );

const listAssociatedGroupIds = (application: string) =>
  appregistry.listAssociatedAttributeGroups.pages({ application }).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) => page.attributeGroups ?? []),
    ),
  );

// A free, instantly-creatable no-op stack to associate with the application.
const NOOP_TEMPLATE = JSON.stringify({
  Resources: {
    Noop: { Type: "AWS::CloudFormation::WaitConditionHandle" },
  },
});

test.provider(
  "associates an attribute group and a CloudFormation stack with an application",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Application("AssocApp", {
            description: "association lifecycle test",
          });
          const group = yield* AttributeGroup("AssocGroup", {
            attributes: { owner: "alchemy-test" },
          });
          const cfn = yield* Stack("AssocStack", {
            templateBody: NOOP_TEMPLATE,
          });
          const groupAssociation = yield* AttributeGroupAssociation(
            "GroupAssoc",
            {
              application: app.applicationId,
              attributeGroup: group.attributeGroupId,
            },
          );
          const resourceAssociation = yield* ResourceAssociation("StackAssoc", {
            application: app.applicationId,
            resourceType: "CFN_STACK",
            resource: cfn.stackName,
            // Skip the awsApplication tag so association does not round-trip
            // a CloudFormation stack update.
            options: ["SKIP_APPLICATION_TAG"],
          });
          return {
            applicationId: app.applicationId,
            attributeGroupId: group.attributeGroupId,
            stackName: cfn.stackName,
            associatedGroupId: groupAssociation.attributeGroupId,
            associatedResourceArn: resourceAssociation.resourceArn,
          };
        }),
      );

      expect(created.associatedGroupId).toBe(created.attributeGroupId);
      expect(created.associatedResourceArn).toContain(":cloudformation:");

      // out-of-band verify via distilled
      const groupIds = yield* listAssociatedGroupIds(created.applicationId);
      expect(groupIds).toContain(created.attributeGroupId);
      const associated = yield* appregistry.getAssociatedResource({
        application: created.applicationId,
        resourceType: "CFN_STACK",
        resource: created.stackName,
      });
      expect(associated.resource?.name).toBe(created.stackName);

      // idempotent re-deploy converges without error
      yield* stack.deploy(
        Effect.gen(function* () {
          const app = yield* Application("AssocApp", {
            description: "association lifecycle test",
          });
          const group = yield* AttributeGroup("AssocGroup", {
            attributes: { owner: "alchemy-test" },
          });
          const cfn = yield* Stack("AssocStack", {
            templateBody: NOOP_TEMPLATE,
          });
          yield* AttributeGroupAssociation("GroupAssoc", {
            application: app.applicationId,
            attributeGroup: group.attributeGroupId,
          });
          yield* ResourceAssociation("StackAssoc", {
            application: app.applicationId,
            resourceType: "CFN_STACK",
            resource: cfn.stackName,
            options: ["SKIP_APPLICATION_TAG"],
          });
        }),
      );

      // destroy disassociates before deleting the application (AppRegistry
      // rejects deleting an application with live associations).
      yield* stack.destroy();
      yield* assertApplicationGone(created.applicationId);
    }),
  { timeout: 300_000 },
);
