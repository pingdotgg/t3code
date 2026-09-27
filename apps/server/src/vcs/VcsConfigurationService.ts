import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type VcsConfigurationInput,
  type VcsConfigurationResult,
  type VcsConfigurationWriteInput,
  type VcsError,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
} from "@t3tools/contracts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

type Setting = VcsConfigurationWriteInput["setting"];
type Handle = VcsDriverRegistry.VcsDriverHandle;

const CONFIG_KEYS: Record<Setting, string> = {
  userName: "user.name",
  userEmail: "user.email",
  largeFile: "core.bigFileThreshold",
};

function validateValue(
  setting: Setting,
  value: string,
): Effect.Effect<string, VcsUnsupportedOperationError> {
  const trimmed = value.trim();
  if (setting === "largeFile") {
    const match = /^([1-9]\d{0,3})(?:\s*(?:m|mib))?$/i.exec(trimmed);
    const mebibytes = match ? Number(match[1]) : 0;
    if (mebibytes >= 1 && mebibytes <= 4096) {
      return Effect.succeed(`${mebibytes}m`);
    }
    return Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "VcsConfigurationService.write",
        kind: "git",
        detail: "Enter a large-file threshold between 1 and 4096 MiB.",
      }),
    );
  }
  const hasControlCharacter = [...trimmed].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (trimmed.length > 0 && trimmed.length <= 256 && !hasControlCharacter) {
    return Effect.succeed(trimmed);
  }
  return Effect.fail(
    new VcsUnsupportedOperationError({
      operation: "VcsConfigurationService.write",
      kind: "git",
      detail: "Enter a name or email without control characters (up to 256 characters).",
    }),
  );
}

export class VcsConfigurationService extends Context.Service<
  VcsConfigurationService,
  {
    readonly read: (
      input: VcsConfigurationInput,
    ) => Effect.Effect<VcsConfigurationResult, VcsError>;
    readonly write: (input: VcsConfigurationWriteInput) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/VcsConfigurationService") {}

export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const readValue = Effect.fn("VcsConfigurationService.readValue")(function* (
    handle: Handle,
    cwd: string,
    key: string,
    scope: "effective" | "local" | "worktree",
    booleanValue = false,
  ) {
    const args = [
      "config",
      ...(scope === "effective" ? [] : [`--${scope}`]),
      ...(booleanValue ? ["--bool"] : []),
      "--get",
      key,
    ];
    const result = yield* handle.driver.execute({
      operation: "VcsConfigurationService.read",
      cwd,
      args,
      allowNonZeroExit: true,
      maxOutputBytes: 4_096,
    });
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) {
      return yield* new VcsProcessExitError({
        operation: "VcsConfigurationService.read",
        command: "git config",
        cwd,
        exitCode: result.exitCode,
        detail: result.stderr.trim() || "Could not read repository configuration.",
      });
    }
    return result.stdout.trim();
  });

  const read: VcsConfigurationService["Service"]["read"] = Effect.fn(
    "VcsConfigurationService.read",
  )(function* (input) {
    const handle = yield* registry.resolve({ cwd: input.cwd });
    if (handle.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsConfigurationService.read",
        kind: handle.kind,
        detail: "Repository configuration is available for Git only.",
      });
    }
    const worktreeConfigEnabled =
      (yield* readValue(handle, input.cwd, "extensions.worktreeConfig", "local", true)) === "true";
    const entry = (setting: Setting) =>
      Effect.all({
        effective: readValue(handle, input.cwd, CONFIG_KEYS[setting], "effective"),
        local: readValue(handle, input.cwd, CONFIG_KEYS[setting], "local"),
        worktree: worktreeConfigEnabled
          ? readValue(handle, input.cwd, CONFIG_KEYS[setting], "worktree")
          : Effect.succeed(null),
      }).pipe(
        Effect.map(({ effective, local, worktree }) => ({
          effective: effective ?? (setting === "largeFile" ? "512m" : null),
          repository: worktree ?? local,
          scope:
            worktree !== null ? ("worktree" as const) : local !== null ? ("local" as const) : null,
        })),
      );
    const values = yield* Effect.all({
      userName: entry("userName"),
      userEmail: entry("userEmail"),
      largeFile: entry("largeFile"),
    });
    return { kind: handle.kind, ...values } satisfies VcsConfigurationResult;
  });

  const write: VcsConfigurationService["Service"]["write"] = Effect.fn(
    "VcsConfigurationService.write",
  )(function* (input) {
    const handle = yield* registry.resolve({ cwd: input.cwd });
    if (handle.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsConfigurationService.write",
        kind: handle.kind,
        detail: "Repository configuration is available for Git only.",
      });
    }
    const key = CONFIG_KEYS[input.setting];
    const worktreeConfigEnabled =
      (yield* readValue(handle, input.cwd, "extensions.worktreeConfig", "local", true)) === "true";
    const worktreeValue = worktreeConfigEnabled
      ? yield* readValue(handle, input.cwd, key, "worktree")
      : null;
    const scope = worktreeValue !== null ? "worktree" : "local";
    if (input.value === null && (yield* readValue(handle, input.cwd, key, scope)) === null) {
      return;
    }
    const value = input.value === null ? null : yield* validateValue(input.setting, input.value);
    const args = [
      "config",
      `--${scope}`,
      value === null ? "--unset-all" : "--replace-all",
      key,
      ...(value === null ? [] : [value]),
    ];
    yield* handle.driver.execute({
      operation: "VcsConfigurationService.write",
      cwd: input.cwd,
      args,
      maxOutputBytes: 4_096,
    });
  });

  return VcsConfigurationService.of({ read, write });
});

export const layer = Layer.effect(VcsConfigurationService, make);
