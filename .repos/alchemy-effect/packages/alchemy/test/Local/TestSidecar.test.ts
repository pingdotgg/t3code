import * as Cloudflare from "@/Cloudflare/index.ts";
import { RpcProviderProxy } from "@/Local/RpcProviderProxy";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

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
);

inProcess.test(
  "sidecar: false opts a dev test out of the RpcProviderProxy",
  Effect.gen(function* () {
    const proxy = yield* Effect.serviceOption(RpcProviderProxy);
    expect(proxy._tag).toBe("None");
  }),
);

live.test(
  "non-dev tests do not install the RpcProviderProxy",
  Effect.gen(function* () {
    const proxy = yield* Effect.serviceOption(RpcProviderProxy);
    expect(proxy._tag).toBe("None");
  }),
);
