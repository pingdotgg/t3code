import type {
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { Effect, Option } from "effect";

import type * as VcsProcess from "../vcs/VcsProcess.ts";

export interface SourceControlAuthProbeInput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: VcsProcess.VcsProcessOutput["exitCode"];
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
  readonly parseAuth: (input: SourceControlAuthProbeInput) => SourceControlProviderAuth;
};

export type SourceControlApiDiscoverySpec = SourceControlDiscoverySpecBase & {
  readonly type: "api";
  readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
};

export type SourceControlProviderDiscoverySpec =
  | SourceControlCliDiscoverySpec
  | SourceControlApiDiscoverySpec;

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
  const line = text
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

export function unknownAuth(detail?: string): SourceControlProviderAuth {
  return providerAuth({ status: "unknown", detail });
}

export function combinedAuthOutput(input: SourceControlAuthProbeInput): string {
  return [input.stdout, input.stderr].filter((entry) => entry.trim().length > 0).join("\n");
}

function sanitizedAuthLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !/^[-\s]*token(?:\s+scopes?)?:/iu.test(entry));
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

function probeCli(input: {
  readonly spec: SourceControlCliDiscoverySpec;
  readonly process: VcsProcess.VcsProcessShape;
  readonly cwd: string;
}): Effect.Effect<DiscoveryProbeResult> {
  return input.process
    .run({
      operation: "source-control.discovery.probe",
      command: input.spec.executable,
      args: input.spec.versionArgs,
      cwd: input.cwd,
      timeoutMs: 5_000,
      maxOutputBytes: 8_000,
      truncateOutputAtMaxBytes: true,
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
  readonly process: VcsProcess.VcsProcessShape;
  readonly cwd: string;
}): Effect.Effect<SourceControlProviderDiscoveryItem> {
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
          timeoutMs: 5_000,
          maxOutputBytes: 8_000,
          truncateOutputAtMaxBytes: true,
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
