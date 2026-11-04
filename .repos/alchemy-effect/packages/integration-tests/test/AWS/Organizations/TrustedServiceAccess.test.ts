import * as AWS from "@alchemy.run/aws";
import { TrustedServiceAccess } from "@alchemy.run/aws/Organizations";
import { describe, expect } from "@alchemy.run/test";
import * as organizations from "@distilled.cloud/aws/organizations";
import * as Provider from "alchemy/Provider";
import { isResourceState, State, type ResourceState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as OrganizationLease from "./OrganizationLease.ts";

const { test } = OrganizationLease.make({ providers: AWS.providers() }, "shared");

// Read-only `list()` test (AWS account-scoped collection that enumerates every
// service principal granted trusted access to the organization). Resolve the
// provider from context via the typed `Provider.findProvider`, call `list()`,
// and assert the result is a well-typed `Attributes[]`.
//
// `list()` is designed to degrade gracefully off the org management account:
// `listAWSServiceAccessForOrganization` rejects with
// `AWSOrganizationsNotInUseException` / `AccessDeniedException` when the caller
// isn't an org management/delegated account, which `list()` catches and maps to
// `[]`. So this case passes on any account — it just returns `[]` when the
// account can't enumerate trusted service access.
test.provider(
  "list enumerates trusted service access",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(TrustedServiceAccess);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);

      for (const item of all) {
        expect(typeof item.servicePrincipal).toBe("string");
        if (item.dateEnabled !== undefined) {
          expect(item.dateEnabled).toBeInstanceOf(Date);
        }
      }
    }),
  { tags: ["provider:aws", "provider:aws:organizations", "live"] },
);

// Full lifecycle list test — requires an org MANAGEMENT account. Gate behind an
// env var so an entitled account runs it unchanged. Off a management account
// `enableAWSServiceAccess` rejects with `AWSOrganizationsNotInUseException` /
// `AccessDeniedException`, so this is skipped by default.
const servicePrincipal = process.env.AWS_ORG_TRUSTED_SERVICE_PRINCIPAL ?? "config.amazonaws.com";

// Destroying the test's resource disables trusted access, so refuse to take
// over an enablement that existed before the test.
const requireTrustedAccessUnused = organizations.listAWSServiceAccessForOrganization.pages({}).pipe(
  Stream.runCollect,
  Effect.map((pages) =>
    Array.from(pages)
      .flatMap((page) => page.EnabledServicePrincipals ?? [])
      .some((item) => item.ServicePrincipal === servicePrincipal),
  ),
  Effect.flatMap((enabled) =>
    enabled
      ? Effect.fail(
          new Error(
            `trusted access for ${servicePrincipal} is already enabled; set AWS_ORG_TRUSTED_SERVICE_PRINCIPAL to an unused principal`,
          ),
        )
      : Effect.void,
  ),
);

// Both lifecycles own the same principal, so they must not overlap.
describe.sequential("trusted service access lifecycle", () => {
  test.provider.skipIf(!process.env.AWS_ORG_MANAGEMENT_ACCOUNT)(
    "list contains the deployed trusted service access",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        yield* requireTrustedAccessUnused;

        const access = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* TrustedServiceAccess("ListTrustedServiceAccess", { servicePrincipal });
          }),
        );

        const provider = yield* Provider.findProvider(TrustedServiceAccess);
        const all = yield* provider.list();

        expect(all.some((item) => item.servicePrincipal === access.servicePrincipal)).toBe(true);

        yield* stack.destroy();
      }),
    { tags: ["provider:aws", "provider:aws:organizations", "live"] },
  );

  // Regression test for https://github.com/alchemy-run/alchemy/issues/736.
  //
  // An interrupted first deploy persists the enablement as `status: "creating"`
  // with no attributes and props that could not round-trip. Plan's
  // creating-recovery branch then calls `provider.read` with those junk olds;
  // pre-fix the `olds!.servicePrincipal` dereference crashed the plan when the
  // persisted row carried no recoverable props at all (`BaseResourceState`
  // declares `props?:` — a row whose Output-valued props failed to round-trip
  // can surface with none).
  //
  // Simulate exactly that state row after a real deploy and assert the next
  // deploy recovers: `read` reports "not found", the engine re-drives the
  // create, and reconcile observes the access already enabled — SAME
  // servicePrincipal and SAME enablement date, no re-enable.
  test.provider.skipIf(!process.env.AWS_ORG_MANAGEMENT_ACCOUNT)(
    "recovers a half-created trusted service access whose creating-state lost its props (#736)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        yield* requireTrustedAccessUnused;

        const deployAccess = () =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* TrustedServiceAccess("WedgedTrustedAccess", { servicePrincipal });
            }),
          );

        const created = yield* deployAccess();

        // Rewrite the persisted row into the wedged shape an interrupted
        // deploy leaves behind: `creating`, no attributes, and no recoverable
        // props (the realistic field-level loss — `servicePrincipal:
        // undefined` — is tolerated even pre-fix because
        // `readTrustedServiceAccess` is list-and-find; the crash this fix
        // guards is the `olds!` deref on a row with no props at all).
        const state = yield* yield* State;
        const stage = stack.stage;
        const fqns = yield* state.list({ stack: stack.name, stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state.get({ stack: stack.name, stage, fqn }).pipe(Effect.map((row) => ({ fqn, row }))),
        );
        const wedged = rows.find(
          (r): r is { fqn: string; row: ResourceState } =>
            isResourceState(r.row) &&
            r.row.resourceType === "AWS.Organizations.TrustedServiceAccess",
        );
        if (!wedged) {
          return yield* Effect.die(
            new Error("no AWS.Organizations.TrustedServiceAccess state row found after deploy"),
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
        // `TypeError: undefined is not an object (evaluating 'olds.servicePrincipal')`.
        const recovered = yield* deployAccess();
        expect(recovered.servicePrincipal).toEqual(created.servicePrincipal);
        // Same enablement observed — not disabled/re-enabled.
        expect(recovered.dateEnabled?.getTime()).toEqual(created.dateEnabled?.getTime());

        yield* stack.destroy();
      }),
    { tags: ["provider:aws", "provider:aws:organizations", "live"], timeout: 240_000 },
  );
});
