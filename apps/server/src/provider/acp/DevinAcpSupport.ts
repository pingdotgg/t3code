/**
 * DevinAcpSupport — spawn and session helpers for `devin acp`.
 *
 * Devin's ACP server exposes a merged "Session Mode" selector (accept-edits,
 * smart, ask, plan, bypass) plus a `model` config option. The CLI's most
 * restrictive writable permission mode (`normal`) is not in that selector —
 * it is only reachable through the `--permission-mode` spawn flag, so T3's
 * "approval-required" maps to the flag at spawn and to `accept-edits` (the
 * least-privileged writable ACP mode) when the session mode must be restored
 * in-session.
 *
 * @module DevinAcpSupport
 */
import {
  type DevinSettings,
  type ProviderOptionSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type { AcpSessionModeState } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

type DevinAcpRuntimeDevinSettings = Pick<DevinSettings, "binaryPath">;

/**
 * T3 runtime mode → Devin `--permission-mode`. `normal` auto-approves
 * read-only work and prompts for risky actions; `bypass` auto-approves all.
 */
function devinAcpPermissionArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "approval-required":
      return ["--permission-mode", "normal"];
    case "auto-accept-edits":
      return ["--permission-mode", "accept-edits"];
    case "auto":
      return ["--permission-mode", "smart"];
    case "full-access":
      return ["--permission-mode", "bypass"];
    default:
      return [];
  }
}

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeDevinSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
}

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option" | "set-model";
  readonly configId?: string;
}

// Devin reads and writes the workspace itself; T3 does not proxy fs or
// terminal I/O for it.
export const DEVIN_ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeDevinSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: [...devinAcpPermissionArgs(runtimeMode), "acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildDevinAcpSpawnInput(
          input.devinSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
        ),
        authMethodId: "devin-browser",
        clientCapabilities: DEVIN_ACP_CLIENT_CAPABILITIES,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

const DEVIN_PLAN_MODE_ALIASES = ["plan", "architect"];
const DEVIN_READ_ONLY_MODE_IDS = new Set(["plan", "ask"]);
// First match in the session's advertised modes wins.
const DEVIN_MODE_BY_RUNTIME_MODE: Partial<Record<RuntimeMode, ReadonlyArray<string>>> = {
  "auto-accept-edits": ["accept-edits", "code"],
  auto: ["smart"],
  "full-access": ["bypass"],
};

function normalizeModeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function findModeByAliases(
  modes: ReadonlyArray<{ readonly id: string; readonly name: string }>,
  aliases: ReadonlyArray<string>,
): { readonly id: string } | undefined {
  const normalizedAliases = aliases.map((alias) => alias.toLowerCase());
  for (const alias of normalizedAliases) {
    const exact = modes.find(
      (mode) => mode.id.toLowerCase() === alias || mode.name.toLowerCase() === alias,
    );
    if (exact) return exact;
  }
  for (const alias of normalizedAliases) {
    const partial = modes.find((mode) =>
      normalizeModeSearchText(`${mode.id} ${mode.name}`).includes(alias),
    );
    if (partial) return partial;
  }
  return undefined;
}

/**
 * Resolve the Devin session mode for a turn. Returns `undefined` when the
 * current mode already expresses the requested posture, leaving it alone.
 */
export function resolveDevinModeId(input: {
  readonly interactionMode: "default" | "plan" | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly modeState: AcpSessionModeState | undefined;
}): string | undefined {
  const modeState = input.modeState;
  if (!modeState) {
    return undefined;
  }

  if (input.interactionMode === "plan") {
    return findModeByAliases(modeState.availableModes, DEVIN_PLAN_MODE_ALIASES)?.id;
  }

  const preferredIds = DEVIN_MODE_BY_RUNTIME_MODE[input.runtimeMode];
  if (preferredIds !== undefined) {
    return findModeByAliases(modeState.availableModes, preferredIds)?.id;
  }

  // approval-required: `normal` is spawn-flag only. If an earlier plan/ask
  // turn left a read-only mode active, restore the least-privileged writable
  // mode so the agent can keep working under supervision.
  if (DEVIN_READ_ONLY_MODE_IDS.has(modeState.currentModeId)) {
    return (
      findModeByAliases(modeState.availableModes, ["accept-edits", "code"])?.id ??
      modeState.availableModes.find((mode) => !DEVIN_READ_ONLY_MODE_IDS.has(mode.id))?.id
    );
  }
  return undefined;
}

interface DevinAcpModelSelectionRuntime {
  readonly getConfigOptions: AcpSessionRuntime.AcpSessionRuntime["Service"]["getConfigOptions"];
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: DevinAcpModelSelectionRuntime;
  readonly model: string | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: DevinAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  return Effect.gen(function* () {
    const model = input.model?.trim();
    if (model) {
      yield* input.runtime.setModel(model).pipe(
        Effect.mapError((cause) =>
          input.mapError({
            cause,
            step: "set-model",
          }),
        ),
      );
    }

    // Devin's session config surface is just `model` + `mode`, but apply any
    // selection that happens to match an advertised config option so future
    // Devin options light up without an adapter change.
    const configOptions = yield* input.runtime.getConfigOptions;
    for (const selection of input.selections ?? []) {
      const option = configOptions.find((candidate) => candidate.id === selection.id);
      if (!option || option.id === "model") continue;
      yield* input.runtime
        .setConfigOption(
          option.id,
          typeof selection.value === "boolean" ? selection.value : String(selection.value),
        )
        .pipe(
          Effect.mapError((cause) =>
            input.mapError({
              cause,
              step: "set-config-option",
              configId: option.id,
            }),
          ),
        );
    }
  });
}
