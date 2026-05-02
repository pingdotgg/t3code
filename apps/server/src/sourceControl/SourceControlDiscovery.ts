import {
  type SourceControlProviderAuth,
  type SourceControlDiscoveryResult,
  type SourceControlProviderDiscoveryItem,
  type SourceControlProviderKind,
  type VcsDiscoveryItem,
  type VcsDriverKind,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Option } from "effect";

import { ServerConfig } from "../config.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";

interface DiscoveryProbe {
  readonly label: string;
  readonly executable: string;
  readonly versionArgs: ReadonlyArray<string>;
  readonly implemented: boolean;
  readonly installHint: string;
}

type VcsProbe = DiscoveryProbe & {
  readonly kind: VcsDriverKind;
};

type ProviderProbe = DiscoveryProbe & {
  readonly kind: SourceControlProviderKind;
  readonly authArgs: ReadonlyArray<string>;
  readonly parseAuth: (input: AuthProbeInput) => SourceControlProviderAuth;
};

interface AuthProbeInput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: VcsProcess.VcsProcessOutput["exitCode"];
}

interface DiscoveryProbeResult<Kind extends string> {
  readonly kind: Kind;
  readonly label: string;
  readonly executable: string;
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

const SOURCE_CONTROL_PROVIDER_PROBES: ReadonlyArray<ProviderProbe> = [
  {
    kind: "github",
    label: "GitHub",
    executable: "gh",
    versionArgs: ["--version"],
    authArgs: ["auth", "status"],
    parseAuth: parseGitHubAuth,
    implemented: true,
    installHint: "Install GitHub CLI with `brew install gh` or from https://cli.github.com/.",
  },
  {
    kind: "gitlab",
    label: "GitLab",
    executable: "glab",
    versionArgs: ["--version"],
    authArgs: ["auth", "status"],
    parseAuth: parseGitLabAuth,
    implemented: false,
    installHint:
      "Install GitLab CLI with `brew install glab` or from https://gitlab.com/gitlab-org/cli.",
  },
  {
    kind: "azure-devops",
    label: "Azure DevOps",
    executable: "az",
    versionArgs: ["--version"],
    authArgs: ["account", "show", "--query", "user.name", "-o", "tsv"],
    parseAuth: parseAzureAuth,
    implemented: false,
    installHint:
      "Install Azure CLI with `brew install azure-cli`, then add Azure DevOps support with `az extension add --name azure-devops`.",
  },
  {
    kind: "bitbucket",
    label: "Bitbucket",
    executable: "bb",
    versionArgs: ["--version"],
    authArgs: ["auth", "status"],
    parseAuth: parseBitbucketAuth,
    implemented: false,
    installHint: "Install a Bitbucket CLI (`bb`) and authenticate it for your Bitbucket workspace.",
  },
];

function firstNonEmptyLine(text: string): Option.Option<string> {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined ? Option.none() : Option.some(line);
}

function detailFromCause(cause: unknown): Option.Option<string> {
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

function providerAuth(input: {
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

function combinedAuthOutput(input: AuthProbeInput): string {
  return [input.stdout, input.stderr].filter((entry) => entry.trim().length > 0).join("\n");
}

function sanitizedAuthLines(text: string): ReadonlyArray<string> {
  return text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => !/^[-\s]*token(?:\s+scopes?)?:/iu.test(entry));
}

function firstSafeAuthLine(text: string): string | undefined {
  return sanitizedAuthLines(text)[0];
}

function parseCliHost(text: string): string | undefined {
  return sanitizedAuthLines(text)
    .map((line) => line.replace(/^[^a-z0-9]+/iu, ""))
    .find((line) => /^[a-z0-9][a-z0-9.-]*(?::\d+)?$/iu.test(line));
}

function matchFirst(text: string, patterns: ReadonlyArray<RegExp>): string | undefined {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value && value.length > 0) return value;
  }
  return undefined;
}

function parseGitHubAuth(input: AuthProbeInput): SourceControlProviderAuth {
  const output = combinedAuthOutput(input);
  const account = matchFirst(output, [
    /Logged in to .* account\s+([^\s(]+)/iu,
    /Logged in to .* as\s+([^\s(]+)/iu,
  ]);
  const host = parseCliHost(output);

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      host,
      detail: firstSafeAuthLine(output) ?? "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  if (account) {
    return providerAuth({ status: "authenticated", account, host });
  }

  return providerAuth({
    status: "unknown",
    host,
    detail: firstSafeAuthLine(output) ?? "GitHub CLI auth status could not be parsed.",
  });
}

function parseGitLabAuth(input: AuthProbeInput): SourceControlProviderAuth {
  const output = combinedAuthOutput(input);
  const account = matchFirst(output, [
    /Logged in to .* as\s+([^\s(]+)/iu,
    /Logged in to .* account\s+([^\s(]+)/iu,
    /account:\s*([^\s(]+)/iu,
  ]);
  const host = parseCliHost(output);

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      host,
      detail: firstSafeAuthLine(output) ?? "Run `glab auth login` to authenticate GitLab CLI.",
    });
  }

  if (account) {
    return providerAuth({ status: "authenticated", account, host });
  }

  return providerAuth({
    status: "unknown",
    host,
    detail: firstSafeAuthLine(output) ?? "GitLab CLI auth status could not be parsed.",
  });
}

function parseAzureAuth(input: AuthProbeInput): SourceControlProviderAuth {
  const account = input.stdout.trim().split(/\r?\n/)[0]?.trim();

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      detail:
        firstSafeAuthLine(combinedAuthOutput(input)) ?? "Run `az login` to authenticate Azure CLI.",
    });
  }

  if (account && account.length > 0) {
    return providerAuth({ status: "authenticated", account, host: "dev.azure.com" });
  }

  return providerAuth({
    status: "unknown",
    host: "dev.azure.com",
    detail: "Azure CLI account status could not be parsed.",
  });
}

function parseBitbucketAuth(input: AuthProbeInput): SourceControlProviderAuth {
  const output = combinedAuthOutput(input);
  const account = matchFirst(output, [
    /Logged in to .* as\s+([^\s(]+)/iu,
    /Logged in as\s+([^\s(]+)/iu,
    /account:\s*([^\s(]+)/iu,
    /user:\s*([^\s(]+)/iu,
    /username:\s*([^\s(]+)/iu,
  ]);
  const host = parseCliHost(output) ?? "bitbucket.org";

  if (input.exitCode !== 0) {
    return providerAuth({
      status: "unauthenticated",
      host,
      detail:
        firstSafeAuthLine(output) ?? "Authenticate the Bitbucket CLI before enabling Bitbucket.",
    });
  }

  if (account) {
    return providerAuth({ status: "authenticated", account, host });
  }

  return providerAuth({
    status: "unknown",
    host,
    detail: firstSafeAuthLine(output) ?? "Bitbucket CLI auth status could not be parsed.",
  });
}

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

    const probe = <Kind extends VcsDriverKind | SourceControlProviderKind>(
      input: DiscoveryProbe & { readonly kind: Kind },
    ): Effect.Effect<DiscoveryProbeResult<Kind>> =>
      process
        .run({
          operation: "source-control.discovery.probe",
          command: input.executable,
          args: input.versionArgs,
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
                executable: input.executable,
                implemented: input.implemented,
                status: "available" as const,
                version: Option.orElse(firstNonEmptyLine(result.stdout), () =>
                  firstNonEmptyLine(result.stderr),
                ),
                installHint: input.installHint,
                detail: Option.none<string>(),
              }) satisfies DiscoveryProbeResult<Kind>,
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
              detail: detailFromCause(cause),
            } satisfies DiscoveryProbeResult<Kind>),
          ),
        );

    const probeProvider = (input: ProviderProbe) =>
      probe(input).pipe(
        Effect.flatMap((item) => {
          if (item.status !== "available") {
            return Effect.succeed({
              ...item,
              auth: unknownAuth("CLI is not installed."),
            } satisfies SourceControlProviderDiscoveryItem);
          }

          return process
            .run({
              operation: "source-control.discovery.auth",
              command: input.executable,
              args: input.authArgs,
              cwd: config.cwd,
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
                    auth: input.parseAuth(result),
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

    return SourceControlDiscovery.of({
      discover: Effect.all({
        versionControlSystems: Effect.all(
          VCS_PROBES.map((entry) => probe(entry)) as ReadonlyArray<Effect.Effect<VcsDiscoveryItem>>,
          { concurrency: "unbounded" },
        ),
        sourceControlProviders: Effect.all(
          SOURCE_CONTROL_PROVIDER_PROBES.map((entry) => probeProvider(entry)) as ReadonlyArray<
            Effect.Effect<SourceControlProviderDiscoveryItem>
          >,
          { concurrency: "unbounded" },
        ),
      }),
    });
  }),
);
