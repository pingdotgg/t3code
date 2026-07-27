import * as AWS from "@/AWS";
import { DelegatedAdministrator } from "@/AWS/Organizations";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Read-only `list()` test (AWS account/region-scoped collection with a
// per-account service fan-out). Resolve the provider from context via the
// typed `Provider.findProvider`, call `list()`, and assert the result is a
// well-typed `Attributes[]`.
//
// `list()` is designed to degrade gracefully off the org management account:
// `listDelegatedAdministrators` rejects with `AWSOrganizationsNotInUseException`
// / `AccessDeniedException` / `UnsupportedAPIEndpointException` when the caller
// isn't an org management/delegated account, which `list()` catches and maps to
// `[]`. So this case passes on any account — it just returns `[]` when the
// account can't enumerate delegated administrators.
test.provider("list enumerates delegated administrators", () =>
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(DelegatedAdministrator);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);

    for (const item of all) {
      expect(typeof item.accountId).toBe("string");
      expect(typeof item.servicePrincipal).toBe("string");
    }
  }),
);

// Full lifecycle list test — requires an org MANAGEMENT account plus a member
// account to register as a delegated administrator. Gate behind env vars so an
// entitled account runs it unchanged. Off a management account
// `registerDelegatedAdministrator` rejects with
// `AWSOrganizationsNotInUseException` / `AccessDeniedException`, so this is
// skipped by default.
const memberAccountId = process.env.AWS_ORG_DELEGATED_ADMIN_ACCOUNT_ID;
const servicePrincipal =
  process.env.AWS_ORG_DELEGATED_ADMIN_SERVICE_PRINCIPAL ??
  "config.amazonaws.com";

test.provider.skipIf(!memberAccountId)(
  "list contains the deployed delegated administrator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const admin = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* DelegatedAdministrator("ListDelegatedAdmin", {
            accountId: memberAccountId!,
            servicePrincipal,
          });
        }),
      );

      const provider = yield* Provider.findProvider(DelegatedAdministrator);
      const all = yield* provider.list();

      expect(
        all.some(
          (item) =>
            item.accountId === admin.accountId &&
            item.servicePrincipal === admin.servicePrincipal,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
);

// Regression test for https://github.com/alchemy-run/alchemy/issues/736.
//
// An interrupted first deploy persists the registration as
// `status: "creating"` with no attributes — and the Output-valued props
// (`accountId` typically comes from an `Account` resource) do not survive
// the state round-trip: they deserialize as `undefined`. Plan's
// creating-recovery branch then calls `provider.read` with those junk olds,
// which pre-fix crashed in
// `listDelegatedServicesForAccount({ AccountId: undefined })`
// (`ParseError: Expected string, got undefined`) and wedged the stack.
//
// Simulate exactly that state row after a real deploy and assert the next
// deploy recovers: `read` reports "not found", the engine re-drives the
// create, and reconcile observes the existing registration before
// registering — SAME (accountId, servicePrincipal) identity, no duplicate.
//
// Same gating as the lifecycle test above: requires an org MANAGEMENT
// account plus a member account to register (a management account cannot
// delegate itself — `ConstraintViolationException`), so this is skipped
// unless AWS_ORG_DELEGATED_ADMIN_ACCOUNT_ID is set.
test.provider.skipIf(!memberAccountId)(
  "recovers a half-created delegated administrator whose creating-state lost Output-valued props (#736)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployAdmin = () =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* DelegatedAdministrator("WedgedDelegatedAdmin", {
              accountId: memberAccountId!,
              servicePrincipal,
            });
          }),
        );

      const created = yield* deployAdmin();

      // Rewrite the registration's persisted row into the wedged shape an
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
          r.row.resourceType === "AWS.Organizations.DelegatedAdministrator",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error(
            "no AWS.Organizations.DelegatedAdministrator state row found after deploy",
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
            accountId: undefined,
            servicePrincipal: undefined,
          },
        },
      });

      // Before the fix this failed in plan: `read` called
      // `listDelegatedServicesForAccount({ AccountId: undefined })` with the
      // junk olds.
      const recovered = yield* deployAdmin();
      expect(recovered.accountId).toEqual(created.accountId);
      expect(recovered.servicePrincipal).toEqual(created.servicePrincipal);

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
