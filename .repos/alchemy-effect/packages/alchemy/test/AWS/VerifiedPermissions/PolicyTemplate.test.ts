import * as AWS from "@/AWS";
import { Policy, PolicyStore, PolicyTemplate } from "@/AWS/VerifiedPermissions";
import * as Test from "@/Test/Alchemy";
import * as avp from "@distilled.cloud/aws/verifiedpermissions";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

const unwrap = (v: string | Redacted.Redacted<string> | undefined) =>
  v === undefined ? undefined : Redacted.isRedacted(v) ? Redacted.value(v) : v;

const { test } = Test.make({ providers: AWS.providers() });

const findTemplate = (policyStoreId: string, policyTemplateId: string) =>
  avp
    .getPolicyTemplate({ policyStoreId, policyTemplateId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const findPolicy = (policyStoreId: string, policyId: string) =>
  avp
    .getPolicy({ policyStoreId, policyId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

const templateStatement = `permit(
  principal == ?principal,
  action == PhotoApp::Action::"viewPhoto",
  resource
);`;

test.provider(
  "policy template lifecycle: create template + template-linked policy, update description, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const makeStack = (description: string) =>
        Effect.gen(function* () {
          const store = yield* PolicyStore("Store", {
            validationMode: "OFF",
          });
          const template = yield* PolicyTemplate("ViewPhoto", {
            policyStoreId: store.policyStoreId,
            statement: templateStatement,
            description,
          });
          const linked = yield* Policy("AliceCanView", {
            policyStoreId: store.policyStoreId,
            templateId: template.policyTemplateId,
            principal: { entityType: "PhotoApp::User", entityId: "alice" },
          });
          return { store, template, linked };
        });

      // create
      const { store, template, linked } = yield* stack.deploy(
        makeStack("initial description"),
      );
      expect(template.policyTemplateId).toBeDefined();
      expect(linked.policyId).toBeDefined();

      // out-of-band verify
      const created = yield* findTemplate(
        store.policyStoreId,
        template.policyTemplateId,
      );
      expect(unwrap(created?.statement)).toContain("?principal");
      expect(unwrap(created?.description)).toBe("initial description");

      const createdLinked = yield* findPolicy(
        store.policyStoreId,
        linked.policyId,
      );
      expect(createdLinked?.policyType).toBe("TEMPLATE_LINKED");

      // update the template description in place (ids are stable)
      const updated = yield* stack.deploy(makeStack("updated description"));
      expect(updated.template.policyTemplateId).toBe(template.policyTemplateId);
      expect(updated.linked.policyId).toBe(linked.policyId);

      const afterUpdate = yield* findTemplate(
        store.policyStoreId,
        template.policyTemplateId,
      );
      expect(unwrap(afterUpdate?.description)).toBe("updated description");

      // destroy — linked policy must delete before the template
      yield* stack.destroy();
      const goneTemplate = yield* findTemplate(
        store.policyStoreId,
        template.policyTemplateId,
      );
      expect(goneTemplate).toBeUndefined();
    }),
  { timeout: 180_000 },
);
