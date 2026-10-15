import {
  SourceControlProviderError,
  SourceControlProviderKind,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import {
  firstSafeAuthLine,
  providerAuth,
  type SourceControlAuthProbeInput,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";

import * as TangledClient from "../client/definition.ts";
import * as TangledPullRequestProvider from "./TangledPullRequestProvider.ts";
import {
  isTangledCliError,
  TangledAuthStatusSchema,
  TangledCli,
  TangledRepositorySchema,
  TANGLED_CLI,
} from "./TangledCli.ts";

export const KIND = SourceControlProviderKind.make("tangled");

/** tangled.org serves the repository pages; `tangled.sh` and each knot serve the same trees. */
export function isTangledHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "tangled.org" ||
    host === "tangled.sh" ||
    host.endsWith(".tangled.org") ||
    host.endsWith(".tangled.sh")
  );
}

/** `tg auth status --json` names the account and the DID when one is signed in. */
export function parseAuth(input: SourceControlAuthProbeInput) {
  const decoded = decodeJsonResult(TangledAuthStatusSchema)(input.stdout);
  if (
    decoded._tag === "Success" &&
    decoded.success.authenticated &&
    decoded.success.status !== "expired"
  ) {
    return providerAuth({
      status: "authenticated",
      account: decoded.success.handle ?? decoded.success.did,
      host: "tangled.org",
    });
  }
  if (decoded._tag === "Success") {
    return providerAuth({
      status: "unauthenticated",
      host: "tangled.org",
      detail: "Run `tg auth login` to sign the Tangled CLI in.",
    });
  }
  return providerAuth({
    status: "unknown",
    host: "tangled.org",
    detail:
      firstSafeAuthLine(`${input.stderr}\n${input.stdout}`) ??
      "`tg auth status` could not be read.",
  });
}

export const discovery = {
  type: "cli",
  kind: KIND,
  label: "Tangled",
  executable: TANGLED_CLI,
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json"],
  parseAuth,
  installHint:
    "Install the Tangled CLI (`tg`) from https://tangled.org/aly.codes/tg and run `tg auth login`.",
} satisfies SourceControlCliDiscoverySpec;

/** Clone URLs, which `tg` never returns and every remote form is derivable from. */
function cloneUrls(repository: string): SourceControlRepositoryCloneUrls {
  return {
    nameWithOwner: repository,
    url: TangledClient.repositoryCloneUrl(repository),
    sshUrl: TangledClient.repositorySshUrl(repository),
  };
}

/**
 * A repository address below the host, which Tangled writes in two forms: `handle/repo`, and the
 * repository's own DID. `tg` prefers the DID whenever the repository record carries one, so a DID
 * is the shape most real remotes have — and both forms are served by tangled.org and accepted by
 * git, which is what lets every URL here be derived from the address instead of looked up.
 */
export function isTangledRepositoryDid(address: string): boolean {
  return /^did:[a-z0-9]+:[a-z0-9]+$/iu.test(address.trim());
}

/**
 * The path below a remote's host. The shared reader needs at least one `/` between segments,
 * which a repository DID does not have, so a single-segment remote is read here instead.
 */
export function repositoryPathFromTangledRemote(url: string): string | null {
  const shared = SourceControlProvider.repositoryPathFromRemoteUrl(url);
  if (shared !== null) return shared;
  const single =
    /^(?:[^@/\s]+@[^:/\s]+:|(?:ssh|https?|git):\/\/[^/]+\/)([^/\s]+?)(?:\.git)?\/?$/iu.exec(
      url.trim(),
    );
  return single?.[1] ?? null;
}

/** Reads `ref: refs/heads/<branch>\tHEAD` out of `git ls-remote --symref`. */
export function defaultBranchFromSymref(stdout: string): string | null {
  const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/mu.exec(stdout);
  return match?.[1] ?? null;
}

/**
 * Tangled pull requests are addressed two ways that do not meet: `tg` takes an AT Protocol record
 * key (`3mkaewigwhi22`), while tangled.org's pages are numbered from a per-knot database
 * sequence (`/pulls/19`). `ChangeRequest.number` is the number, and no public endpoint maps one
 * to the other, so this build cannot name a pull request without inventing an id the user would
 * then see as a wrong link. These fail rather than answer with a number that does not exist.
 */
function unsupported(operation: string, cwd: string) {
  return Effect.fail(
    new SourceControlProviderError({
      provider: KIND,
      operation,
      cwd,
      detail:
        "This build cannot read Tangled pull requests: the tg CLI addresses them by record key, not by the number their pages show.",
    }),
  );
}

/**
 * `tg pr list --json`. Its items carry an AT Protocol record key, never the number tangled.org
 * gives the same pull request, which is why this build cannot turn one into a `ChangeRequest`.
 * `sourceBranch` is absent on some answers, so it is not required.
 */
export const TangledPullListSchema = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      rkey: Schema.String,
      uri: Schema.optional(Schema.String),
      title: Schema.String,
      state: Schema.String,
      sourceBranch: Schema.optional(Schema.String),
      targetBranch: Schema.optional(Schema.String),
    }),
  ),
});

/**
 * Whether `tg repo create` honoured the owner asked for. `tg` has no way to create a repository
 * under another account, so a name like `someone-else/repo` is created under the signed-in one.
 * Compare handles and pairs of DIDs directly. A mixed DID/handle pair cannot establish a
 * mismatch without resolving the handle.
 */
export function createsUnderOwner(input: {
  readonly requested: string;
  readonly created: string | undefined;
}): boolean {
  const requested = input.requested.trim();
  const created = input.created?.trim();
  if (requested.length === 0 || created === undefined || created.length === 0) return true;
  if (requested.startsWith("did:") && created.startsWith("did:")) return requested === created;
  return requested.startsWith("did:") || created.startsWith("did:") || requested === created;
}

/**
 * The address a caller typed or pasted: `handle/repo`, a repository DID, or a URL naming one,
 * since the clone picker accepts whatever is pasted into it.
 */
export function repositoryAddress(repository: string): string | null {
  const trimmed = repository
    .trim()
    .replace(/\.git$/iu, "")
    .replace(/\/+$/u, "");
  if (trimmed.length === 0) return null;
  const isRemote =
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) || /^[^@/\s]+@[^:/\s]+:/u.test(trimmed);
  return isRemote ? repositoryPathFromTangledRemote(trimmed) : trimmed;
}

export const make = Effect.gen(function* () {
  const cli = yield* TangledCli;
  const { git } = yield* SourceControlHost.SourceControlHost;
  const pullRequests = yield* TangledPullRequestProvider.make;

  const fail = (operation: string, cwd: string, cause: unknown) =>
    new SourceControlProviderError({
      provider: KIND,
      operation,
      cwd,
      ...(isTangledCliError(cause) ? { command: TANGLED_CLI } : {}),
      detail: isTangledCliError(cause) ? cause.detail : "Tangled operation failed.",
      cause,
    });

  const notNamed = (operation: string, cwd: string, detail: string) =>
    new SourceControlProviderError({ provider: KIND, operation, cwd, detail });

  /**
   * The address a call targets. A caller that already knows the repository passes it by name and
   * may pass no checkout at all — the clone picker types `handle/repo` — so the name comes first
   * and the checkout's remote is only a fallback.
   */
  const repositoryFrom = Effect.fn("TangledSourceControlProvider.repositoryFrom")(
    function* (input: {
      readonly cwd: string;
      readonly repository?: string | undefined;
      readonly context?: SourceControlProvider.SourceControlProviderContext | undefined;
    }) {
      const named = input.repository === undefined ? null : repositoryAddress(input.repository);
      const address = named ?? repositoryPathFromTangledRemote(input.context?.remoteUrl ?? "");
      if (
        address !== null &&
        (isTangledRepositoryDid(address) || address.split("/").length === 2)
      ) {
        return address;
      }
      return yield* notNamed(
        "resolveRepository",
        input.cwd,
        "Tangled addresses a repository as handle/repo or by its repository DID, which is what this project must name.",
      );
    },
  );

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    repositoryNameFromRemoteUrl: (url) => repositoryPathFromTangledRemote(url),

    getRepositoryCloneUrls: (input) =>
      Effect.gen(function* () {
        const repository = yield* repositoryFrom({
          cwd: input.cwd,
          repository: input.repository,
          context: input.context,
        });
        // `tg repo view` takes `handle/repo` and refuses a DID, so a typed handle is confirmed
        // before its URLs are handed back and a DID — which git already holds as a working
        // remote — is taken as it stands.
        if (!isTangledRepositoryDid(repository)) {
          yield* cli
            .runJson({
              cwd: input.cwd,
              args: ["repo", "view", repository],
              schema: TangledRepositorySchema,
            })
            .pipe(Effect.mapError((cause) => fail("getRepositoryCloneUrls", input.cwd, cause)));
        }
        return cloneUrls(repository);
      }),

    createRepository: (input) =>
      Effect.gen(function* () {
        const segments = input.repository.split("/");
        const [owner, name] = segments;
        if (segments.length !== 2 || !owner || !name) {
          return yield* notNamed(
            "createRepository",
            input.cwd,
            "Name a Tangled repository as handle/repo.",
          );
        }
        const account = yield* cli
          .runJson({
            cwd: input.cwd,
            args: ["auth", "status"],
            schema: TangledAuthStatusSchema,
          })
          .pipe(Effect.mapError((cause) => fail("createRepository", input.cwd, cause)));
        if (
          !account.authenticated ||
          account.status === "expired" ||
          account.status === "unknown" ||
          (owner !== account.handle && owner !== account.did)
        ) {
          return yield* notNamed(
            "createRepository",
            input.cwd,
            `Cannot confirm Tangled is signed in as ${owner} (reported account: ${account.handle ?? account.did ?? "unknown"}). Run \`tg auth login ${owner}\` and retry.`,
          );
        }
        // Tangled has no private repositories, so `visibility` is not something `tg` can be asked
        // for; a knot may still refuse the name, which surfaces as this operation's error.
        const created = yield* cli
          .runJson({
            cwd: input.cwd,
            args: ["repo", "create", name],
            schema: TangledRepositorySchema,
          })
          .pipe(Effect.mapError((cause) => fail("createRepository", input.cwd, cause)));
        // `tg` always creates under the signed-in account. Say so rather than hand back URLs for
        // a repository that was never made where the caller asked.
        if (!createsUnderOwner({ requested: owner, created: created.author })) {
          return yield* notNamed(
            "createRepository",
            input.cwd,
            `tg created ${name} under ${created.author ?? "your account"}, not ${owner}. Create it on tangled.org to own it as ${owner}.`,
          );
        }
        return cloneUrls(input.repository);
      }),

    getDefaultBranch: (input) =>
      Effect.gen(function* () {
        yield* repositoryFrom({ cwd: input.cwd, context: input.context });
        const remoteName = input.context?.remoteName;
        if (remoteName === undefined) {
          return yield* notNamed(
            "getDefaultBranch",
            input.cwd,
            "This project has no Tangled remote.",
          );
        }
        // `tg repo view` reports no default branch, so git's own symref is the source.
        const listing = yield* git
          .execute({
            operation: "TangledSourceControlProvider.getDefaultBranch",
            cwd: input.cwd,
            args: ["ls-remote", "--symref", remoteName, "HEAD"],
          })
          .pipe(Effect.mapError((cause) => fail("getDefaultBranch", input.cwd, cause)));
        return defaultBranchFromSymref(listing.stdout);
      }),

    listChangeRequests: (input) =>
      Effect.gen(function* () {
        const repository = yield* repositoryFrom(input);
        const page = yield* pullRequests
          .listChangeRequests({
            cwd: input.cwd,
            repository,
            host: "tangled.org",
            state: input.state,
            involvement: "all",
            viewer: "",
            limit: Number.MAX_SAFE_INTEGER,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new SourceControlProviderError({
                  provider: KIND,
                  operation: "listChangeRequests",
                  cwd: input.cwd,
                  detail: cause.detail,
                  cause,
                }),
            ),
          );
        // Filter before limiting: an older PR on another branch must not hide this branch's PR.
        return page.items
          .filter((pull) => pull.headBranch === SourceControlProvider.sourceBranch(input))
          .slice(0, input.limit)
          .map((pull) => ({
            provider: KIND,
            number: pull.number,
            title: pull.title,
            url: pull.url,
            headRefName: pull.headBranch,
            baseRefName: pull.baseBranch,
            state: pull.state,
            updatedAt: DateTime.make(pull.updatedAt),
          }));
      }),

    createChangeRequest: (input) =>
      Effect.gen(function* () {
        const source = SourceControlProvider.sourceControlRefFromInput(input);
        const headBranch = SourceControlProvider.sourceBranch(input);
        const address = yield* repositoryFrom({
          cwd: input.cwd,
          repository: input.target?.repository ?? source?.repository,
          context: input.context,
        });

        const open = yield* cli
          .runJson({
            cwd: input.cwd,
            args: ["pr", "list", address, "--state", "open"],
            schema: TangledPullListSchema,
          })
          .pipe(Effect.mapError((cause) => fail("createChangeRequest", input.cwd, cause)));
        // `tg pr list` answers by record key and branch, which is all a duplicate check needs.
        // A pull request whose source branch is absent cannot be matched and is left alone.
        const duplicate = open.items.find(
          (pull) => pull.sourceBranch === headBranch && pull.targetBranch === input.baseRefName,
        );
        if (duplicate) {
          return yield* notNamed(
            "createChangeRequest",
            input.cwd,
            `${headBranch} already has an open pull request into ${input.baseRefName} (${duplicate.rkey}). Open it with \`tg pr view ${duplicate.rkey}\`.`,
          );
        }

        // The body is passed as a file, so it never appears in argv.
        const args = [
          "pr",
          "create",
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
          "--base",
          input.baseRefName,
          "--head",
          headBranch,
        ];
        // `-repo` takes `handle/repo`; a repository DID is only ever resolved from the checkout.
        if (!isTangledRepositoryDid(address)) args.push("--repo", address);
        yield* cli
          .run({ cwd: input.cwd, args })
          .pipe(Effect.mapError((cause) => fail("createChangeRequest", input.cwd, cause)));
      }),

    getChangeRequest: (input) => unsupported("getChangeRequest", input.cwd),
    checkoutChangeRequest: (input) => unsupported("checkoutChangeRequest", input.cwd),
  });
});
