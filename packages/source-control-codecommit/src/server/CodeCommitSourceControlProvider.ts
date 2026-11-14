import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type ChangeRequest,
} from "@t3tools/contracts";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  probeSourceControlProvider,
  providerAuth,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as CodeCommitCli from "./CodeCommitCli.ts";
import { CodeCommitError } from "./CodeCommitCli.ts";
import {
  settings,
  parseCodeCommitRemote,
  parseCodeCommitHelperRemote,
  parseCodeCommitConsoleUrl,
  codeCommitRepositoryKey,
  codeCommitChangeRequestUrl,
  codeCommitRepositoryUrl,
} from "../shared/definition.ts";

const kind = SourceControlProviderKind.make("aws-codecommit");
const repositorySchema = Schema.Struct({
  repositoryMetadata: Schema.Struct({
    repositoryName: Schema.String,
    accountId: Schema.String,
    Arn: Schema.String,
    cloneUrlHttp: Schema.String,
    cloneUrlSsh: Schema.String,
    defaultBranch: Schema.optional(Schema.String),
  }),
});
const prSchema = Schema.Struct({
  pullRequest: Schema.Struct({
    pullRequestId: Schema.String,
    title: Schema.String,
    pullRequestStatus: Schema.Literals(["OPEN", "CLOSED"]),
    lastActivityDate: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    pullRequestTargets: Schema.Array(
      Schema.Struct({
        repositoryName: Schema.String,
        sourceReference: Schema.String,
        destinationReference: Schema.String,
        sourceCommit: Schema.optional(Schema.String),
        mergeMetadata: Schema.optional(
          Schema.Struct({ isMerged: Schema.optional(Schema.Boolean) }),
        ),
      }),
    ),
  }),
});
const listSchema = Schema.Struct({
  pullRequestIds: Schema.Array(Schema.String),
  nextToken: Schema.optional(Schema.String),
});
const callerSchema = Schema.Struct({ Account: Schema.String });

const isCodeCommitError = Schema.is(CodeCommitError);
const encodeCreatePullRequest = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      title: Schema.String,
      description: Schema.String,
      targets: Schema.Array(
        Schema.Struct({
          repositoryName: Schema.String,
          sourceReference: Schema.String,
          destinationReference: Schema.String,
        }),
      ),
    }),
  ),
);
type Remote = NonNullable<ReturnType<typeof parseCodeCommitRemote>>;

export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const fs = yield* FileSystem.FileSystem;
  const { execute, request, withConfig, provideConfig, configuration } = yield* CodeCommitCli.make;
  const resolveRemote = Effect.fn("CodeCommit.resolveRemote")(function* (url: string, cwd: string) {
    const remote = parseCodeCommitRemote(url);
    if (remote) return remote;
    const helper = parseCodeCommitHelperRemote(url);
    if (!helper) return yield* new CodeCommitError({ reason: "Unsupported CodeCommit remote" });
    const config = yield* configuration;
    if (helper.profile && config.profile !== helper.profile)
      return yield* new CodeCommitError({
        reason: "CodeCommit helper profile conflicts with selected AWS profile",
      });
    const region = helper.region ?? (helper.profile ? "" : config.region);
    const inferred = region || (yield* execute(cwd, ["configure", "get", "region"])).trim();
    const resolved = parseCodeCommitRemote(
      `https://git-codecommit.${inferred}.${inferred.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}/v1/repos/${helper.repository}`,
    );
    if (!resolved)
      return yield* new CodeCommitError({
        reason: "CodeCommit helper region unavailable or invalid",
      });
    return resolved;
  });
  const primaryRemote = Effect.fn("CodeCommit.primaryRemote")(function* (cwd: string) {
    const remotes = yield* yield* host.git.remotes(cwd);
    const entry =
      remotes.remotes.find((item) => item.isPrimary) ??
      remotes.remotes.find((item) => item.name === "origin");
    if (!entry) return yield* new CodeCommitError({ reason: "CodeCommit remote missing" });
    return entry;
  });
  const resolve = Effect.fn("CodeCommit.resolve")(function* (input: {
    cwd: string;
    context?: SourceControlProvider.SourceControlProviderContext;
  }) {
    if (input.context) {
      const remote = yield* resolveRemote(input.context.remoteUrl, input.cwd);
      return {
        ...remote,
        remoteName: input.context.remoteName,
        remoteUrl: input.context.remoteUrl,
      };
    }
    const entry = yield* primaryRemote(input.cwd);
    const remote = yield* resolveRemote(entry.url, input.cwd);
    return { ...remote, remoteName: entry.name, remoteUrl: entry.url };
  });
  const validateRepository = Effect.fn("CodeCommit.validateRepository")(function* (
    repo: typeof repositorySchema.Type.repositoryMetadata,
    remote: { readonly repository: string; readonly region?: string },
  ) {
    const http = parseCodeCommitRemote(repo.cloneUrlHttp);
    const ssh = parseCodeCommitRemote(repo.cloneUrlSsh);
    const arn = /^arn:(aws|aws-cn|aws-us-gov):codecommit:([a-z0-9-]+):(\d{12}):(.+)$/u.exec(
      repo.Arn,
    );
    if (
      !arn ||
      !http ||
      !ssh ||
      !/^\d{12}$/u.test(repo.accountId) ||
      arn[3] !== repo.accountId ||
      arn[4] !== remote.repository ||
      repo.repositoryName !== remote.repository ||
      http.repository !== remote.repository ||
      ssh.repository !== remote.repository ||
      http.region !== arn[2] ||
      ssh.region !== arn[2] ||
      http.partition !== arn[1] ||
      ssh.partition !== arn[1] ||
      (remote.region && remote.region !== arn[2])
    )
      return yield* new CodeCommitError({ reason: "Invalid repository metadata" });
    return repo;
  });
  const getRepository = Effect.fn("CodeCommit.getRepository")(function* (
    cwd: string,
    remote: { readonly repository: string; readonly region?: string },
  ) {
    const result = yield* request(
      cwd,
      ["codecommit", "get-repository", "--repository-name", remote.repository],
      repositorySchema,
      remote.region,
    );
    return yield* validateRepository(result.repositoryMetadata, remote);
  });
  const getPR = Effect.fn("CodeCommit.getPR")(function* (
    cwd: string,
    remote: Remote,
    reference: string,
    repositoryKey?: string,
  ) {
    let number = reference.trim();
    if (!/^\d+$/u.test(number)) {
      const url = URL.parse(number);
      if (!url) return yield* new CodeCommitError({ reason: "Invalid pull request reference" });
      const parsed = parseCodeCommitConsoleUrl(url);
      if (
        !parsed ||
        parsed.region !== remote.region ||
        parsed.partition !== remote.partition ||
        parsed.repository !== remote.repository ||
        parsed.number === undefined
      )
        return yield* new CodeCommitError({ reason: "Pull request repository mismatch" });
      number = String(parsed.number);
    }
    if (!/^[1-9]\d*$/u.test(number) || !Number.isSafeInteger(Number(number)))
      return yield* new CodeCommitError({ reason: "Invalid pull request reference" });
    const result = yield* request(
      cwd,
      ["codecommit", "get-pull-request", "--pull-request-id", number],
      prSchema,
      remote.region,
    );
    const target = result.pullRequest.pullRequestTargets.find(
      (entry) => entry.repositoryName === remote.repository,
    );
    if (!target || result.pullRequest.pullRequestId !== number)
      return yield* new CodeCommitError({ reason: "Pull request repository mismatch" });
    const pr = result.pullRequest;
    const state =
      pr.pullRequestStatus === "OPEN"
        ? "open"
        : target.mergeMetadata?.isMerged
          ? "merged"
          : "closed";
    const summary: ChangeRequest = {
      provider: kind,
      repositoryKey:
        repositoryKey ??
        codeCommitRepositoryKey({
          ...remote,
          accountId: (yield* getRepository(cwd, remote)).accountId,
        }),
      number: Number(number),
      title: pr.title,
      url: codeCommitChangeRequestUrl(remote, Number(number)),
      baseRefName: target.destinationReference.replace(/^refs\/heads\//u, ""),
      headRefName: target.sourceReference.replace(/^refs\/heads\//u, ""),
      ...(target.sourceCommit ? { headSha: target.sourceCommit } : {}),
      state,
      updatedAt:
        pr.lastActivityDate === undefined
          ? Option.none()
          : Option.map(
              DateTime.make(
                typeof pr.lastActivityDate === "number"
                  ? pr.lastActivityDate * 1000
                  : pr.lastActivityDate,
              ),
              DateTime.toUtc,
            ),
      isCrossRepository: false,
      headRepositoryNameWithOwner: remote.repository,
    };
    return summary;
  });
  const wrap = <A, E, R>(
    cwd: string,
    operation: string,
    effect: Effect.Effect<A, E, R>,
    remoteUrl?: string,
    discoverRemote = true,
  ) =>
    withConfig(
      Effect.gen(function* () {
        const config = yield* configuration;
        const effectiveUrl =
          remoteUrl ??
          (discoverRemote
            ? yield* primaryRemote(cwd).pipe(
                Effect.map((remote) => remote.url),
                Effect.orElseSucceed(() => undefined),
              )
            : undefined);
        const helper = effectiveUrl ? parseCodeCommitHelperRemote(effectiveUrl) : null;
        if (helper?.profile && config.profile && helper.profile !== config.profile)
          return yield* new CodeCommitError({
            reason: "CodeCommit helper profile conflicts with selected AWS profile",
          });
        return yield* provideConfig(effect, {
          ...config,
          profile: helper?.profile ?? config.profile,
        });
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new SourceControlProviderError({
            provider: kind,
            operation,
            cwd,
            detail: isCodeCommitError(cause)
              ? cause.reason
              : typeof cause === "object" &&
                  cause !== null &&
                  "failureKind" in cause &&
                  cause.failureKind === "authentication"
                ? "AWS credentials are unavailable or expired, or access was denied. Check your AWS profile and permissions."
                : `CodeCommit ${operation} failed.`,
            cause,
          }),
      ),
    );
  const cloneUrls = (repo: typeof repositorySchema.Type.repositoryMetadata) => ({
    nameWithOwner: repo.repositoryName,
    url: repo.cloneUrlHttp,
    sshUrl: repo.cloneUrlSsh,
  });
  return SourceControlProvider.SourceControlProvider.of({
    kind,
    headBranchProbe: ({ headSelectors }) => ({
      headSelectors: headSelectors.filter((selector) => !selector.includes(":")),
      limit: 100,
    }),
    repositoryIdentityCacheKey: host.settings.get.pipe(
      Effect.map((current) => {
        const config = readSourceControlHostSettings(settings, current.sourceControlHosts[kind]);
        return `${config.profile.length}:${config.profile}${config.region}`;
      }),
      Effect.orElseSucceed(() => "unavailable"),
    ),
    repositoryNameFromRemoteUrl: (url) =>
      parseCodeCommitRemote(url)?.repository ??
      parseCodeCommitHelperRemote(url)?.repository ??
      null,
    refineRepositoryIdentity: Effect.fn("CodeCommit.refineRepositoryIdentity")(function* ({
      identity,
    }) {
      if (
        !parseCodeCommitRemote(identity.locator.remoteUrl) &&
        !parseCodeCommitHelperRemote(identity.locator.remoteUrl)
      )
        return identity;
      if (!identity.rootPath) return null;
      const resolved = yield* withConfig(
        Effect.gen(function* () {
          const config = yield* configuration;
          const helper = parseCodeCommitHelperRemote(identity.locator.remoteUrl);
          if (helper?.profile && config.profile && helper.profile !== config.profile) return null;
          return yield* provideConfig(
            Effect.gen(function* () {
              const remote = yield* resolveRemote(identity.locator.remoteUrl, identity.rootPath!);
              const repo = yield* getRepository(identity.rootPath!, remote);
              return { remote, repo };
            }),
            { ...config, profile: helper?.profile ?? config.profile },
          );
        }),
      ).pipe(Effect.option);
      if (Option.isNone(resolved) || !resolved.value) return null;
      const { remote, repo } = resolved.value;
      return {
        ...identity,
        canonicalKey: codeCommitRepositoryKey({ ...remote, accountId: repo.accountId }),
        webUrl: codeCommitRepositoryUrl(remote),
        name: remote.repository,
        displayName: remote.repository,
        owner: repo.accountId,
      };
    }),
    listChangeRequests: Effect.fn("CodeCommit.listChangeRequests")(function (input) {
      return wrap(
        input.cwd,
        "listChangeRequests",
        Effect.gen(function* () {
          const remote = yield* resolve(input);
          const matches: ChangeRequest[] = [];
          let token: string | undefined;
          if (
            (input.source?.repository && input.source.repository !== remote.repository) ||
            input.source?.owner ||
            SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)
          )
            return yield* new CodeCommitError({
              reason: "Cross-repository pull requests are unsupported",
            });
          const repo = yield* getRepository(input.cwd, remote);
          const repositoryKey = codeCommitRepositoryKey({ ...remote, accountId: repo.accountId });
          const seen = new Set<string>();
          const limit = Math.max(1, Math.min(input.limit ?? 20, 100));
          do {
            const page = yield* request(
              input.cwd,
              [
                "codecommit",
                "list-pull-requests",
                "--repository-name",
                remote.repository,
                "--no-paginate",
                "--max-results",
                String(limit),
                ...(input.state === "open"
                  ? ["--pull-request-status", "OPEN"]
                  : input.state === "closed" || input.state === "merged"
                    ? ["--pull-request-status", "CLOSED"]
                    : []),
                ...(token ? ["--next-token", token] : []),
              ],
              listSchema,
              remote.region,
            );
            const details = yield* Effect.forEach(
              page.pullRequestIds,
              (id) => getPR(input.cwd, remote, id, repositoryKey),
              { concurrency: 5 },
            );
            matches.push(
              ...details.filter(
                (pr) =>
                  (input.state === "all" || pr.state === input.state) &&
                  pr.headRefName === SourceControlProvider.sourceBranch(input),
              ),
            );
            token = page.nextToken;
            if (token && seen.has(token))
              return yield* new CodeCommitError({ reason: "Invalid pagination token" });
            if (token) seen.add(token);
          } while (token && matches.length < limit);
          return matches.slice(0, limit);
        }),
        input.context?.remoteUrl,
      );
    }),
    getChangeRequest: Effect.fn("CodeCommit.getChangeRequest")(function (input) {
      return wrap(
        input.cwd,
        "getChangeRequest",
        Effect.gen(function* () {
          return yield* getPR(input.cwd, yield* resolve(input), input.reference);
        }),
        input.context?.remoteUrl,
      );
    }),
    createChangeRequest: Effect.fn("CodeCommit.createChangeRequest")(function (input) {
      return wrap(
        input.cwd,
        "createChangeRequest",
        Effect.gen(function* () {
          const remote = yield* resolve(input);
          if (
            (input.source?.repository && input.source.repository !== remote.repository) ||
            (input.target?.repository && input.target.repository !== remote.repository) ||
            input.source?.owner ||
            input.target?.owner ||
            SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)
          )
            return yield* new CodeCommitError({
              reason: "Cross-repository pull requests are unsupported",
            });
          const description = yield* fs.readFileString(input.bodyFile);
          const payload = yield* encodeCreatePullRequest({
            title: input.title,
            description,
            targets: [
              {
                repositoryName: remote.repository,
                sourceReference: SourceControlProvider.sourceBranch(input),
                destinationReference: input.target?.refName ?? input.baseRefName,
              },
            ],
          });
          yield* execute(
            input.cwd,
            ["codecommit", "create-pull-request", "--cli-input-json", payload],
            remote.region,
          );
        }),
        input.context?.remoteUrl,
      );
    }),
    getRepositoryCloneUrls: Effect.fn("CodeCommit.getRepositoryCloneUrls")(function (input) {
      return wrap(
        input.cwd,
        "getRepositoryCloneUrls",
        Effect.gen(function* () {
          const helper = parseCodeCommitHelperRemote(input.repository);
          const explicit = helper
            ? yield* resolveRemote(input.repository, input.cwd)
            : parseCodeCommitRemote(input.repository);
          const repository = explicit?.repository ?? input.repository;
          if (!/^[\w.-]+$/u.test(repository))
            return yield* new CodeCommitError({ reason: "Invalid repository name" });
          let remote = explicit
            ? Option.some({ ...explicit, remoteUrl: input.repository })
            : yield* resolve(input).pipe(Effect.option);
          if (input.host) {
            const requested =
              parseCodeCommitRemote(`https://${input.host}/v1/repos/${repository}`) ??
              parseCodeCommitConsoleUrl(
                new URL(
                  `https://${input.host}/codesuite/codecommit/repositories/${repository}/browse${Option.isSome(remote) ? `?region=${remote.value.region}` : ""}`,
                ),
              );
            if (!requested || (Option.isSome(remote) && requested.host !== remote.value.host))
              return yield* new CodeCommitError({ reason: "Repository host mismatch" });
            remote = Option.some({
              ...requested,
              remoteUrl: Option.isSome(remote)
                ? remote.value.remoteUrl
                : `https://${requested.host}/v1/repos/${repository}`,
            });
          }
          if (Option.isNone(remote) && (input.host || input.context))
            return yield* new CodeCommitError({ reason: "Repository host unavailable" });
          const urls = cloneUrls(
            yield* getRepository(input.cwd, {
              repository,
              ...(Option.isSome(remote) ? { region: remote.value.region } : {}),
            }),
          );
          const transport = Option.isSome(remote) ? URL.parse(remote.value.remoteUrl) : null;
          if (
            transport?.protocol === "https:" &&
            transport.hostname.startsWith("git-codecommit-fips.")
          )
            urls.url = urls.url.replace("https://git-codecommit.", "https://git-codecommit-fips.");
          const cloneHelper =
            helper ??
            (Option.isSome(remote) ? parseCodeCommitHelperRemote(remote.value.remoteUrl) : null);
          if (!cloneHelper) return urls;
          const helperUrl = `codecommit${cloneHelper.region ? `::${cloneHelper.region}` : ""}://${cloneHelper.profile ? `${cloneHelper.profile}@` : ""}${repository}`;
          return { ...urls, url: helperUrl, sshUrl: helperUrl };
        }),
        parseCodeCommitHelperRemote(input.repository)
          ? input.repository
          : (input.context?.remoteUrl ??
              (parseCodeCommitRemote(input.repository) ? input.repository : undefined)),
      );
    }),
    createRepository: Effect.fn("CodeCommit.createRepository")(function (input) {
      return wrap(
        input.cwd,
        "createRepository",
        Effect.gen(function* () {
          if (input.visibility !== "private" || !/^[\w.-]+$/u.test(input.repository))
            return yield* new CodeCommitError({
              reason: "CodeCommit repositories must be private and have a valid name",
            });
          const result = yield* request(
            input.cwd,
            ["codecommit", "create-repository", "--repository-name", input.repository],
            repositorySchema,
          );
          return cloneUrls(
            yield* validateRepository(result.repositoryMetadata, { repository: input.repository }),
          );
        }),
        undefined,
        false,
      );
    }),
    getDefaultBranch: Effect.fn("CodeCommit.getDefaultBranch")(function (input) {
      return wrap(
        input.cwd,
        "getDefaultBranch",
        Effect.gen(function* () {
          const remote = yield* resolve(input);
          return (yield* getRepository(input.cwd, remote)).defaultBranch ?? null;
        }),
        input.context?.remoteUrl,
      );
    }),
    checkoutChangeRequest: Effect.fn("CodeCommit.checkoutChangeRequest")(function (input) {
      return wrap(
        input.cwd,
        "checkoutChangeRequest",
        Effect.gen(function* () {
          const remote = yield* resolve(input);
          const pr = yield* getPR(input.cwd, remote, input.reference);
          const branch = pr.headRefName;
          const exists = (yield* host.git.listLocalBranchNames(input.cwd)).includes(branch);
          if (!input.force && !exists)
            yield* host.git.fetchRemoteBranch({
              cwd: input.cwd,
              remoteName: remote.remoteName,
              remoteBranch: branch,
              localBranch: branch,
            });
          else
            yield* host.git.fetchRemoteTrackingBranch({
              cwd: input.cwd,
              remoteName: remote.remoteName,
              remoteBranch: branch,
            });
          if (input.force)
            yield* host.git.execute({
              operation: "CodeCommit.checkoutChangeRequest",
              cwd: input.cwd,
              args: [
                "checkout",
                "--no-track",
                "-B",
                branch,
                `refs/remotes/${remote.remoteName}/${branch}`,
                "--",
              ],
            });
          yield* host.git.setBranchUpstream({
            cwd: input.cwd,
            branch,
            remoteName: remote.remoteName,
            remoteBranch: branch,
          });
          yield* Effect.scoped(host.git.switchRef({ cwd: input.cwd, refName: branch }));
        }),
        input.context?.remoteUrl,
      );
    }),
  });
});

export const makeDiscovery = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const cli: SourceControlCliDiscoverySpec = {
    type: "cli",
    kind,
    label: "AWS CodeCommit",
    executable: "aws",
    versionArgs: ["--version"],
    authArgs: [
      "sts",
      "get-caller-identity",
      "--output",
      "json",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    parseAuth: (input) => {
      const result = Schema.decodeOption(Schema.fromJsonString(callerSchema))(input.stdout);
      return Option.isSome(result)
        ? providerAuth({
            status: "authenticated",
            account: result.value.Account,
            detail: "AWS credentials are available; CodeCommit permissions are checked when used.",
          })
        : providerAuth({ status: input.exitCode === 0 ? "unknown" : "unauthenticated" });
    },
    installHint: "Install AWS CLI v2 and configure a profile or role.",
  };
  return {
    type: "managed-cli",
    kind,
    label: cli.label,
    installHint: cli.installHint,
    probe: (cwd: string) =>
      host.settings.get.pipe(
        Effect.flatMap((current) => {
          const config = readSourceControlHostSettings(settings, current.sourceControlHosts[kind]);
          return probeSourceControlProvider({
            cwd,
            spec: {
              ...cli,
              authArgs: [
                ...cli.authArgs,
                ...(config.profile ? ["--profile", config.profile] : []),
                ...(config.region ? ["--region", config.region] : []),
              ],
            },
            process: host.process,
          });
        }),
        Effect.orElseSucceed(() => ({
          kind,
          label: cli.label,
          executable: cli.executable,
          status: "available" as const,
          version: Option.none(),
          installHint: cli.installHint,
          detail: Option.some("Could not read AWS settings."),
          auth: providerAuth({ status: "unknown" }),
        })),
      ),
    refineUnknownRemote: () => Effect.succeed(null),
  } satisfies SourceControlManagedCliDiscoverySpec;
});
