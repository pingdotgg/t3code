import * as NodeUtil from "node:util";
import {
  VcsProcessSpawnError,
  type SourceControlProviderAuth,
  type SourceControlProviderDiscoveryItem,
  type SourceControlProviderInfo,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as SourceControlProvider from "./SourceControlProvider.ts";
import type * as SourceControlHost from "./SourceControlHost.ts";

export interface SourceControlAuthProbeInput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: SourceControlHost.SourceControlProcessOutput["exitCode"];
}

export interface SourceControlUnknownRemoteRefinementInput {
  readonly cwd: string;
  readonly context: SourceControlProvider.SourceControlProviderContext;
  readonly auth: SourceControlAuthProbeInput;
}

interface SourceControlDiscoverySpecBase {
  readonly kind: SourceControlProviderKind;
  readonly label: string;
  readonly installHint: string;
}

export type SourceControlCliDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "cli";
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
  readonly authArgs: ReadonlyArray<string>;
  readonly remoteRefinementArgs?: (
    context: SourceControlProvider.SourceControlProviderContext,
  ) => ReadonlyArray<string>;
  readonly probeTimeoutMs?: number;
  readonly parseAuth: (input: SourceControlAuthProbeInput) => SourceControlProviderAuth;
  /** `null` when the CLI holds nothing for the remote; `undefined` when its output cannot say. */
  readonly refineUnknownRemote?: (
    input: SourceControlUnknownRemoteRefinementInput,
  ) => SourceControlProviderInfo | null | undefined;
};

export type SourceControlApiDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "api";
  readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
};

export type SourceControlManagedCliDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "managed-cli";
  readonly probe: (cwd: string) => Effect.Effect<SourceControlProviderDiscoveryItem>;
  /** Null includes missing CLIs. Failure means unknown and must not be cached by the registry. */
  readonly refineUnknownRemote: (input: {
    readonly cwd: string;
    readonly context: SourceControlProvider.SourceControlProviderContext;
  }) => Effect.Effect<SourceControlProviderInfo | null, Cause.YieldableError>;
};

export type SourceControlProviderDiscoverySpec =
  | SourceControlCliDiscoverySpec
  | SourceControlManagedCliDiscoverySpec
  | SourceControlApiDiscoverySpec;

type SourceControlCliRemoteRefinementSpec = SourceControlCliDiscoverySpec & {
  readonly refineUnknownRemote: NonNullable<SourceControlCliDiscoverySpec["refineUnknownRemote"]>;
};

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
/** An API host that stalls must not hold the whole discovery answer behind it. */
const API_PROBE_TIMEOUT = "3 seconds";

function probeTimeoutMs(spec: SourceControlCliDiscoverySpec): number {
  return spec.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
}

interface DiscoveryProbeResult {
  readonly kind: SourceControlProviderKind;
  readonly label: string;
  readonly executable: string;
  readonly status: "available" | "missing";
  readonly version: Option.Option<string>;
  readonly installHint: string;
  readonly detail: Option.Option<string>;
}

export function firstNonEmptyLine(text: string): Option.Option<string> {
  const line = NodeUtil.stripVTControlCharacters(text)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? Option.none() : Option.some(line);
}

export function detailFromCause(cause: unknown): Option.Option<string> {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return Option.some(cause.message.trim());
  }
  return Option.none();
}

function authAccount(account: string | undefined): Option.Option<string> {
  const trimmed = account?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function authHost(host: string | undefined): Option.Option<string> {
  const trimmed = host?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

function authDetail(detail: string | undefined): Option.Option<string> {
  const trimmed = detail?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

export function providerAuth(input: {
  readonly status: SourceControlProviderAuth["status"];
  readonly account?: string | undefined;
  readonly host?: string | undefined;
  readonly detail?: string | undefined;
}): SourceControlProviderAuth {
  return {
    status: input.status,
    account: authAccount(input.account),
    host: authHost(input.host),
    detail: authDetail(input.detail),
  };
}

function unknownAuth(detail?: string): SourceControlProviderAuth {
  return providerAuth({ status: "unknown", detail });
}

export function combinedAuthOutput(input: SourceControlAuthProbeInput): string {
  const parts: string[] = [];
  for (const entry of [input.stdout, input.stderr]) {
    if (entry.trim().length > 0) {
      parts.push(entry);
    }
  }
  return parts.join("\n");
}

function sanitizedAuthLines(text: string): ReadonlyArray<string> {
  const lines: string[] = [];
  for (const entry of text.split(/\r?\n/)) {
    const line = entry.trim();
    if (line.length === 0) continue;
    if (/^[-\s]*token(?:\s+scopes?)?:/iu.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

export function firstSafeAuthLine(text: string): string | undefined {
  return sanitizedAuthLines(text)[0];
}

export function parseCliHost(text: string): string | undefined {
  return sanitizedAuthLines(text)
    .map((line) => line.replace(/^[^a-z0-9]+/iu, ""))
    .find((line) => /^[a-z0-9][a-z0-9.-]*(?::\d+)?$/iu.test(line));
}

export function matchFirst(text: string, patterns: ReadonlyArray<RegExp>): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function isCliRemoteRefinementSpec(
  spec: SourceControlProviderDiscoverySpec,
): spec is SourceControlCliRemoteRefinementSpec {
  return spec.type === "cli" && spec.refineUnknownRemote !== undefined;
}

function probeCli(input: {
  readonly spec: SourceControlCliDiscoverySpec;
  readonly process: SourceControlHost.SourceControlHost["Service"]["process"];
  readonly cwd: string;
}): Effect.Effect<DiscoveryProbeResult> {
  return input.process
    .run({
      operation: "source-control.discovery.probe",
      command: input.spec.executable,
      args: input.spec.versionArgs,
      cwd: input.cwd,
      timeoutMs: probeTimeoutMs(input.spec),
      maxOutputBytes: 8_000,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.map(
        (result) =>
          ({
            kind: input.spec.kind,
            label: input.spec.label,
            executable: input.spec.executable,
            status: "available" as const,
            version: Option.orElse(firstNonEmptyLine(result.stdout), () =>
              firstNonEmptyLine(result.stderr),
            ),
            installHint: input.spec.installHint,
            detail: Option.none<string>(),
          }) satisfies DiscoveryProbeResult,
      ),
      Effect.catch((cause) =>
        Effect.succeed({
          kind: input.spec.kind,
          label: input.spec.label,
          executable: input.spec.executable,
          status: "missing" as const,
          version: Option.none<string>(),
          installHint: input.spec.installHint,
          detail: detailFromCause(cause),
        } satisfies DiscoveryProbeResult),
      ),
    );
}

export function probeSourceControlProvider(input: {
  readonly spec: SourceControlProviderDiscoverySpec;
  readonly process: SourceControlHost.SourceControlHost["Service"]["process"];
  readonly cwd: string;
}): Effect.Effect<SourceControlProviderDiscoveryItem> {
  if (input.spec.type === "managed-cli") return input.spec.probe(input.cwd);
  if (input.spec.type === "api") {
    return input.spec.probeAuth.pipe(
      Effect.timeoutOption(API_PROBE_TIMEOUT),
      Effect.map(
        Option.getOrElse(() =>
          unknownAuth("The hosting service did not answer in time. Refresh to try again."),
        ),
      ),
      Effect.map(
        (auth) =>
          ({
            kind: input.spec.kind,
            label: input.spec.label,
            status: "available" as const,
            version: Option.none<string>(),
            installHint: input.spec.installHint,
            detail: Option.none<string>(),
            auth,
          }) satisfies SourceControlProviderDiscoveryItem,
      ),
    );
  }

  const spec = input.spec;

  // The auth check does not depend on the version output, so both spawn at once.
  return Effect.all(
    [
      probeCli({
        spec,
        process: input.process,
        cwd: input.cwd,
      }),
      input.process
        .run({
          operation: "source-control.discovery.auth",
          command: spec.executable,
          args: spec.authArgs,
          cwd: input.cwd,
          allowNonZeroExit: true,
          timeoutMs: probeTimeoutMs(spec),
          maxOutputBytes: 8_000,
          appendTruncationMarker: true,
        })
        .pipe(
          Effect.map(spec.parseAuth),
          Effect.catch((cause) =>
            Effect.succeed(unknownAuth(Option.getOrUndefined(detailFromCause(cause)))),
          ),
        ),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(
      ([item, auth]) =>
        ({
          ...item,
          auth:
            item.status === "available"
              ? auth
              : unknownAuth("Hosting integration command was not found on the server PATH."),
        }) satisfies SourceControlProviderDiscoveryItem,
    ),
  );
}

const isVcsProcessSpawnError = Schema.is(VcsProcessSpawnError);

/** The spawner checks cwd first, so ChildProcess NotFound identifies the executable. */
export function isMissingExecutable(error: unknown): boolean {
  return (
    isVcsProcessSpawnError(error) &&
    PlatformError.isPlatformError(error.cause) &&
    error.cause.reason._tag === "NotFound" &&
    error.cause.reason.module === "ChildProcess"
  );
}

class UnknownRemoteUnanswered extends Schema.TaggedError<UnknownRemoteUnanswered>()(
  "UnknownRemoteUnanswered",
  {},
) {}

export interface UnknownRemoteVerdict {
  readonly provider: SourceControlProviderInfo | null;
  readonly settled: boolean;
}

function refineWithSpec(input: {
  readonly spec: SourceControlProviderDiscoverySpec;
  readonly process: SourceControlHost.SourceControlHost["Service"]["process"];
  readonly cwd: string;
  readonly context: SourceControlProvider.SourceControlProviderContext;
}): Effect.Effect<SourceControlProviderInfo | null, Cause.YieldableError> {
  const { spec, context } = input;
  if (spec.type === "managed-cli") {
    return spec.refineUnknownRemote({ cwd: input.cwd, context });
  }
  if (!isCliRemoteRefinementSpec(spec)) return Effect.succeed(null);
  return input.process
    .run({
      operation: "source-control.discovery.refine-unknown-remote",
      command: spec.executable,
      args: spec.remoteRefinementArgs?.(context) ?? spec.authArgs,
      cwd: input.cwd,
      allowNonZeroExit: true,
      timeoutMs: probeTimeoutMs(spec),
      maxOutputBytes: 8_000,
      appendTruncationMarker: true,
    })
    .pipe(
      Effect.catchIf(isMissingExecutable, () => Effect.void),
      Effect.flatMap((auth) => {
        const provider =
          auth === undefined ? null : spec.refineUnknownRemote({ cwd: input.cwd, context, auth });
        return provider === undefined
          ? Effect.fail(new UnknownRemoteUnanswered())
          : Effect.succeed(provider);
      }),
    );
}

export const refineUnknownRemoteProvider = Effect.fn("refineUnknownRemoteProvider")(
  function* (input: {
    readonly specs: ReadonlyArray<SourceControlProviderDiscoverySpec>;
    readonly process: SourceControlHost.SourceControlHost["Service"]["process"];
    readonly cwd: string;
    readonly context: SourceControlProvider.SourceControlProviderContext;
  }): Effect.fn.Return<UnknownRemoteVerdict> {
    const results = yield* Effect.forEach(input.specs, (spec) =>
      refineWithSpec({ ...input, spec }).pipe(Effect.result),
    );
    // An earlier integration that could not answer might have claimed this host.
    let settled = true;
    for (const result of results) {
      if (Result.isFailure(result)) settled = false;
      else if (result.success !== null) return { provider: result.success, settled };
    }
    return { provider: null, settled };
  },
);
