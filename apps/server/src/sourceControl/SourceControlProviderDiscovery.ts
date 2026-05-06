import type {
  SourceControlProviderAuth,
  SourceControlProviderDiscoveryItem,
  SourceControlProviderKind,
} from "@forma/contracts";
import { Effect, Option, Schema } from "effect";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";

class SourceControlDiscoveryProbeError extends Schema.TaggedErrorClass<SourceControlDiscoveryProbeError>()(
  "SourceControlDiscoveryProbeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

function toProbeError(cause: unknown): SourceControlDiscoveryProbeError {
  return new SourceControlDiscoveryProbeError({
    detail: cause instanceof Error ? cause.message : "Source control discovery probe failed.",
    cause,
  });
}

export interface SourceControlAuthProbeInput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: ProcessRunResult["code"];
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

function optionalString(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
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
    account: optionalString(input.account),
    host: optionalString(input.host),
    detail: optionalString(input.detail),
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

export function probeSourceControlProvider(input: {
  readonly spec: SourceControlCliDiscoverySpec;
  readonly cwd: string;
}): Effect.Effect<SourceControlProviderDiscoveryItem> {
  return Effect.tryPromise({
    try: () =>
      runProcess(input.spec.executable, input.spec.versionArgs, {
        cwd: input.cwd,
        timeoutMs: 5_000,
        maxBufferBytes: 8_000,
        outputMode: "truncate",
      }),
    catch: toProbeError,
  }).pipe(
    Effect.flatMap((versionResult) =>
      Effect.tryPromise({
        try: () =>
          runProcess(input.spec.executable, input.spec.authArgs, {
            cwd: input.cwd,
            allowNonZeroExit: true,
            timeoutMs: 5_000,
            maxBufferBytes: 8_000,
            outputMode: "truncate",
          }),
        catch: toProbeError,
      }).pipe(
        Effect.map(
          (authResult) =>
            ({
              kind: input.spec.kind,
              label: input.spec.label,
              executable: input.spec.executable,
              status: "available" as const,
              version: Option.orElse(firstNonEmptyLine(versionResult.stdout), () =>
                firstNonEmptyLine(versionResult.stderr),
              ),
              installHint: input.spec.installHint,
              detail: Option.none<string>(),
              auth: input.spec.parseAuth({
                stdout: authResult.stdout,
                stderr: authResult.stderr,
                exitCode: authResult.code,
              }),
            }) satisfies SourceControlProviderDiscoveryItem,
        ),
        Effect.catch((cause) =>
          Effect.succeed({
            kind: input.spec.kind,
            label: input.spec.label,
            executable: input.spec.executable,
            status: "available" as const,
            version: Option.orElse(firstNonEmptyLine(versionResult.stdout), () =>
              firstNonEmptyLine(versionResult.stderr),
            ),
            installHint: input.spec.installHint,
            detail: Option.none<string>(),
            auth: unknownAuth(Option.getOrUndefined(detailFromCause(cause))),
          } satisfies SourceControlProviderDiscoveryItem),
        ),
      ),
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
        auth: unknownAuth("Hosting integration command was not found on the server PATH."),
      } satisfies SourceControlProviderDiscoveryItem),
    ),
  );
}
