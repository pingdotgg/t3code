import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { withCloudRun } from "./cloudRun.ts";

const DRIVER = ProviderDriverKind.make("codex");
const INSTANCE_ID = ProviderInstanceId.make("codex");
const local = { instanceId: INSTANCE_ID, model: "gpt-a" };
const cloud = { ...local, options: [{ id: "cloud", value: true }] };

/** An adapter that records which one opened a session and how it plans transitions. */
const fakeAdapter = (
  name: string,
  opened: Array<string>,
): ProviderAdapter.ProviderAdapterV2["Service"] =>
  ProviderAdapter.ProviderAdapterV2.of({
    instanceId: INSTANCE_ID,
    driver: DRIVER,
    getCapabilities: () => Effect.die(name),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () =>
      Effect.sync(() => {
        opened.push(name);
      }).pipe(Effect.andThen(Effect.die("opened"))),
  });

describe("withCloudRun", () => {
  it.effect("opens cloud selections on the cloud adapter and the rest natively", () =>
    Effect.gen(function* () {
      const opened: Array<string> = [];
      const adapter = withCloudRun(fakeAdapter("native", opened), fakeAdapter("cloud", opened));
      const open = (modelSelection: typeof local) =>
        adapter
          .openSession({
            threadId: ThreadId.make("thread"),
            providerSessionId: ProviderSessionId.make("session"),
            modelSelection,
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/repo",
            }),
          })
          .pipe(Effect.scoped, Effect.exit);

      yield* open(cloud);
      yield* open(local);

      assert.deepStrictEqual(opened, ["cloud", "native"]);
    }),
  );

  it.effect("keeps a started thread where it runs", () =>
    Effect.gen(function* () {
      const adapter = withCloudRun(fakeAdapter("native", []), fakeAdapter("cloud", []));
      const plan = (current: typeof local, target: typeof local) =>
        adapter.planSelectionTransition({
          current,
          target,
          sessionCapabilities: {} as never,
        });

      assert.strictEqual((yield* plan(cloud, local)).type, "reject");
      assert.strictEqual((yield* plan(local, cloud)).type, "reject");
      assert.strictEqual(
        (yield* plan(cloud, { ...cloud, model: "gpt-b" })).type,
        "apply_on_next_turn",
      );
    }),
  );

  it.effect("describes a cloud selection with the cloud's own session capabilities", () =>
    Effect.gen(function* () {
      const adapter = withCloudRun(fakeAdapter("native", []), fakeAdapter("cloud", []));
      const capabilitiesOf = (selection: typeof local) =>
        adapter.capabilitiesFor!(selection).pipe(
          Effect.catchDefect((defect) => Effect.succeed(String(defect))),
        );

      assert.strictEqual(yield* capabilitiesOf(cloud), "cloud");
      assert.strictEqual(yield* capabilitiesOf(local), "native");
    }),
  );

  it.effect("keeps a started cloud thread in its selected environment", () =>
    Effect.gen(function* () {
      const adapter = withCloudRun(fakeAdapter("native", []), fakeAdapter("cloud", []));
      const selection = (id: string) => ({
        ...cloud,
        options: [...cloud.options, { id: "cloudEnvironment", value: id }],
      });
      const plan = (id: string) =>
        adapter.planSelectionTransition({
          current: selection("original"),
          target: selection(id),
          sessionCapabilities: {} as never,
        });
      assert.strictEqual((yield* plan("other")).type, "reject");
      assert.strictEqual((yield* plan("original")).type, "apply_on_next_turn");
    }),
  );
});
