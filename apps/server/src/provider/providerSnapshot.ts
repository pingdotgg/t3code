import type {
  ModelCapabilities,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { isWindowsCommandNotFound } from "../processRunner.ts";

export const DEFAULT_TIMEOUT_MS = 4_000;
// Auth status checks involve disk/network lookups and can be slow on first run (especially Windows)
export const AUTH_PROBE_TIMEOUT_MS = 10_000;

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export interface ProviderProbeResult {
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

export interface ServerProviderPresentation {
  readonly displayName: string;
  readonly badgeLabel?: string;
  readonly showInteractionModeToggle?: boolean;
}

export function nonEmptyTrimmed(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function isCommandMissingCause(error: Error): boolean {
  const lower = error.message.toLowerCase();
  return lower.includes("enoent") || lower.includes("notfound");
}

export const spawnAndCollect = (binaryPath: string, command: ChildProcess.Command) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(command);
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        collectStreamAsString(child.stdout),
        collectStreamAsString(child.stderr),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );

    const result: CommandResult = { stdout, stderr, code: exitCode };
    if (isWindowsCommandNotFound(exitCode, stderr)) {
      return yield* Effect.fail(new Error(`spawn ${binaryPath} ENOENT`));
    }
    return result;
  }).pipe(Effect.scoped);

export function detailFromResult(
  result: CommandResult & { readonly timedOut?: boolean },
): string | undefined {
  if (result.timedOut) return "Timed out while running command.";
  const stderr = nonEmptyTrimmed(result.stderr);
  if (stderr) return stderr;
  const stdout = nonEmptyTrimmed(result.stdout);
  if (stdout) return stdout;
  if (result.code !== 0) {
    return `Command exited with code ${result.code}.`;
  }
  return undefined;
}

export function extractAuthBoolean(value: unknown): boolean | undefined {
  if (globalThis.Array.isArray(value)) {
    for (const entry of value) {
      const nested = extractAuthBoolean(entry);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  if (!value || typeof value !== "object") return undefined;

  const record = value as Record<string, unknown>;
  for (const key of ["authenticated", "isAuthenticated", "loggedIn", "isLoggedIn"] as const) {
    if (typeof record[key] === "boolean") return record[key];
  }
  for (const key of ["auth", "status", "session", "account"] as const) {
    const nested = extractAuthBoolean(record[key]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\b(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}

export function providerModelsFromSettings(
  builtInModels: ReadonlyArray<ServerProviderModel>,
  provider: ServerProvider["provider"],
  customModels: ReadonlyArray<string>,
  customModelCapabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  const resolvedBuiltInModels = [...builtInModels];
  const seen = new Set(resolvedBuiltInModels.map((model) => model.slug));
  const customEntries: ServerProviderModel[] = [];

  for (const candidate of customModels) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    customEntries.push({
      slug: normalized,
      name: normalized,
      isCustom: true,
      capabilities: customModelCapabilities,
    });
  }

  return [...resolvedBuiltInModels, ...customEntries];
}

export function buildSelectOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly options:
    | ReadonlyArray<{ value: string; label: string; isDefault?: boolean | undefined }>
    | undefined;
  readonly description?: string;
  readonly promptInjectedValues?: ReadonlyArray<string>;
}) {
  const options = (input.options ?? []).map((option) =>
    option.isDefault
      ? { id: option.value, label: option.label, isDefault: true }
      : { id: option.value, label: option.label },
  );
  const currentValue = options.find((option) => option.isDefault)?.id;
  return {
    id: input.id,
    label: input.label,
    type: "select" as const,
    options,
    ...(currentValue ? { currentValue } : {}),
    ...(input.description ? { description: input.description } : {}),
    ...(input.promptInjectedValues && input.promptInjectedValues.length > 0
      ? { promptInjectedValues: [...input.promptInjectedValues] }
      : {}),
  };
}

export function buildBooleanOptionDescriptor(input: {
  readonly id: string;
  readonly label: string;
  readonly currentValue?: boolean;
  readonly description?: string;
}) {
  return {
    id: input.id,
    label: input.label,
    type: "boolean" as const,
    ...(input.description ? { description: input.description } : {}),
    ...(typeof input.currentValue === "boolean" ? { currentValue: input.currentValue } : {}),
  };
}

export function buildServerProvider(input: {
  provider: ServerProvider["provider"];
  presentation: ServerProviderPresentation;
  enabled: boolean;
  checkedAt: string;
  models: ReadonlyArray<ServerProviderModel>;
  slashCommands?: ReadonlyArray<ServerProviderSlashCommand>;
  skills?: ReadonlyArray<ServerProviderSkill>;
  probe: ProviderProbeResult;
}): ServerProvider {
  return {
    provider: input.provider,
    displayName: input.presentation.displayName,
    ...(input.presentation.badgeLabel ? { badgeLabel: input.presentation.badgeLabel } : {}),
    ...(typeof input.presentation.showInteractionModeToggle === "boolean"
      ? { showInteractionModeToggle: input.presentation.showInteractionModeToggle }
      : {}),
    enabled: input.enabled,
    installed: input.probe.installed,
    version: input.probe.version,
    status: input.enabled ? input.probe.status : "disabled",
    auth: input.probe.auth,
    checkedAt: input.checkedAt,
    ...(input.probe.message ? { message: input.probe.message } : {}),
    models: input.models,
    slashCommands: [...(input.slashCommands ?? [])],
    skills: [...(input.skills ?? [])],
  };
}

export const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );
