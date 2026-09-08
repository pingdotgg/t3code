import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const script = (marker: string) => `
export default {
  async fetch() {
    return new Response(${JSON.stringify(marker)});
  }
}`;

const HEX_ID = /^[0-9a-f]{32}$/;

/** The live script's tag straight from the account's script listing. */
const liveScriptTag = (accountId: string, scriptName: string) =>
  workers.listScripts.items({ accountId }).pipe(
    Stream.filter((s) => s.id === scriptName),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.map((s) => s?.tag ?? undefined),
  );

test.provider(
  "workerId is the immutable script ID and survives updates",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deployWith = (marker: string) =>
        stack.deploy(Cloudflare.Worker("IdWorker", { script: script(marker) }));

      const v1 = yield* deployWith("v1");
      // The immutable hex ID — decisively not the script name.
      expect(v1.workerId).toMatch(HEX_ID);
      expect(v1.workerId).not.toEqual(v1.workerName);
      // It is exactly what Cloudflare reports as the script's tag.
      expect(yield* liveScriptTag(accountId, v1.workerName)).toEqual(
        v1.workerId,
      );

      // A code update keeps both identifiers.
      const v2 = yield* deployWith("v2");
      expect(v2.workerId).toEqual(v1.workerId);
      expect(v2.workerName).toEqual(v1.workerName);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "legacy state carrying the script name in workerId heals on a no-change redeploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployWith = (marker: string) =>
        stack.deploy(
          Cloudflare.Worker("LegacyIdWorker", { script: script(marker) }),
        );

      const v1 = yield* deployWith("v1");
      const realId = v1.workerId;
      expect(realId).toMatch(HEX_ID);

      // Rewrite the persisted row into the pre-rename shape: older betas
      // stored the script *name* in `workerId`.
      const state = yield* yield* State;
      const stage = "test"; // scratch stacks default to the "test" stage
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const workerRow = rows.find(
        (r): r is { fqn: string; row: ResourceState } =>
          isResourceState(r.row) && r.row.resourceType === "Cloudflare.Worker",
      );
      if (!workerRow) {
        return yield* Effect.die(new Error("no Worker state row after deploy"));
      }
      const attr = workerRow.row.attr as { workerId?: string } | undefined;
      expect(attr?.workerId).toEqual(realId);
      yield* state.set({
        stack: stack.name,
        stage,
        fqn: workerRow.fqn,
        value: {
          ...workerRow.row,
          attr: { ...(attr ?? {}), workerId: v1.workerName },
        },
      });

      // A NO-CHANGE redeploy must heal: diff detects the legacy shape and
      // plans an update even though no prop changed, and reconcile records
      // the real immutable ID again (from the upload response).
      const healed = yield* deployWith("v1");
      expect(healed.workerId).toEqual(realId);
      expect(healed.workerId).not.toEqual(healed.workerName);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "state loss: adoption re-records the same immutable ID",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // A deterministic name: with auto-generated names, state loss mints a
      // fresh instance id (and so a fresh script) — adoption is only
      // meaningful when the physical name is stable.
      const deploy = () =>
        stack.deploy(
          Cloudflare.Worker("AdoptIdWorker", {
            name: "alchemy-test-workerid-adopt",
            script: script("v1"),
          }),
        );

      const v1 = yield* deploy();
      expect(v1.workerId).toMatch(HEX_ID);

      // Simulate state loss: the script lives on in Cloudflare, but the
      // engine has no row for it.
      const state = yield* yield* State;
      const stage = "test";
      const fqns = yield* state.list({ stack: stack.name, stage });
      const rows = yield* Effect.forEach(fqns, (fqn) =>
        state
          .get({ stack: stack.name, stage, fqn })
          .pipe(Effect.map((row) => ({ fqn, row }))),
      );
      const workerRow = rows.find(
        (r) =>
          isResourceState(r.row) && r.row.resourceType === "Cloudflare.Worker",
      );
      if (!workerRow) {
        return yield* Effect.die(new Error("no Worker state row after deploy"));
      }
      yield* state.delete({ stack: stack.name, stage, fqn: workerRow.fqn });

      // The re-deploy upserts the same script — same name, same immutable
      // ID (proof the script was adopted, not replaced).
      const readopted = yield* deploy();
      expect(readopted.workerName).toEqual(v1.workerName);
      expect(readopted.workerId).toEqual(v1.workerId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);

test.provider(
  "a version worker carries its parent script's workerId",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { parent, preview } = yield* stack.deploy(
        Effect.gen(function* () {
          const parent = yield* Cloudflare.Worker("IdVersionParent", {
            script: script("parent"),
          });
          const preview = yield* Cloudflare.Worker("IdVersionPreview", {
            script: script("preview"),
            version: { parent, message: "workerId test" },
          });
          return { parent, preview };
        }),
      );

      expect(parent.workerId).toMatch(HEX_ID);
      // The version worker owns no script of its own — it carries the
      // parent's immutable ID (resolved through the listing lookup), so
      // Access preview destinations protect its preview URLs.
      expect(preview.workerId).toEqual(parent.workerId);
      expect(preview.versionOf).toEqual(parent.workerName);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 240_000 },
);
