import * as NodeUtil from "node:util";
import type {
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderInfo,
  SourceControlProviderError,
  SourceControlProviderKind,
  VcsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import type * as SourceControlProvider from "./SourceControlProvider.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";

export interface SourceControlAuthProbeInput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: VcsProcess.VcsProcessOutput["exitCode"];
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

/**
 * One discovery spec's reading of a host, ready to answer for any remote on it.
 *
 * Running the hosting CLIs is what costs; turning their output into a verdict is a pure
 * match. Keeping the two apart lets the expensive half be shared by every checkout of a host
 * while the match still sees the remote it is about - which matters because a Forgejo login
 * mounted on a sub-path claims only the remotes beneath it.
 */
export interface UnknownRemoteProbe {
  readonly match: (
    context: SourceControlProvider.SourceControlProviderContext,
  ) => SourceControlProviderInfo | null;
  /** The spec spoke for the host, either by running or by having no CLI to run. */
  readonly answered: boolean;
}

export type SourceControlCliDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "cli";
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
  readonly authArgs: ReadonlyArray<string>;
  readonly remoteRefinementArgs?: ReadonlyArray<string>;
  readonly probeTimeoutMs?: number;
  readonly parseAuth: (input: SourceControlAuthProbeInput) => SourceControlProviderAuth;
  readonly refineUnknownRemote?: (
    input: SourceControlUnknownRemoteRefinementInput,
  ) => SourceControlProviderInfo | null;
};

export type SourceControlApiDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "api";
  readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
};

export type SourceControlManagedCliDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "managed-cli";
  readonly probe: (cwd: string) => Effect.Effect<SourceControlProviderDiscoveryItem>;
  readonly probeUnknownRemote: (input: {
    readonly cwd: string;
    readonly remoteUrl: string;
  }) => Effect.Effect<UnknownRemoteProbe, SourceControlProviderError>;
};

export type SourceControlProviderDiscoverySpec =
  | SourceControlCliDiscoverySpec
  | SourceControlManagedCliDiscoverySpec
  | SourceControlApiDiscoverySpec;

type SourceControlCliRemoteRefinementSpec = SourceControlCliDiscoverySpec & {
  readonly refineUnknownRemote: NonNullable<SourceControlCliDiscoverySpec["refineUnknownRemote"]>;
};

// Most provider CLIs answer `--version` in well under a second, so a short budget keeps
// discovery snappy. Specs whose CLI is known to be slower can raise it via probeTimeoutMs.
const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

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
  readonly process: VcsProcess.VcsProcess["Service"];
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
  readonly process: VcsProcess.VcsProcess["Service"];
  readonly cwd: string;
}): Effect.Effect<SourceControlProviderDiscoveryItem> {
  if (input.spec.type === "managed-cli") return input.spec.probe(input.cwd);
  if (input.spec.type === "api") {
    return input.spec.probeAuth.pipe(
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

  return probeCli({
    spec,
    process: input.process,
    cwd: input.cwd,
  }).pipe(
    Effect.flatMap((item) => {
      if (item.status !== "available") {
        return Effect.succeed({
          ...item,
          auth: unknownAuth("Hosting integration command was not found on the server PATH."),
        } satisfies SourceControlProviderDiscoveryItem);
      }

      return input.process
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
          Effect.map(
            (result) =>
              ({
                ...item,
                auth: spec.parseAuth(result),
              }) satisfies SourceControlProviderDiscoveryItem,
          ),
          Effect.catch((cause) =>
            Effect.succeed({
              ...item,
              auth: unknownAuth(Option.getOrUndefined(detailFromCause(cause))),
            } satisfies SourceControlProviderDiscoveryItem),
          ),
        );
    }),
  );
}

/**
 * A hosting CLI that is not installed answers for every checkout at once: it claims no
 * remote anywhere. `processRunner` reports the missing executable as a `NotFound` raised by
 * `ChildProcess.spawn`, and an unusable checkout as a `NotFound` raised by
 * `FileSystem.access`, so the two ENOENTs stay apart. Every other failure - a timeout, a
 * permission error, an unreadable stream - says nothing about the host and must not settle
 * it.
 */
function isMissingExecutable(error: VcsError): boolean {
  if (error._tag !== "VcsProcessSpawnError") return false;
  const cause = error.cause;
  if (!(cause instanceof PlatformError.PlatformError)) return false;
  const reason = cause.reason;
  return reason._tag === "NotFound" && reason.module === "ChildProcess";
}

const unansweredProbe: UnknownRemoteProbe = { match: () => null, answered: false };

/** Asks every spec to read the host behind a remote. The answers suit any remote on it. */
export const probeUnknownRemoteProvider = Effect.fn("probeUnknownRemoteProvider")(
  function* (input: {
    readonly specs: ReadonlyArray<SourceControlProviderDiscoverySpec>;
    readonly process: VcsProcess.VcsProcess["Service"];
    readonly cwd: string;
    readonly remoteUrl: string;
  }): Effect.fn.Return<ReadonlyArray<UnknownRemoteProbe>> {
    return yield* Effect.forEach(input.specs, (spec): Effect.Effect<UnknownRemoteProbe> => {
      if (spec.type === "managed-cli") {
        // A managed spec runs its own CLIs. A failure it could not absorb says nothing
        // about the host, so it must not pass for "no provider claims this".
        return spec
          .probeUnknownRemote({ cwd: input.cwd, remoteUrl: input.remoteUrl })
          .pipe(Effect.catch(() => Effect.succeed(unansweredProbe)));
      }
      if (!isCliRemoteRefinementSpec(spec))
        return Effect.succeed({ match: () => null, answered: true });
      return input.process
        .run({
          operation: "source-control.discovery.refine-unknown-remote",
          command: spec.executable,
          args: spec.remoteRefinementArgs ?? spec.authArgs,
          cwd: input.cwd,
          allowNonZeroExit: true,
          timeoutMs: probeTimeoutMs(spec),
          maxOutputBytes: 8_000,
          appendTruncationMarker: true,
        })
        .pipe(
          Effect.map((auth) => ({
            match: (context: SourceControlProvider.SourceControlProviderContext) =>
              spec.refineUnknownRemote({ cwd: input.cwd, context, auth }),
            answered: true,
          })),
          Effect.catch((error) =>
            Effect.succeed({ match: () => null, answered: isMissingExecutable(error) }),
          ),
        );
    });
  },
);

/** The first spec to claim the remote names its provider. */
export function selectUnknownRemoteProvider(
  probes: ReadonlyArray<UnknownRemoteProbe>,
  context: SourceControlProvider.SourceControlProviderContext,
): SourceControlProvider.SourceControlProviderContext {
  for (const probe of probes) {
    const provider = probe.match(context);
    if (provider) return { ...context, provider };
  }
  return context;
}

export const refineUnknownRemoteProvider = Effect.fn("refineUnknownRemoteProvider")(
  function* (input: {
    readonly specs: ReadonlyArray<SourceControlProviderDiscoverySpec>;
    readonly process: VcsProcess.VcsProcess["Service"];
    readonly cwd: string;
    readonly context: SourceControlProvider.SourceControlProviderContext | null;
  }) {
    const context = input.context;
    if (context === null || context.provider.kind !== "unknown") return context;
    const probes = yield* probeUnknownRemoteProvider({
      specs: input.specs,
      process: input.process,
      cwd: input.cwd,
      remoteUrl: context.remoteUrl,
    });
    return selectUnknownRemoteProvider(probes, context);
  },
);
