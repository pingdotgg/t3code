import {
  SourceControlRepositoryError,
  type SourceControlDiscoveryResult,
  type VcsDiscoveryItem,
} from "@forma/contracts";
import { Context, Effect, Layer, Option, Schema } from "effect";

import { ServerConfig } from "../config.ts";
import { runProcess } from "../processRunner.ts";
import { SourceControlProviderRegistry } from "./SourceControlProviderRegistry.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";

class VcsDiscoveryProbeError extends Schema.TaggedErrorClass<VcsDiscoveryProbeError>()(
  "VcsDiscoveryProbeError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

function toProbeError(cause: unknown): VcsDiscoveryProbeError {
  return new VcsDiscoveryProbeError({
    detail: cause instanceof Error ? cause.message : "VCS discovery probe failed.",
    cause,
  });
}

const VCS_PROBES = [
  {
    kind: "git",
    label: "Git",
    executable: "git",
    versionArgs: ["--version"],
    implemented: true,
    installHint: "Install Git from https://git-scm.com/downloads or with your package manager.",
  },
  {
    kind: "jj",
    label: "Jujutsu",
    executable: "jj",
    versionArgs: ["--version"],
    implemented: false,
    installHint: "Install Jujutsu with `brew install jj` or from https://github.com/jj-vcs/jj.",
  },
] as const;

export interface SourceControlDiscoveryShape {
  readonly discover: Effect.Effect<SourceControlDiscoveryResult, SourceControlRepositoryError>;
}

export class SourceControlDiscovery extends Context.Service<
  SourceControlDiscovery,
  SourceControlDiscoveryShape
>()("forma/source-control/SourceControlDiscovery") {}

export const SourceControlDiscoveryLive = Layer.effect(
  SourceControlDiscovery,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const sourceControlProviders = yield* SourceControlProviderRegistry;

    const probeVcs = (input: (typeof VCS_PROBES)[number]): Effect.Effect<VcsDiscoveryItem> =>
      Effect.tryPromise({
        try: () =>
          runProcess(input.executable, input.versionArgs, {
            cwd: config.cwd,
            timeoutMs: 5_000,
            maxBufferBytes: 8_000,
            outputMode: "truncate",
          }),
        catch: toProbeError,
      }).pipe(
        Effect.map(
          (result) =>
            ({
              kind: input.kind,
              label: input.label,
              executable: input.executable,
              implemented: input.implemented,
              status: "available" as const,
              version: Option.orElse(
                SourceControlProviderDiscovery.firstNonEmptyLine(result.stdout),
                () => SourceControlProviderDiscovery.firstNonEmptyLine(result.stderr),
              ),
              installHint: input.installHint,
              detail: Option.none<string>(),
            }) satisfies VcsDiscoveryItem,
        ),
        Effect.catch((cause) =>
          Effect.succeed({
            kind: input.kind,
            label: input.label,
            executable: input.executable,
            implemented: input.implemented,
            status: "missing" as const,
            version: Option.none<string>(),
            installHint: input.installHint,
            detail: SourceControlProviderDiscovery.detailFromCause(cause),
          } satisfies VcsDiscoveryItem),
        ),
      );

    return SourceControlDiscovery.of({
      discover: Effect.all({
        versionControlSystems: Effect.all(
          VCS_PROBES.map((entry) => probeVcs(entry)),
          {
            concurrency: "unbounded",
          },
        ),
        sourceControlProviders: sourceControlProviders.discover,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlRepositoryError({
              provider: "unknown",
              operation: "discoverSourceControl",
              detail: "Failed to discover source control tools.",
              cause,
            }),
        ),
      ),
    });
  }),
);
