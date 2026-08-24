import * as AWS from "@/AWS";
import { Root, RootPolicyType } from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// A RootPolicyType is the enable/disable state of a policy type on an org root.
// `list()` enumerates roots via `listRoots` and emits one Attributes per
// (rootId, policyType). It runs read-only: outside an org management account
// `listRoots` rejects with a typed error that degrades to [], so the assertion
// holds without deploying anything.
test.provider("list enumerates root policy types", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(RootPolicyType);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    for (const item of all) {
      expect(typeof item.rootId).toBe("string");
      expect(item.rootId.length).toBeGreaterThan(0);
      expect(typeof item.policyType).toBe("string");
      if (item.rootArn !== undefined) {
        expect(typeof item.rootArn).toBe("string");
      }
      if (item.status !== undefined) {
        expect(typeof item.status).toBe("string");
      }
    }
  }),
);

// Regression test for https://github.com/alchemy-run/alchemy/issues/736.
//
// An interrupted first deploy persists the enablement as `status: "creating"`
// with no attributes — and props that could not round-trip (the `rootId` is
// Output-valued, coming from the `Root` resource). Plan's creating-recovery
// branch then calls `provider.read` with those junk olds; pre-fix the
// `olds!.rootId` dereference crashed the plan when the persisted row carried
// no recoverable props at all (`BaseResourceState` declares `props?:` — a row
// whose Output-valued props failed to round-trip can surface with none).
//
// Simulate exactly that state row after a real deploy and assert the next
// deploy recovers: `read` reports "not found", the engine re-drives the
// create, and reconcile observes the policy type already enabled on the root
// — SAME rootId, no duplicate enablement.
//
// Requires an org MANAGEMENT account (`enablePolicyType` rejects off one), so
// gate behind the same env var the other Organizations lifecycle tests use.
test.provider.skipIf(!process.env.AWS_ORG_MANAGEMENT_ACCOUNT)(
  "recovers a half-created root policy type whose creating-state lost its props (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployPolicyType = () =>
        stack.deploy(
          Effect.gen(function* () {
            // Import-style resource — adopts the single organization root,
            // so `rootId` below is genuinely Output-valued (the #736 shape).
            const root = yield* Root("WedgedRoot", {});
            return yield* RootPolicyType("WedgedBackupType", {
              rootId: root.rootId,
              policyType: "BACKUP_POLICY",
            });
          }),
        );

      const created = yield* deployPolicyType();

      // Rewrite the enablement's persisted row into the wedged shape an
      // interrupted deploy leaves behind: `creating`, no attributes, and no
      // recoverable props (the realistic field-level loss — `rootId:
      // undefined` — is tolerated even pre-fix because `readRootPolicyType`
      // is list-and-find; the crash this fix guards is the `olds!` deref on
      // a row with no props at all).
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
          r.row.resourceType === "AWS.Organizations.RootPolicyType",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error(
            "no AWS.Organizations.RootPolicyType state row found after deploy",
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
          props: undefined,
          // `CreatingResourceState` requires `props`, but persisted rows may
          // lack it (`BaseResourceState.props?:`) — simulate that corruption.
        } as unknown as ResourceState,
      });

      // Before the fix this crashed in plan with
      // `TypeError: undefined is not an object (evaluating 'olds.rootId')`.
      const recovered = yield* deployPolicyType();
      expect(recovered.rootId).toEqual(created.rootId);
      expect(recovered.policyType).toEqual("BACKUP_POLICY");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
