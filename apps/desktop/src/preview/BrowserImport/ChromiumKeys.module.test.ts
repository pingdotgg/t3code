import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { vi } from "vite-plus/test";

vi.mock("@napi-rs/keyring", () => {
  throw new Error("Cannot find native binding");
});

it("loads browser import code without a keyring native binding", async () => {
  await expect(import("./ChromiumKeys.ts")).resolves.toBeDefined();
});

it.effect("reports an unavailable keychain when the macOS binding cannot load", () =>
  Effect.gen(function* () {
    const { ChromiumKeyError, resolveChromiumKeys } = yield* Effect.promise(
      () => import("./ChromiumKeys.ts"),
    );
    const error = yield* resolveChromiumKeys({
      platform: "darwin",
      keychainService: "Chrome Safe Storage",
      keychainAccount: "Chrome",
      linuxSecretApplication: undefined,
    }).pipe(Effect.flip);

    expect(error).toBeInstanceOf(ChromiumKeyError);
    expect(error.reason).toBe("keychainUnavailable");
    expect(error.cause).toBeInstanceOf(Error);
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("must not spawn")),
    ),
  ),
);
