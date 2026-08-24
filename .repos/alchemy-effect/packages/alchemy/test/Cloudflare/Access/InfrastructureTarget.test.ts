import { adopt, OwnedBySomeoneElse } from "@/AdoptPolicy";
import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

test.provider("list enumerates the deployed infrastructure target", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const target = yield* stack.deploy(
      Effect.gen(function* () {
        return yield* Cloudflare.Access.InfrastructureTarget("ListTarget", {
          hostname: "list-test.bastion.internal",
          ip: { ipv4: { ipAddr: "10.7.0.42" } },
        });
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.Access.InfrastructureTarget,
    );
    const all = yield* provider.list();

    const found = all.find((t) => t.targetId === target.targetId);
    expect(found).toBeDefined();
    expect(found?.accountId).toEqual(accountId);
    expect(found?.hostname).toEqual(target.hostname);
    expect(found?.ip.ipv4?.ipAddr).toEqual("10.7.0.42");

    yield* stack.destroy();
  }),
);

test.provider(
  "recovers a half-created target whose creating-state lost Output-valued props (#736)",
  (stack) =>
    Effect.gen(function* () {
      const hostname = "wedged-recovery.bastion.internal";

      yield* stack.destroy();

      // Safety net: a previously crashed run leaves an orphaned cloud
      // target (its state row is wedged attr-less, so destroy can't reach
      // it) which would fail the fresh deploy with OwnedBySomeoneElse.
      // Sweep any target with our deterministic hostname out-of-band.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const orphans = yield* zeroTrust.listAccessInfrastructureTargets
        .items({ accountId, hostname })
        .pipe(
          Stream.filter((t) => t.hostname === hostname),
          Stream.runCollect,
        );
      yield* Effect.forEach(Array.from(orphans), (t) =>
        zeroTrust
          .deleteAccessInfrastructureTarget({ accountId, targetId: t.id })
          .pipe(Effect.catchTag("TargetNotFound", () => Effect.void)),
      );

      const deployTarget = (adoptIt?: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const target = Cloudflare.Access.InfrastructureTarget(
              "WedgedTarget",
              {
                hostname,
                ip: { ipv4: { ipAddr: "10.7.0.99" } },
              },
            );
            return yield* adoptIt ? target.pipe(adopt(true)) : target;
          }),
        );

      const created = yield* deployTarget();

      // Rewrite the target's persisted row into the wedged shape an
      // interrupted deploy leaves behind: `creating`, no attributes, and
      // the Output-valued `ip` prop lost in the round-trip. `hostname`
      // survives so the cold-read identity path runs.
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
          r.row.resourceType === "Cloudflare.Access.InfrastructureTarget",
      );
      if (!wedged) {
        return yield* Effect.die(
          new Error(
            "no Cloudflare.Access.InfrastructureTarget state row found after deploy",
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
          props: { ...wedged.row.props, ip: undefined },
        },
      });

      // Before the #736 fix, `read` crashed here with
      // `TypeError: undefined is not an object (evaluating 'ip.ipv4')`
      // (resolvedIp(olds.ip) with olds.ip === undefined). After the fix,
      // read falls back to the output hint and matches by hostname —
      // but targets carry no ownership markers, so the match surfaces as
      // `Unowned`. Since #862, resuming an interrupted create onto an
      // Unowned resource fails loudly instead of silently taking over.
      const error = yield* deployTarget().pipe(
        Effect.as(undefined),
        Effect.catchCause((cause) => Effect.succeed(findOwnedError(cause))),
      );
      expect(error).toBeInstanceOf(OwnedBySomeoneElse);

      // adopt(true) opts in: the engine converges onto the same target —
      // no duplicate created.
      const recovered = yield* deployTarget(true);
      expect(recovered.targetId).toEqual(created.targetId);
      expect(recovered.hostname).toEqual(created.hostname);
      expect(recovered.ip.ipv4?.ipAddr).toEqual("10.7.0.99");

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);

const findOwnedError = (
  cause: Cause.Cause<unknown>,
): OwnedBySomeoneElse | undefined =>
  cause.reasons
    .map((reason) =>
      Cause.isFailReason(reason)
        ? reason.error
        : Cause.isDieReason(reason)
          ? reason.defect
          : undefined,
    )
    .find(
      (value): value is OwnedBySomeoneElse =>
        value instanceof OwnedBySomeoneElse,
    );
