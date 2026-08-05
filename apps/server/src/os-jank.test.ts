import * as NodeOS from "node:os";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { AsyncWindowsShellEnvironment } from "@t3tools/shared/shell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  HostEnvironmentHydration,
  hostEnvironmentHydrationLayer,
  hydratePosixHome,
} from "./os-jank.ts";

it("hydrates HOME for minimal service environments from the user account", () => {
  const env: NodeJS.ProcessEnv = {};

  hydratePosixHome(env);

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("hydrates HOME independently of a blank process HOME", () => {
  const originalHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: " " };

  try {
    process.env.HOME = " ";
    hydratePosixHome(env);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }

  assert.equal(env.HOME, NodeOS.userInfo().homedir);
});

it("preserves an explicitly configured HOME", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/custom/home" };

  hydratePosixHome(env, () => {
    throw new Error("HOME lookup should not run");
  });

  assert.equal(env.HOME, "/custom/home");
});

it.effect("does not block startup on a PowerShell profile and eventually hydrates tools", () => {
  const env: NodeJS.ProcessEnv = {
    PATH: "C:\\Windows\\System32",
    APPDATA: "C:\\Users\\test\\AppData\\Roaming",
  };
  const started = Deferred.makeUnsafe<void>();
  const release = Deferred.makeUnsafe<void>();
  const reader = () =>
    Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.as({
        PATH: "C:\\Profile\\mise\\shims;C:\\Tools\\custom",
        FNM_DIR: "C:\\Users\\test\\AppData\\Roaming\\fnm",
      }),
    );
  const layer = hostEnvironmentHydrationLayer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HostProcessPlatform, "win32"),
        Layer.succeed(HostProcessEnvironment, env),
        Layer.succeed(AsyncWindowsShellEnvironment, reader),
        NodeServices.layer,
      ),
    ),
  );

  return Effect.gen(function* () {
    const hydration = yield* HostEnvironmentHydration;
    yield* Deferred.await(started);
    assert.notInclude(env.PATH, "C:\\Profile\\mise\\shims");
    yield* Deferred.succeed(release, undefined);
    assert.equal(hydration.windowsProfile._tag, "Some");
    if (hydration.windowsProfile._tag === "Some") {
      yield* hydration.windowsProfile.value;
    }
    assert.include(env.PATH, "C:\\Profile\\mise\\shims");
    assert.include(env.PATH, "C:\\Tools\\custom");
    assert.equal(env.FNM_DIR, "C:\\Users\\test\\AppData\\Roaming\\fnm");
  }).pipe(Effect.provide(layer));
});
