import { SourceControlProviderKind, type SourceControlProviderAuth } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import { SourceControlProviderError } from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  providerAuth,
  probeSourceControlProvider,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import { ForgejoPullRequestSchema, toForgejoChangeRequest } from "./forgejoPullRequests.ts";

const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);
type ForgejoInstance = NonNullable<SourceControlProviderAuth["instances"]>[number];
const INVALID_CONNECTION_DETAIL =
  "Some CLI connections have an invalid name or server URL. Check fj and tea login configuration.";

function hasConnectionIdentity(login: typeof ForgejoCli.ForgejoLoginSchema.Type): boolean {
  if (!login.name.trim()) return false;
  try {
    const url = new URL(login.url);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  } catch {
    return false;
  }
}

export const discovery = {
  type: "cli",
  kind: SourceControlProviderKind.make("forgejo"),
  label: "Forgejo / Gitea",
  executable: "tea",
  versionArgs: ["--version"],
  authArgs: ["login", "status", "--output", "json"],
  remoteRefinementArgs: ["login", "list", "--output", "json"],
  parseAuth: (input) => {
    const configured = ForgejoCli.parseForgejoLogins(input.stdout);
    const logins = configured.filter(hasConnectionIdentity);
    const login = logins.find((entry) => entry.default === "true") ?? logins[0];
    const auth = login
      ? providerAuth({
          status: login.valid === "true" ? "authenticated" : "unauthenticated",
          account: login.user,
          host: ForgejoCli.parseForgejoRemote(login.url)?.host,
        })
      : providerAuth({
          status: "unauthenticated",
          detail: "Run `tea login add` to authenticate a Forgejo or Gitea server.",
        });
    return {
      ...auth,
      ...(configured.length !== logins.length
        ? { detail: Option.some(INVALID_CONNECTION_DETAIL) }
        : {}),
      instances: logins.map((entry): ForgejoInstance => ({
        baseUrl: entry.url,
        executable: "tea",
        login: entry.name,
        account: Option.fromNullishOr(entry.user.trim() || undefined),
        status:
          entry.valid === "true"
            ? "authenticated"
            : entry.valid === "false"
              ? "unauthenticated"
              : "unknown",
      })),
    };
  },
  refineUnknownRemote: (input) => {
    const remote = ForgejoCli.parseForgejoRemote(input.context.remoteUrl);
    const login =
      remote &&
      ForgejoCli.matchForgejoLogin(
        ForgejoCli.parseForgejoLogins(input.auth.stdout),
        remote,
        input.context.requestedHost,
      );
    return login
      ? {
          kind: SourceControlProviderKind.make("forgejo"),
          name: "Forgejo / Gitea",
          baseUrl: login.url,
        }
      : null;
  },
  installHint:
    "Install `fj` 0.6 or later from https://codeberg.org/forgejo-contrib/forgejo-cli and run `fj --host <server-url> auth add-token`, or install `tea` 0.16 or later from https://gitea.com/gitea/tea and run `tea login add` for each Forgejo or Gitea server.",
} satisfies SourceControlCliDiscoverySpec;

export const makeDiscovery = Effect.gen(function* () {
  const cli = yield* ForgejoCli.ForgejoCli;
  const { process } = yield* SourceControlHost.SourceControlHost;
  const listLogins = cli.listLogins;
  if (!listLogins) return discovery;
  return {
    type: "managed-cli",
    kind: SourceControlProviderKind.make("forgejo"),
    label: discovery.label,
    installHint: discovery.installHint,
    probe: Effect.fn("ForgejoSourceControlProvider.discovery")(function* (cwd: string) {
      const remoteUrl = yield* process
        .run({
          operation: "source-control.discovery.remote",
          command: "git",
          args: ["remote", "get-url", "origin"],
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 8_000,
        })
        .pipe(
          Effect.map((result) => result.stdout.trim()),
          Effect.orElseSucceed(() => ""),
        );
      const credentials = yield* Effect.result(listLogins({ cwd, command: "fj", remoteUrl }));
      const logins = Result.isSuccess(credentials)
        ? credentials.success.filter(hasConnectionIdentity)
        : [];
      const remote = ForgejoCli.parseForgejoRemote(remoteUrl);
      const login =
        (remote && ForgejoCli.matchForgejoLogin(logins, remote)) ||
        logins.find((entry) => entry.default === "true") ||
        logins[0];
      const fj = yield* probeSourceControlProvider({
        cwd,
        process,
        spec: {
          ...discovery,
          executable: "fj",
          versionArgs: ["version"],
          authArgs: login ? ["--host", login.url, "whoami"] : ["auth", "list"],
          parseAuth: (result) =>
            Result.isFailure(credentials)
              ? providerAuth({
                  status: "unknown",
                  detail: "Could not read fj authentication storage. Authenticate again with fj.",
                })
              : login && result.exitCode === 0
                ? providerAuth({
                    status: "authenticated",
                    account: login.user,
                    host: ForgejoCli.parseForgejoRemote(login.url)?.host,
                  })
                : providerAuth({
                    status: "unauthenticated",
                    detail:
                      "Authenticate this server with `fj --host <server-url> auth add-token`.",
                  }),
        },
      });
      // Enumerate both tools even when fj owns the primary account. A tea-only server must
      // still be visible, and fj's SSH aliases are not additional connections.
      const tea = yield* probeSourceControlProvider({ cwd, process, spec: discovery });
      const getAccount = cli.getAccount;
      const fjInstances = yield* Effect.forEach(
        fj.status === "available"
          ? [...new Map(logins.map((entry) => [entry.name, entry])).values()]
          : [],
        (entry) =>
          Effect.gen(function* (): Effect.fn.Return<ForgejoInstance> {
            const selected = entry.name === login?.name;
            const account =
              getAccount && (!selected || fj.auth.status === "authenticated")
                ? yield* getAccount({ cwd, baseUrl: entry.url }).pipe(
                    Effect.timeout(5_000),
                    Effect.result,
                  )
                : null;
            const status = account
              ? Result.isSuccess(account)
                ? "authenticated"
                : account.failure._tag === "ForgejoCliError" &&
                    account.failure.reason === "authentication"
                  ? "unauthenticated"
                  : "unknown"
              : selected
                ? fj.auth.status
                : "unknown";
            return {
              baseUrl: entry.url,
              executable: "fj",
              login: entry.name,
              account:
                account && Result.isSuccess(account)
                  ? Option.some(account.success)
                  : Option.fromNullishOr(entry.user.trim() || undefined),
              status,
            };
          }),
        // fj serializes OAuth renewal. Start each deadline after the previous connection
        // finishes so a slow host cannot consume a healthy host's verification budget.
        { concurrency: 1 },
      );
      // `tea login status` contacts every host. If one is offline or the command times
      // out, its local login list still identifies the configured connections.
      const teaConfigured =
        !tea.auth.instances?.length && tea.status === "available"
          ? yield* listLogins({ cwd, command: "tea", remoteUrl }).pipe(Effect.result)
          : null;
      const teaInstances = tea.auth.instances?.length
        ? tea.auth.instances
        : teaConfigured && Result.isSuccess(teaConfigured)
          ? teaConfigured.success.filter(hasConnectionIdentity).map((entry): ForgejoInstance => ({
              baseUrl: entry.url,
              executable: "tea",
              login: entry.name,
              account: Option.fromNullishOr(entry.user.trim() || undefined),
              status: "unknown",
            }))
          : [];
      const instances = [...fjInstances, ...teaInstances];
      // Listing tea must not silently switch the primary account after a fj auth failure.
      const primary =
        fj.status === "available" && (login || Result.isFailure(credentials))
          ? fj
          : tea.status === "available" || fj.status === "missing"
            ? tea
            : fj;
      const selectedInstance =
        primary === fj && login
          ? fjInstances.find((entry) => entry.login === login.name)
          : undefined;
      const details = new Set(Option.toArray(primary.auth.detail));
      if (
        (Result.isSuccess(credentials) && credentials.success.length !== logins.length) ||
        Option.getOrNull(tea.auth.detail) === INVALID_CONNECTION_DETAIL ||
        (teaConfigured &&
          Result.isSuccess(teaConfigured) &&
          teaConfigured.success.some((entry) => !hasConnectionIdentity(entry)))
      ) {
        details.add(INVALID_CONNECTION_DETAIL);
      }
      if (teaConfigured && Result.isFailure(teaConfigured)) {
        details.add("Could not read tea connections. Check tea login configuration and rescan.");
      }
      return {
        ...primary,
        auth: {
          ...primary.auth,
          detail: Option.fromNullishOr([...details].join(" ") || undefined),
          ...(selectedInstance
            ? {
                status: selectedInstance.status,
                account: selectedInstance.account,
                host: Option.fromNullishOr(
                  ForgejoCli.parseForgejoRemote(selectedInstance.baseUrl)?.host,
                ),
              }
            : {}),
          instances,
        },
      };
    }),
    refineUnknownRemote: Effect.fn("ForgejoSourceControlProvider.refineUnknownRemote")(
      function* (input: {
        readonly cwd: string;
        readonly context: SourceControlProvider.SourceControlProviderContext;
      }) {
        const remote = ForgejoCli.parseForgejoRemote(input.context.remoteUrl);
        if (!remote) return null;
        for (const command of ["fj", "tea"] as const) {
          const logins = yield* listLogins({
            cwd: input.cwd,
            command,
            remoteUrl: input.context.remoteUrl,
          }).pipe(Effect.orElseSucceed(() => []));
          const login = ForgejoCli.matchForgejoLogin(logins, remote, input.context.requestedHost);
          if (login)
            return {
              kind: SourceControlProviderKind.make("forgejo"),
              name: discovery.label,
              baseUrl: login.url,
            };
        }
        return null;
      },
    ),
  } satisfies SourceControlManagedCliDiscoverySpec;
});

/** HTTP paths can include an installation mount; Forgejo's API always names owner/repo. */
export function repositoryNameFromRemoteUrl(url: string): string | null {
  const path = SourceControlProvider.repositoryPathFromRemoteUrl(url);
  return path === null || !/^https?:\/\//iu.test(url.trim())
    ? path
    : path.split("/").slice(-2).join("/");
}

/**
 * A Forgejo remote's URL can't say which server it belongs to (an SSH alias, an installation
 * mount), so the identity's browser URL comes from the login that serves it.
 */
const refineRepositoryIdentity: NonNullable<
  SourceControlProvider.SourceControlProvider["Service"]["refineRepositoryIdentity"]
> = Effect.fn("ForgejoSourceControlProvider.refineRepositoryIdentity")(function* ({
  identity,
  resolveContext,
}) {
  const remote = ForgejoCli.parseForgejoRemote(identity.locator.remoteUrl);
  if (
    !remote ||
    !identity.rootPath ||
    (identity.provider !== undefined &&
      identity.provider !== "unknown" &&
      identity.provider !== "forgejo")
  )
    return identity;
  const context = yield* resolveContext({
    cwd: identity.rootPath,
    context: {
      provider: { kind: SourceControlProviderKind.make("unknown"), name: "Unknown", baseUrl: "" },
      remoteName: identity.locator.remoteName,
      remoteUrl: identity.locator.remoteUrl,
    },
  });
  if (context?.provider.kind !== "forgejo") return identity;
  const baseUrl = context.provider.baseUrl.replace(/\/+$/, "");
  const basePath = new URL(baseUrl).pathname.replace(/^\/+|\/+$/g, "");
  const path =
    !remote.ssh && basePath && remote.path.startsWith(`${basePath}/`)
      ? remote.path.slice(basePath.length + 1)
      : remote.path;
  return {
    ...identity,
    provider: SourceControlProviderKind.make("forgejo"),
    webUrl: `${baseUrl}/${path}`,
  };
});

const RepositorySchema = Schema.Struct({
  full_name: Schema.String,
  clone_url: Schema.String,
  ssh_url: Schema.String,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
});
const cloneUrls = (raw: typeof RepositorySchema.Type) => ({
  nameWithOwner: raw.full_name,
  url: raw.clone_url,
  sshUrl: raw.ssh_url,
});
const repositoryPath = (repository: string) =>
  `repos/${repository.split("/").map(encodeURIComponent).join("/")}`;

export const make = Effect.gen(function* () {
  const cli = yield* ForgejoCli.ForgejoCli;
  const fs = yield* FileSystem.FileSystem;
  const { process } = yield* SourceControlHost.SourceControlHost;
  const request = <S extends Schema.Codec<unknown, unknown, never, never>>(
    input: ForgejoCli.ForgejoApiInput,
    schema: S,
  ) =>
    cli.api(input).pipe(
      Effect.flatMap((result) =>
        Schema.decodeEffect(Schema.fromJsonString(schema))(result.stdout).pipe(
          Effect.mapError(
            (cause) =>
              new ForgejoCli.ForgejoCliError({
                command: "tea",
                cwd: input.cwd,
                detail: "Forgejo API returned an invalid response.",
                reason: "invalid-response",
                cause,
              }),
          ),
        ),
      ),
    );
  const mapError = (operation: string, cwd: string) =>
    Effect.mapError(
      (cause: unknown) =>
        new SourceControlProviderError({
          provider: SourceControlProviderKind.make("forgejo"),
          operation,
          cwd,
          ...(isForgejoCliError(cause) ? { command: cause.command } : {}),
          detail: isForgejoCliError(cause) ? cause.detail : "Forgejo operation failed.",
          cause,
        }),
    );
  const getPull = Effect.fn("ForgejoSourceControlProvider.getPull")(function* (
    input: Parameters<
      SourceControlProvider.SourceControlProvider["Service"]["getChangeRequest"]
    >[0],
  ) {
    const repo = yield* cli.resolveRepository(input);
    const number = /(?:^#?|\/pulls\/)(\d+)(?:\/[^?#]*)?(?:[?#].*)?$/.exec(input.reference)?.[1];
    if (!number)
      return yield* new ForgejoCli.ForgejoCliError({
        command: "tea",
        cwd: input.cwd,
        detail: "Specify a pull request number or Forgejo pull request URL.",
      });
    return yield* request(
      { ...input, path: `${repositoryPath(repo.repository)}/pulls/${number}` },
      ForgejoPullRequestSchema,
    );
  });
  return SourceControlProvider.SourceControlProvider.of({
    kind: SourceControlProviderKind.make("forgejo"),
    repositoryNameFromRemoteUrl,
    refineRepositoryIdentity,
    listChangeRequests: (input) =>
      Effect.gen(function* () {
        const repo = yield* cli.resolveRepository(input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const branch = SourceControlProvider.sourceBranch(input);
        const results: ReturnType<typeof toForgejoChangeRequest>[] = [];
        const limit = input.limit ?? 20;
        for (let page = 1; results.length < limit; page++) {
          const items = yield* request(
            {
              ...input,
              path: `${repositoryPath(repo.repository)}/pulls?state=${input.state === "merged" ? "closed" : input.state}&head=${encodeURIComponent(branch)}&sort=recentupdate&limit=50&page=${page}`,
            },
            Schema.Array(ForgejoPullRequestSchema),
          );
          for (const item of items) {
            if (
              item.head.ref !== branch ||
              (source?.repository && item.head.repo?.full_name !== source.repository) ||
              (source?.owner && item.head.repo?.owner.login !== source.owner)
            )
              continue;
            const normalized = toForgejoChangeRequest(item);
            if (input.state === "all" || normalized.state === input.state) results.push(normalized);
          }
          if (items.length === 0) break;
        }
        return results.slice(0, limit);
      }).pipe(mapError("listChangeRequests", input.cwd)),
    getChangeRequest: (input) =>
      getPull(input).pipe(
        Effect.map(toForgejoChangeRequest),
        mapError("getChangeRequest", input.cwd),
      ),
    createChangeRequest: (input) =>
      Effect.gen(function* () {
        const repo = yield* cli.resolveRepository(input);
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const owner = source?.owner ?? source?.repository?.split("/")[0];
        const head = SourceControlProvider.sourceBranch(input);
        yield* cli.api({
          ...input,
          path: `${repositoryPath(input.target?.repository ?? repo.repository)}/pulls`,
          method: "POST",
          body: {
            base: input.target?.refName ?? input.baseRefName,
            head: owner ? `${owner}:${head}` : head,
            title: input.title,
            body: yield* fs.readFileString(input.bodyFile),
          },
        });
      }).pipe(mapError("createChangeRequest", input.cwd)),
    getRepositoryCloneUrls: (input) =>
      Effect.gen(function* () {
        const repo = yield* cli.resolveRepository(input);
        return cloneUrls(
          yield* request({ ...input, path: repositoryPath(repo.repository) }, RepositorySchema),
        );
      }).pipe(mapError("getRepositoryCloneUrls", input.cwd)),
    createRepository: (input) =>
      Effect.gen(function* () {
        const repo = yield* cli.resolveRepository(input);
        const user = yield* request(
          { ...input, path: "user" },
          Schema.Struct({ login: Schema.String }),
        );
        const [owner, name] = repo.repository.split("/");
        return cloneUrls(
          yield* request(
            {
              ...input,
              path:
                owner === user.login
                  ? "user/repos"
                  : `orgs/${encodeURIComponent(owner ?? "")}/repos`,
              method: "POST",
              body: { name, private: input.visibility === "private", auto_init: false },
            },
            RepositorySchema,
          ),
        );
      }).pipe(mapError("createRepository", input.cwd)),
    getDefaultBranch: (input) =>
      Effect.gen(function* () {
        const repo = yield* cli.resolveRepository(input);
        return (
          (yield* request({ ...input, path: repositoryPath(repo.repository) }, RepositorySchema))
            .default_branch ?? null
        );
      }).pipe(mapError("getDefaultBranch", input.cwd)),
    checkoutChangeRequest: (input) =>
      Effect.gen(function* () {
        const repo = yield* cli.resolveRepository(input);
        const pull = yield* getPull(input);
        if (repo.command === "fj") {
          // fj checkout cannot target a repository outside the local remotes.
          const urls = yield* request(
            { ...input, path: repositoryPath(repo.repository) },
            RepositorySchema,
          );
          const remote = input.context?.remoteUrl;
          const useSsh = remote && ForgejoCli.parseForgejoRemote(remote)?.ssh;
          yield* process.run({
            operation: "ForgejoSourceControlProvider.checkoutChangeRequest",
            command: "git",
            cwd: input.cwd,
            args: [
              "fetch",
              "--",
              useSsh ? urls.ssh_url : urls.clone_url,
              `refs/pull/${pull.number}/head`,
            ],
          });
          const branch = `pulls/${pull.number}`;
          const existing = yield* process.run({
            operation: "ForgejoSourceControlProvider.checkoutChangeRequest",
            command: "git",
            cwd: input.cwd,
            args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
            allowNonZeroExit: true,
          });
          yield* process.run({
            operation: "ForgejoSourceControlProvider.checkoutChangeRequest",
            command: "git",
            cwd: input.cwd,
            args:
              existing.exitCode === 0
                ? ["checkout", branch]
                : ["checkout", "-b", branch, "FETCH_HEAD"],
          });
        } else
          yield* cli.execute({
            cwd: input.cwd,
            args: [
              "pulls",
              "checkout",
              "--login",
              repo.login,
              "--repo",
              repo.repository,
              "--branch",
              String(pull.number),
            ],
          });
        if (input.force) {
          // tea leaves an existing PR branch at its old tip. Keep dirty files safe
          // while bringing the selected branch to the PR revision we fetched.
          yield* process.run({
            operation: "ForgejoSourceControlProvider.checkoutChangeRequest",
            command: "git",
            cwd: input.cwd,
            args: ["reset", "--keep", pull.head.sha],
          });
        }
      }).pipe(mapError("checkoutChangeRequest", input.cwd)),
  });
});
