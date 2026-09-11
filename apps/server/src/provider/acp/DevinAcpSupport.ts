import { type DevinSettings, type ProviderOptionSelection } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { collectSessionConfigOptionValues } from "./AcpRuntimeModel.ts";
import { devinModelGroupKey, parseDevinModelUid } from "../Layers/DevinProvider.ts";

export { inferDevinContextWindowTokens } from "../Layers/DevinProvider.ts";

const LOWER_SPEED_SUFFIX = /-(fast|priority)$/;
const UPPER_SPEED_SUFFIX = /_(FAST|PRIORITY)$/;

function stripTrailingSpeed(slug: string): { base: string; speed: string } | undefined {
  const lower = slug.match(LOWER_SPEED_SUFFIX);
  if (lower) {
    return { base: slug.slice(0, slug.length - lower[0].length), speed: lower[1]! };
  }
  const upper = slug.match(UPPER_SPEED_SUFFIX);
  if (upper) {
    return { base: slug.slice(0, slug.length - upper[0].length), speed: upper[1]!.toLowerCase() };
  }
  return undefined;
}

type DevinAcpRuntimeSettings = Pick<DevinSettings, "binaryPath">;

export const DEVIN_ACP_CLIENT_CAPABILITIES = {
  _meta: {
    "cognition.ai/mcp": true,
    "cognition.ai/mcpWorkspaceDirs": true,
  },
} satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly devinSettings: DevinAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildDevinAcpSpawnInput(
  devinSettings: DevinAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: devinSettings?.binaryPath || "devin",
    args: ["acp"],
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
        spawn: buildDevinAcpSpawnInput(input.devinSettings, input.cwd, input.environment),
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

export interface DevinAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-config-option";
  readonly configId: "model";
}

export function applyDevinAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setModel" | "getConfigOptions"
  >;
  readonly model: string | null | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (context: DevinAcpModelSelectionErrorContext) => E;
}): Effect.Effect<void, E> {
  const model = resolveDevinModelUid(input.model, input.selections);
  const reasoning = input.selections?.find((option) => option.id === "reasoning")?.value;
  const context = input.selections?.find((option) => option.id === "contextWindow")?.value;
  const speed = input.selections?.find((option) => option.id === "speed")?.value;
  const base = resolveDevinAcpBaseModelId(input.model);
  const isUpper = base.includes("_") && /[A-Z]/.test(base);
  const separator = isUpper ? "_" : "-";
  const contextSuffix =
    typeof context === "string" && context.trim()
      ? `${separator}${isUpper ? context.toUpperCase() : context.toLowerCase()}`
      : "";
  const fallbackCandidates =
    reasoning === "none" && (speed === undefined || speed === "standard")
      ? [contextSuffix.length > 0 ? `${base}${contextSuffix}` : null, base].filter(
          (candidate): candidate is string => candidate !== null && candidate !== model,
        )
      : [];
  const setModel = input.runtime.getConfigOptions.pipe(
    Effect.flatMap((configOptions) => {
      const option = configOptions.find(
        (entry) => entry.category === "model" || entry.id === "model",
      );
      const values = option ? collectSessionConfigOptionValues(option) : [];
      const hasVariantSelection = input.selections?.some((selection) =>
        ["reasoning", "contextWindow", "speed"].includes(selection.id),
      );
      let selected = model;
      // Family rows are not always valid ACP values (SWE-2 only advertises
      // suffixed variants). Preserve concrete IDs and otherwise use an
      // advertised default within the requested family.
      if (!hasVariantSelection) {
        const requested = input.model?.trim();
        if (requested && values.includes(requested)) {
          selected = requested;
        } else if (!values.includes(model)) {
          const family = values.filter((value) => resolveDevinAcpBaseModelId(value) === base);
          const current = option?.type === "select" ? option.currentValue : undefined;
          selected = current && family.includes(current) ? current : (family[0] ?? model);
        }
      }
      return input.runtime.setModel(selected);
    }),
    Effect.catch((cause) => {
      const fallback = fallbackCandidates[0];
      return fallback === undefined
        ? Effect.fail(cause)
        : input.runtime.setModel(fallback).pipe(
            Effect.catch((fallbackCause) => {
              const secondFallback = fallbackCandidates[1];
              return secondFallback === undefined
                ? Effect.fail(fallbackCause)
                : input.runtime.setModel(secondFallback);
            }),
          );
    }),
  );
  return setModel.pipe(
    Effect.mapError((cause) =>
      input.mapError({
        cause,
        step: "set-config-option",
        configId: "model",
      }),
    ),
  );
}

/**
 * Returns the base model slug (the group key, with no reasoning level) used
 * to decide whether a model change requires an ACP session restart. Changing
 * only the reasoning level is a config-option tweak, not a model swap.
 */
export function resolveDevinAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  if (!trimmed) return "adaptive";
  return devinModelGroupKey(parseDevinModelUid(trimmed));
}

/**
 * Recombines a base model slug with its `reasoning` option selection to form
 * the full model UID Devin's ACP backend expects.
 *
 * The base slug is the group key (e.g. `claude-opus-5` or
 * `claude-opus-5-fast`); the reasoning choice is inserted before any speed
 * tier so `claude-opus-5-fast` + `medium` → `claude-opus-5-medium-fast`.
 * Uppercase enum-style UIDs recombine with `_` separators and uppercased
 * suffixes: `MODEL_GPT_5_2` + `low` → `MODEL_GPT_5_2_LOW`.
 */
export function resolveDevinModelUid(
  model: string | null | undefined,
  options?: ReadonlyArray<ProviderOptionSelection> | null,
): string {
  const groupSlug = resolveDevinAcpBaseModelId(model);
  const reasoning = options?.find((option) => option.id === "reasoning")?.value;
  if (typeof reasoning !== "string" || !reasoning.trim()) {
    return groupSlug;
  }
  if (reasoning.startsWith("__uid:")) {
    const concreteUid = reasoning.slice("__uid:".length).trim();
    if (concreteUid.length > 0) return concreteUid;
  }
  // The group slug is `base + sep + speed` (or just base). Split the speed
  // tier off so the reasoning level can be inserted before it.
  const speedParts = stripTrailingSpeed(groupSlug);
  const base = speedParts?.base ?? groupSlug;
  const selectedSpeed = options?.find((option) => option.id === "speed")?.value;
  const speed =
    typeof selectedSpeed === "string" && selectedSpeed !== "standard"
      ? selectedSpeed
      : speedParts?.speed;
  const isUpper = base.includes("_") && /[A-Z]/.test(base);
  const sep = isUpper ? "_" : "-";
  const reasoningSuffix = isUpper ? reasoning.toUpperCase() : reasoning;
  const speedSuffix = speed ? (isUpper ? `_${speed.toUpperCase()}` : `-${speed}`) : "";
  const context = options?.find((option) => option.id === "contextWindow")?.value;
  // Devin's GLM family uses the unsuffixed UID for the 200K variants and
  // appends only the context suffix for 1M variants. The reasoning level is
  // encoded for None/Max, while High is the family default (`glm-5-2`).
  // It is never `glm-5-2-high-200k` (or another `-200k` UID).
  const isGlm52 = base.toLowerCase() === "glm-5-2";
  if (isGlm52 && (reasoning ?? "").toLowerCase() === "high") {
    return context === "1m" ? "glm-5-2-1m" : "glm-5-2";
  }
  if (isGlm52 && !speed && ["none", "max"].includes((reasoning ?? "").toLowerCase())) {
    const glmContextSuffix = context === "1m" ? "-1m" : "";
    return `glm-5-2-${reasoning!.toLowerCase()}${glmContextSuffix}`;
  }
  const contextSuffix =
    typeof context === "string" && context.trim()
      ? `${sep}${isUpper ? context.toUpperCase() : context.toLowerCase()}`
      : "";
  return `${base}${sep}${reasoningSuffix}${speedSuffix}${contextSuffix}`;
}
