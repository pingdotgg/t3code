import * as Cloudflare from "@alchemy.run/cloudflare";
import { describe, expect, registerFileCleanup } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Interaction } from "alchemy/Interaction";
import { RpcProviderProxy } from "alchemy/Local/RpcProviderProxy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Contract tests for the test harness's sidecar topology (see
 * MakeOptions.sidecar in Test/Core.ts): `dev: true` runs local providers
 * behind the RPC proxy used by the real `alchemy dev` command BY DEFAULT,
 * and `sidecar: false` opts back into the in-process topology.
 *
 * The dev-mode resource tests (KV/R2/Queue/D1 `*.local.test.ts`) would
 * still pass in-process if the default silently stopped installing the
 * proxy — the whole point of the topology is that missing main-process
 * dependencies only surface under it (#1007). These tests pin the harness
 * contract directly so a refactor of Test.make can't quietly demote every
 * dev test back to in-process.
 */

const dev = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const inProcess = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
  sidecar: false,
});

const live = Test.make({
  providers: Cloudflare.providers(),
});

dev.test(
  "dev: true installs the RpcProviderProxy by default",
  Effect.gen(function* () {
    const proxy = yield* Effect.serviceOption(RpcProviderProxy);
    expect(proxy._tag).toBe("Some");
  }),
  { tags: ["provider:cloudflare", "local"] },
);

inProcess.test(
  "sidecar: false opts a dev test out of the RpcProviderProxy",
  Effect.gen(function* () {
    const proxy = yield* Effect.serviceOption(RpcProviderProxy);
    expect(proxy._tag).toBe("None");
  }),
  { tags: ["provider:cloudflare", "local"] },
);

live.test(
  "non-dev tests do not install the RpcProviderProxy",
  Effect.gen(function* () {
    const proxy = yield* Effect.serviceOption(RpcProviderProxy);
    expect(proxy._tag).toBe("None");
  }),
  { tags: ["provider:cloudflare", "local"] },
);

live.test(
  "test runtimes provide a non-interactive Interaction",
  Effect.gen(function* () {
    const interaction = yield* Interaction;
    const failure = yield* Effect.flip(interaction.prompt.confirm({ message: "?" }));
    expect(failure._tag).toBe("NonInteractiveTerminal");
  }),
  { tags: ["provider:cloudflare", "local"] },
);

const cleanupOrder: Array<string> = [];

describe("file-owned runtime cleanup", () => {
  const nested = Test.make({
    providers: Layer.empty,
    dev: true,
    sidecar: true,
  });
  nested.beforeAll(
    Effect.addFinalizer(() =>
      Effect.sync(() => {
        cleanupOrder.push("scope");
      }),
    ),
  );
  nested.test(
    "retains the shared runtime until file cleanup",
    Effect.sync(() => {
      expect(cleanupOrder).toEqual([]);
    }),
    { tags: ["unit", "local"] },
  );
  nested.afterAll(
    Effect.sync(() => {
      expect(cleanupOrder).toEqual([]);
      cleanupOrder.push("user");
    }),
  );

  const skipped = Test.make({
    providers: Layer.empty,
    dev: true,
    sidecar: true,
  });
  skipped.test.skip("unused handles need no RPC session", Effect.void, { tags: ["unit", "local"] });
});

live.afterAll(
  Effect.sync(() => {
    expect(cleanupOrder).not.toContain("scope");
  }),
);

registerFileCleanup({
  body: () =>
    Effect.sync(() => {
      if (cleanupOrder.length > 0) expect(cleanupOrder).toEqual(["user", "scope"]);
      cleanupOrder.length = 0;
    }),
});
