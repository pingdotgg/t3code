import * as AWS from "@/AWS";
import {
  Policy,
  PolicyAttachment,
  Root,
  RootPolicyType,
} from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as organizations from "@distilled.cloud/aws/organizations";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// `list()` enumerates every (policyId, targetId) attachment by fanning out over
// all policy types (listPolicies per type) and listing each policy's targets
// (listTargetsForPolicy per policy). This runs read-only: when the testing
// account isn't an org management account / delegated administrator, the typed
// AccessDeniedException / AWSOrganizationsNotInUseException catches degrade the
// result to [], so the assertion holds without deploying anything.
test.provider("list enumerates policy attachments", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(PolicyAttachment);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    for (const attachment of all) {
      expect(typeof attachment.policyId).toBe("string");
      expect(typeof attachment.targetId).toBe("string");
    }
  }),
);

// Regression test for https://github.com/alchemy-run/alchemy/issues/736.
//
// An interrupted first deploy persists the attachment as `status: "creating"`
// with no attributes — and the Output-valued props (`policyId` from the Policy
// resource, `targetId` from the RootPolicyType resource) do not survive the
// state round-trip: they deserialize as `undefined`. Plan's creating-recovery
// branch then calls `provider.read` with those junk props, which crashed in
// `listTargetsForPolicy({ PolicyId: undefined })` and wedged the stack.
//
// Simulate exactly that state row after a real deploy and assert the next
// deploy recovers: `read` reports "not found", the engine re-drives the
// create, and reconcile observes the existing attachment before attaching —
// SAME (policyId, targetId) identity, no duplicate attachment.
//
// Requires an org MANAGEMENT account (enablePolicyType / createPolicy /
// attachPolicy all reject off one), so gate behind the same env var the other
// Organizations lifecycle tests use.
test.provider.skipIf(!process.env.AWS_ORG_MANAGEMENT_ACCOUNT)(
  "recovers a half-created attachment whose creating-state lost Output-valued props (#736)",
  (stack) =>
    Effect.gen(function* () {
      const policyName = "alchemy-test-736-attachment";

      // A prior interrupted run may have left an (untagged, hence unowned)
      // SCP with our deterministic name behind — the adoption probe would
      // then fail the create with `OwnedBySomeoneElse`. Clean it up
      // out-of-band before deploying, and again on scope close.
      const cleanLeftoverPolicies = Effect.gen(function* () {
        const policies = yield* organizations.listPolicies({
          Filter: "SERVICE_CONTROL_POLICY",
        });
        const leftovers = (policies.Policies ?? []).filter(
          (policy): policy is organizations.PolicySummary & { Id: string } =>
            policy.Name === policyName && policy.Id != null,
        );
        for (const leftover of leftovers) {
          const targets = yield* organizations
            .listTargetsForPolicy({ PolicyId: leftover.Id })
            .pipe(
              Effect.catchTag("PolicyNotFoundException", () =>
                Effect.succeed({ Targets: [] }),
              ),
            );
          for (const target of targets.Targets ?? []) {
            if (target.TargetId == null) continue;
            yield* organizations
              .detachPolicy({
                PolicyId: leftover.Id,
                TargetId: target.TargetId,
              })
              .pipe(
                Effect.catchTag(
                  [
                    "PolicyNotAttachedException",
                    "PolicyNotFoundException",
                    "TargetNotFoundException",
                  ],
                  () => Effect.void,
                ),
              );
          }
          // The detach above can lag — retry the delete through the typed
          // `PolicyInUseException` (bounded), and tolerate already-gone.
          yield* organizations.deletePolicy({ PolicyId: leftover.Id }).pipe(
            Effect.retry({
              while: (error) => error._tag === "PolicyInUseException",
              schedule: Schedule.spaced("3 seconds"),
              times: 8,
            }),
            Effect.catchTag("PolicyNotFoundException", () => Effect.void),
          );
        }
      });
      yield* cleanLeftoverPolicies;
      yield* Effect.addFinalizer(() =>
        cleanLeftoverPolicies.pipe(Effect.ignore),
      );

      yield* stack.destroy();

      const deployStack = (includeAttachment: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            // Import-style resource — adopts the single organization root.
            const root = yield* Root("WedgedRoot", {});
            const scpType = yield* RootPolicyType("WedgedScpType", {
              rootId: root.rootId,
              policyType: "SERVICE_CONTROL_POLICY",
            });
            // Allow-all SCP — attaching it alongside the AWS-managed
            // FullAWSAccess policy changes nothing about effective access.
            const policy = yield* Policy("WedgedScp", {
              name: policyName,
              type: "SERVICE_CONTROL_POLICY",
              document: {
                Version: "2012-10-17",
                Statement: [{ Effect: "Allow", Action: ["*"], Resource: "*" }],
              },
            });
            if (!includeAttachment) {
              return undefined;
            }
            return yield* PolicyAttachment("WedgedAttachment", {
              // Both identity props are Output-valued — the #736 shape.
              policyId: policy.policyId,
              // Thread the RootPolicyType's output so the attachment plans
              // after SERVICE_CONTROL_POLICY is enabled on the root.
              targetId: scpType.rootId,
            });
          }),
        );

      // Stage 1: enable the policy type + create the SCP, WITHOUT the
      // attachment. `enablePolicyType` completes asynchronously
      // (PENDING_ENABLE), and `attachPolicy` rejects with the typed
      // `PolicyTypeNotEnabledException` until it lands — so wait (bounded)
      // for ENABLED before deploying the attachment.
      yield* deployStack(false);
      yield* organizations.listRoots({}).pipe(
        Effect.map((page) =>
          (page.Roots ?? []).some((root) =>
            (root.PolicyTypes ?? []).some(
              (summary) =>
                summary.Type === "SERVICE_CONTROL_POLICY" &&
                summary.Status === "ENABLED",
            ),
          ),
        ),
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (enabled) => enabled,
          times: 10,
        }),
      );

      // Stage 2: deploy the attachment itself.
      const created = yield* deployStack(true);
      if (created === undefined) {
        return yield* Effect.die(
          new Error("stage-2 deploy returned no attachment"),
        );
      }

      // Rewrite the attachment's persisted row into the wedged shape an
      // interrupted deploy leaves behind: `creating`, no attributes, and
      // every Output-valued prop lost in the round-trip.
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const wedged = rows.find(
        (r): r is { fqn: string; row: ResourceState } =>
          isResourceState(r.row) &&
          r.row.resourceType === "AWS.Organizations.PolicyAttachment",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error(
            "no AWS.Organizations.PolicyAttachment state row found after deploy",
          ),
        );
      }
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: wedged.fqn,
        value: {
          ...wedged.row,
          status: "creating",
          attr: undefined,
          props: {
            ...wedged.row.props,
            policyId: undefined,
            targetId: undefined,
          },
        },
      });

      // Before the fix this failed in plan: `read` called
      // `listTargetsForPolicy({ PolicyId: undefined })` with the junk olds.
      const recovered = yield* deployStack(true);
      expect(recovered?.policyId).toEqual(created.policyId);
      expect(recovered?.targetId).toEqual(created.targetId);

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
