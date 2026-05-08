import {
  type SourceControlDiscoveryResult,
  type VcsDiscoveryItem,
  type VcsDriverKind,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

interface DiscoveryProbe {
  readonly label: string;
  readonly executable?: string;
  readonly versionArgs?: ReadonlyArray<string>;
  readonly implemented: boolean;
  readonly installHint: string;
}

type VcsProbe = DiscoveryProbe & {
  readonly kind: VcsDriverKind;
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
};

interface DiscoveryProbeResult<Kind extends string> {
  readonly kind: Kind;
  readonly label: string;
  readonly executable?: string;
  readonly implemented: boolean;
  readonly status: "available" | "missing";
  readonly version: Option.Option<string>;
  readonly installHint: string;
  readonly detail: Option.Option<string>;
}

const VCS_PROBES: ReadonlyArray<VcsProbe> = [
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
];

export interface SourceControlDiscoveryShape {
  readonly discover: Effect.Effect<SourceControlDiscoveryResult>;
}

export class SourceControlDiscovery extends Context.Service<
  SourceControlDiscovery,
  SourceControlDiscoveryShape
>()("t3/source-control/SourceControlDiscovery") {}

export const layer = Layer.effect(
  SourceControlDiscovery,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const process = yield* VcsProcess.VcsProcess;
    const sourceControlProviders =
      yield* SourceControlProviderRegistry.SourceControlProviderRegistry;

    const probe = <Kind extends VcsDriverKind>(
      input: DiscoveryProbe & { readonly kind: Kind },
    ): Effect.Effect<DiscoveryProbeResult<Kind>> => {
      const executable = input.executable;
      const versionArgs = input.versionArgs;

      if (!executable || !versionArgs) {
        return Effect.succeed({
          kind: input.kind,
          label: input.label,
          implemented: input.implemented,
          status: "missing" as const,
          version: Option.none<string>(),
          installHint: input.installHint,
          detail: Option.some(input.installHint),
        } satisfies DiscoveryProbeResult<Kind>);
      }

      return process
        .run({
          operation: "source-control.discovery.probe",
          command: executable,
          args: versionArgs,
          cwd: config.cwd,
          timeoutMs: 5_000,
          maxOutputBytes: 8_000,
          truncateOutputAtMaxBytes: true,
        })
        .pipe(
          Effect.map(
            (result) =>
              ({
                kind: input.kind,
                label: input.label,
                executable,
                implemented: input.implemented,
                status: "available" as const,
                version: Option.orElse(
                  SourceControlProviderDiscovery.firstNonEmptyLine(result.stdout),
                  () => SourceControlProviderDiscovery.firstNonEmptyLine(result.stderr),
                ),
                installHint: input.installHint,
                detail: Option.none<string>(),
              }) satisfies DiscoveryProbeResult<Kind>,
          ),
          Effect.catch((cause) =>
            Effect.succeed({
              kind: input.kind,
              label: input.label,
              executable,
              implemented: input.implemented,
              status: "missing" as const,
              version: Option.none<string>(),
              installHint: input.installHint,
              detail: SourceControlProviderDiscovery.detailFromCause(cause),
            } satisfies DiscoveryProbeResult<Kind>),
          ),
        );
    };

    return SourceControlDiscovery.of({
      discover: Effect.all({
        versionControlSystems: Effect.all(
          VCS_PROBES.map((entry) => probe(entry)) as ReadonlyArray<Effect.Effect<VcsDiscoveryItem>>,
          { concurrency: "unbounded" },
        ),
        sourceControlProviders: sourceControlProviders.discover,
      }),
    });
  }),
);
