import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import { expect, vi } from "vite-plus/test";

import * as HostProcess from "./HostProcess.ts";

// Builtin namespace exports are read-only; synchronize mutable OS spies into them.
const mutableOS: typeof NodeOS = NodeModule.createRequire(import.meta.url)("node:os");

it.effect("resolves the account home without consulting the ambient home", () =>
  Effect.gen(function* () {
    const expected = NodeOS.userInfo().homedir;
    const ambientHome = vi.spyOn(mutableOS, "homedir").mockReturnValue("/unused/ambient/home");
    NodeModule.syncBuiltinESMExports();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ambientHome.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }),
    );
    const actual = yield* Effect.flatten(HostProcess.AccountHomeDirectory);
    expect(actual).toBe(expected);
    expect(ambientHome).not.toHaveBeenCalled();
  }),
);

it.effect("keeps account home lookup failures typed with their exact cause", () =>
  Effect.gen(function* () {
    const cause = Object.assign(new Error("private account lookup diagnostic"), {
      code: "ERR_SYSTEM_ERROR",
    });
    const userInfo = vi.spyOn(mutableOS, "userInfo").mockImplementation(() => {
      throw cause;
    });
    const ambientHome = vi.spyOn(mutableOS, "homedir").mockReturnValue("/unused/ambient/home");
    NodeModule.syncBuiltinESMExports();
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ambientHome.mockRestore();
        userInfo.mockRestore();
        NodeModule.syncBuiltinESMExports();
      }),
    );
    const result = yield* Effect.flatten(HostProcess.AccountHomeDirectory).pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.failure).toMatchObject({ _tag: "AccountHomeDirectoryError" });
    expect(result.failure.cause).toBe(cause);
    expect(result.failure.message).not.toContain(cause.message);
    expect(ambientHome).not.toHaveBeenCalled();
    expect(userInfo).toHaveBeenCalledTimes(1);
  }),
);
