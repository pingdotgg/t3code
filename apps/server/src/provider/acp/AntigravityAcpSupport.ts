/**
 * Spawn wiring for the Antigravity provider.
 *
 * Unlike Cursor and Grok — whose CLIs speak ACP natively — Antigravity has no
 * agent protocol, so the "ACP agent" spawned here is T3 Code's own bridge
 * (`t3 agy-acp`, see `antigravity/agyBridge.ts`). Running it as a subcommand of
 * this same binary means the bridge always ships and versions with the server.
 *
 * @module provider/acp/AntigravityAcpSupport
 */
import { type AntigravitySettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const ANTIGRAVITY_DRIVER_KIND = ProviderDriverKind.make("antigravity");

/** Antigravity manages its own Google sign-in, so there is nothing to select. */
const ANTIGRAVITY_AUTH_METHOD = "none";

export const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3.1-pro-high";

type AntigravityAcpRuntimeSettings = Pick<
  AntigravitySettings,
  "binaryPath" | "printTimeout" | "appDataDir" | "requireToolApproval"
>;

interface AntigravityAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly antigravitySettings: AntigravityAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  /** Model the bridge should pass to `agy --model` for this session. */
  readonly model?: string | undefined;
  /** Reasoning effort for `agy --effort`. */
  readonly effort?: string | undefined;
}

/**
 * Resolve how to re-invoke this server binary.
 *
 * Under `node src/bin.ts` the entry script must be passed explicitly; a packed
 * single-file build is itself the executable.
 */
export function resolveBridgeCommand(): { command: string; args: ReadonlyArray<string> } {
  const entry = process.argv[1];
  return entry
    ? { command: process.execPath, args: [entry, "agy-acp"] }
    : { command: process.execPath, args: ["agy-acp"] };
}

export function buildAntigravityAcpSpawnInput(input: {
  readonly antigravitySettings: AntigravityAcpRuntimeSettings | null | undefined;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}): AcpSessionRuntime.AcpSpawnInput {
  const { command, args } = resolveBridgeCommand();
  const settings = input.antigravitySettings;
  // The bridge reads its per-turn configuration from the environment so that
  // `agy` invocation details stay entirely inside the bridge process.
  const env: NodeJS.ProcessEnv = { ...input.environment };
  if (settings?.binaryPath?.trim()) {
    env["T3_AGY_COMMAND"] = settings.binaryPath.trim();
  }
  if (settings?.printTimeout?.trim()) {
    env["T3_AGY_PRINT_TIMEOUT"] = settings.printTimeout.trim();
  }
  if (settings?.appDataDir?.trim()) {
    env["T3_AGY_APP_DATA_DIR"] = settings.appDataDir.trim();
  }
  if (settings?.requireToolApproval) {
    env["T3_AGY_REQUIRE_APPROVAL"] = "1";
  }
  if (input.model?.trim()) {
    env["T3_AGY_MODEL"] = input.model.trim();
  }
  if (input.effort?.trim()) {
    env["T3_AGY_EFFORT"] = input.effort.trim();
  }

  return { command, args: [...args], cwd: input.cwd, env };
}

export const makeAntigravityAcpRuntime = (
  input: AntigravityAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildAntigravityAcpSpawnInput({
          antigravitySettings: input.antigravitySettings,
          cwd: input.cwd,
          ...(input.environment ? { environment: input.environment } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
        }),
        authMethodId: ANTIGRAVITY_AUTH_METHOD,
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

export function resolveAntigravityBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : DEFAULT_ANTIGRAVITY_MODEL;
  return normalizeModelSlug(base, ANTIGRAVITY_DRIVER_KIND) ?? DEFAULT_ANTIGRAVITY_MODEL;
}

/**
 * Parse `agy models` output.
 *
 * The command prints one slug per line with no header or decoration.
 */
export function parseAntigravityModelList(output: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  for (const line of output.split("\n")) {
    const slug = line.trim();
    if (slug.length === 0 || slug.includes(" ")) {
      continue;
    }
    seen.add(slug);
  }
  return [...seen];
}
