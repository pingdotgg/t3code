import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { SourceControlProviderError } from "@t3tools/contracts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as ForgejoCli from "./ForgejoCli.ts";
import * as SourceControlProvider from "./SourceControlProvider.ts";
import {
  providerAuth,
  probeSourceControlProvider,
  type SourceControlCliDiscoverySpec,
  type SourceControlManagedCliDiscoverySpec,
} from "./SourceControlProviderDiscovery.ts";
import { ForgejoPullRequestSchema, toForgejoChangeRequest } from "./forgejoPullRequests.ts";

const isForgejoCliError = Schema.is(ForgejoCli.ForgejoCliError);

export const discovery = {
  type: "cli",
  kind: "forgejo",
  label: "Forgejo / Gitea",
  executable: "tea",
  versionArgs: ["--version"],
  authArgs: ["login", "status", "--output", "json"],
  remoteRefinementArgs: ["login", "list", "--output", "json"],
  parseAuth: (input) => {
    const logins = ForgejoCli.parseForgejoLogins(input.stdout);
    const login = logins.find((entry) => entry.default === "true") ?? logins[0];
    return login
      ? providerAuth({
          status: login.valid === "true" ? "authenticated" : "unauthenticated",
          account: login.user,
          host: ForgejoCli.parseForgejoRemote(login.url)?.host,
        })
      : providerAuth({
          status: "unauthenticated",
          detail: "Run `tea login add` to authenticate a Forgejo or Gitea server.",
        });
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
    return login ? { kind: "forgejo", name: "Forgejo / Gitea", baseUrl: login.url } : null;
  },
  installHint:
    "Install `fj` 0.6 or later from https://codeberg.org/forgejo-contrib/forgejo-cli and run `fj --host <server-url> auth add-token`, or install `tea` 0.16 or later from https://gitea.com/gitea/tea and run `tea login add` for each Forgejo or Gitea server.",
} satisfies SourceControlCliDiscoverySpec;

export const makeDiscovery = Effect.gen(function* () {
  const cli = yield* ForgejoCli.ForgejoCli;
  const process = yield* VcsProcess.VcsProcess;
  const listLogins = cli.listLogins;
  if (!listLogins) return discovery;
  return {
    type: "managed-cli",
    kind: "forgejo",
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
      const logins = Result.isSuccess(credentials) ? credentials.success : [];
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
      // A configured fj account owns its requests, including authentication errors.
      if (fj.status === "available" && (login || Result.isFailure(credentials))) {
        if (login && fj.auth.status === "authenticated" && cli.getAccount) {
          const account = yield* cli.getAccount({ cwd, baseUrl: login.url }).pipe(Effect.result);
          return {
            ...fj,
            auth: Result.isSuccess(account)
              ? providerAuth({
                  status: "authenticated",
                  account: account.success,
                  host: ForgejoCli.parseForgejoRemote(login.url)?.host,
                })
              : providerAuth({
                  status: "unknown",
                  detail: account.failure.detail,
                  host: ForgejoCli.parseForgejoRemote(login.url)?.host,
                }),
          };
        }
        return fj;
      }
      const tea = yield* probeSourceControlProvider({ cwd, process, spec: discovery });
      return tea.status === "available" || fj.status === "missing" ? tea : fj;
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
          if (login) return { kind: "forgejo" as const, name: discovery.label, baseUrl: login.url };
        }
        return null;
      },
    ),
  } satisfies SourceControlManagedCliDiscoverySpec;
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
  const process = yield* VcsProcess.VcsProcess;
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
          provider: "forgejo",
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
    kind: "forgejo",
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
              path: `${repositoryPath(repo.repository)}/pulls?state=${input.state === "merged" ? "closed" : input.state}&sort=recentupdate&limit=50&page=${page}`,
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
