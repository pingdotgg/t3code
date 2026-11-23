import {
  type ChangeRequest,
  type RepositoryIdentity,
  SourceControlProviderError,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import type { SourceControlCliDiscoverySpec } from "@t3tools/source-control-core/server/discovery";

import {
  definition,
  KIND,
  parseRadicleRemote,
  parseRid,
  patchNumberFromId,
  patchUrl,
  RADICLE_EXPLORER,
} from "../shared/definition.ts";
import * as RadicleCli from "./RadicleCli.ts";
import { latestRevision, type RadiclePatch } from "./radiclePatchJson.ts";
import { headBranch, pullRequestState } from "./radiclePatches.ts";

const PATCH_OPENED = /Patch ([0-9a-f]{40}) opened/u;
const ANSI_ESCAPE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "gu");
const stripAnsi = (text: string) => text.replace(ANSI_ESCAPE, "");
const PATCH_REF = /^refs\/heads\/patches\/([0-9a-f]{40})$/u;

/** A patch reference as a user or agent writes it: a number, a hex ID or prefix, or a link. */
export function patchNumberFromReference(reference: string): number | null {
  const trimmed = reference.trim().replace(/^#/u, "");
  if (/^\d+$/u.test(trimmed)) return Number(trimmed);
  if (/^[0-9a-f]{10,40}$/u.test(trimmed)) return patchNumberFromId(trimmed);
  try {
    return definition.parseChangeRequestUrl(new URL(trimmed))?.number ?? null;
  } catch {
    return null;
  }
}

/**
 * The repository's own identity: keyed by its ID rather than whichever peer's remote sorted first,
 * so every checkout on every machine groups together, with the ID's case kept in `name`.
 */
function radicleIdentity(input: {
  readonly identity: RepositoryIdentity;
  readonly rid: string;
  readonly remoteName: string;
  readonly projectName: string | null;
}): RepositoryIdentity {
  const { owner: _owner, ...identity } = input.identity;
  return {
    ...identity,
    canonicalKey: `radicle/${input.rid.toLowerCase()}`,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: `rad://${input.rid}`,
    },
    webUrl: `${RADICLE_EXPLORER}/rad:${input.rid}`,
    provider: KIND,
    name: input.rid,
    ...(input.projectName ? { displayName: input.projectName } : {}),
  };
}

export const make = Effect.gen(function* () {
  const cli = yield* RadicleCli.RadicleCli;
  const host = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;

  const failure =
    (operation: string, cwd: string, detail: string) => (cause: RadicleCli.RadicleCliError) =>
      new SourceControlProviderError({
        provider: KIND,
        operation,
        cwd,
        detail: cause.reason === "failed" ? detail : cause.detail,
        cause,
      });

  const toChangeRequest = (
    patch: RadiclePatch,
    context: { readonly rid: string; readonly defaultBranch: string; readonly branch?: string },
  ): ChangeRequest => ({
    provider: KIND,
    number: patch.number,
    title: patch.title,
    url: patchUrl({ rid: context.rid, patch: patch.id }),
    baseRefName: context.defaultBranch,
    headRefName: context.branch ?? headBranch(patch),
    headSha: latestRevision(patch).oid,
    state: pullRequestState(patch),
    isDraft: patch.status === "draft",
    updatedAt: Option.some(DateTime.makeUnsafe(patch.updatedAt)),
  });

  /** The patch a branch tracks: its upstream when `rad` set one, else one whose head it is. */
  const patchesForBranch = Effect.fn("RadicleSourceControlProvider.patchesForBranch")(function* (
    cwd: string,
    branch: string,
    patches: ReadonlyArray<RadiclePatch>,
  ) {
    const named = /^patches\/([0-9a-f]{40})$/u.exec(branch)?.[1];
    const upstream = yield* cli
      .git({
        operation: "branchUpstream",
        cwd,
        args: ["config", "--get", `branch.${branch}.merge`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((output) => PATCH_REF.exec(output.stdout.trim())?.[1]));
    const tracked = named ?? upstream;
    if (tracked !== undefined) return patches.filter((patch) => patch.id === tracked);
    const head = yield* cli
      .git({
        operation: "branchHead",
        cwd,
        args: ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
        allowNonZeroExit: true,
      })
      .pipe(Effect.map((output) => output.stdout.trim()));
    return head.length === 0
      ? []
      : patches.filter((patch) => patch.revisions.some((revision) => revision.oid === head));
  });

  /** The newest patch of this node's whose head is the branch's, for when `rad` printed no ID. */
  const openedPatchId = Effect.fn("RadicleSourceControlProvider.openedPatchId")(function* (
    cwd: string,
    branch: string,
  ) {
    const repository = yield* cli.repository({ cwd });
    const [patches, self] = yield* Effect.all(
      [cli.listPatches({ cwd, repository }), cli.self(cwd)],
      { concurrency: 2 },
    );
    const matches = yield* patchesForBranch(
      cwd,
      branch,
      patches.filter((patch) => patch.author === self.did),
    );
    return matches.toSorted((left, right) => right.createdAt - left.createdAt)[0]?.id;
  });

  const refineRepositoryIdentity: NonNullable<
    SourceControlProvider.SourceControlProvider["Service"]["refineRepositoryIdentity"]
  > = Effect.fn("RadicleSourceControlProvider.refineRepositoryIdentity")(function* ({ identity }) {
    const remote = parseRadicleRemote(identity.locator.remoteUrl);
    if (identity.provider !== KIND || remote === null) return identity;
    const cwd = identity.rootPath;
    if (cwd === undefined) {
      return radicleIdentity({ identity, rid: remote.rid, remoteName: "rad", projectName: null });
    }
    const radRemote = yield* host.git
      .readConfigValue(cwd, "remote.rad.url")
      .pipe(Effect.orElseSucceed(() => null));
    const project = yield* cli
      .project({ cwd, repository: { rid: remote.rid, storage: "" } })
      .pipe(Effect.option);
    return radicleIdentity({
      identity,
      rid: remote.rid,
      remoteName:
        radRemote !== null && parseRadicleRemote(radRemote)?.rid === remote.rid
          ? "rad"
          : identity.locator.remoteName,
      projectName: Option.isSome(project) ? project.value.name : null,
    });
  });

  return SourceControlProvider.SourceControlProvider.of({
    kind: KIND,
    refineRepositoryIdentity,
    createsDraftChangeRequests: true,
    repositoryNameFromRemoteUrl: (url) => {
      const remote = parseRadicleRemote(url);
      return remote === null ? null : `rad:${remote.rid}`;
    },

    listChangeRequests: Effect.fn("RadicleSourceControlProvider.listChangeRequests")(
      function* (input) {
        const branch = SourceControlProvider.sourceBranch(input);
        const fail = failure("listChangeRequests", input.cwd, "Failed to list Radicle patches.");
        const repository = yield* cli.repository({ cwd: input.cwd }).pipe(Effect.mapError(fail));
        const [project, patches] = yield* Effect.all(
          [
            cli.project({ cwd: input.cwd, repository }),
            cli.listPatches({ cwd: input.cwd, repository }),
          ],
          { concurrency: 2 },
        ).pipe(Effect.mapError(fail));
        const matches = yield* patchesForBranch(input.cwd, branch, patches).pipe(
          Effect.mapError(fail),
        );
        return matches
          .filter((patch) => input.state === "all" || pullRequestState(patch) === input.state)
          .toSorted((left, right) => right.updatedAt - left.updatedAt)
          .slice(0, input.limit ?? matches.length)
          .map((patch) =>
            toChangeRequest(patch, {
              rid: repository.rid,
              defaultBranch: project.defaultBranch,
              branch,
            }),
          );
      },
    ),

    getChangeRequest: Effect.fn("RadicleSourceControlProvider.getChangeRequest")(function* (input) {
      const fail = failure("getChangeRequest", input.cwd, "Failed to read the Radicle patch.");
      const number = patchNumberFromReference(input.reference);
      if (number === null) {
        return yield* new SourceControlProviderError({
          provider: KIND,
          operation: "getChangeRequest",
          cwd: input.cwd,
          reference: SourceControlProvider.transportSafeSourceControlErrorValue(input.reference),
          detail: "Name a patch by its ID (at least 10 hex digits), number, or link.",
        });
      }
      const repository = yield* cli.repository({ cwd: input.cwd }).pipe(Effect.mapError(fail));
      const [project, patch] = yield* Effect.all(
        [
          cli.project({ cwd: input.cwd, repository }),
          cli.getPatch({ cwd: input.cwd, repository, number }),
        ],
        { concurrency: 2 },
      ).pipe(Effect.mapError(fail));
      return toChangeRequest(patch, { rid: repository.rid, defaultBranch: project.defaultBranch });
    }),

    createChangeRequest: Effect.fn("RadicleSourceControlProvider.createChangeRequest")(
      function* (input) {
        const fail = failure("createChangeRequest", input.cwd, "Failed to open the Radicle patch.");
        const branch = SourceControlProvider.sourceBranch(input);
        const body = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new SourceControlProviderError({
                provider: KIND,
                operation: "createChangeRequest",
                cwd: input.cwd,
                detail: "Could not read the patch description.",
                cause,
              }),
          ),
        );
        const output = yield* cli
          .git({
            operation: "createChangeRequest",
            cwd: input.cwd,
            args: [
              "push",
              "-o",
              `patch.message=${input.title}`,
              ...(body.trim().length > 0 ? ["-o", `patch.message=${body.trim()}`] : []),
              ...(input.draft ? ["-o", "patch.draft"] : []),
              "rad",
              `refs/heads/${branch}:refs/patches`,
            ],
          })
          .pipe(Effect.mapError(fail));
        const printed = PATCH_OPENED.exec(stripAnsi(`${output.stderr}\n${output.stdout}`))?.[1];
        const id = printed ?? (yield* openedPatchId(input.cwd, branch).pipe(Effect.mapError(fail)));
        // `rad` tracks the patch only from a branch that had no upstream; T3 may have set one.
        if (id !== undefined) {
          yield* host.git
            .writeConfigValue({ cwd: input.cwd, key: `branch.${branch}.remote`, value: "rad" })
            .pipe(
              Effect.andThen(
                host.git.writeConfigValue({
                  cwd: input.cwd,
                  key: `branch.${branch}.merge`,
                  value: `refs/heads/patches/${id}`,
                }),
              ),
              Effect.ignore,
            );
        }
      },
    ),

    getRepositoryCloneUrls: Effect.fn("RadicleSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        const rid = parseRid(input.repository);
        if (rid === null) {
          return yield* new SourceControlProviderError({
            provider: KIND,
            operation: "getRepositoryCloneUrls",
            cwd: input.cwd,
            repository: SourceControlProvider.transportSafeSourceControlErrorValue(
              input.repository,
            ),
            detail:
              "A Radicle repository is named by its ID, such as rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5.",
          });
        }
        return { nameWithOwner: `rad:${rid}`, url: `rad:${rid}`, sshUrl: `rad:${rid}` };
      },
    ),

    createRepository: Effect.fn("RadicleSourceControlProvider.createRepository")(function* (input) {
      const fail = failure(
        "createRepository",
        input.cwd,
        "Failed to create the Radicle repository.",
      );
      const name = input.repository.split("/").at(-1)?.trim() || input.repository;
      const branch = (yield* cli
        .git({
          operation: "createRepository",
          cwd: input.cwd,
          args: ["symbolic-ref", "--short", "HEAD"],
          allowNonZeroExit: true,
        })
        .pipe(Effect.mapError(fail))).stdout.trim();
      yield* cli
        .rad({
          operation: "createRepository",
          cwd: input.cwd,
          args: [
            "init",
            "--name",
            name,
            "--description",
            "",
            ...(branch.length > 0 ? ["--default-branch", branch] : []),
            input.visibility === "private" ? "--private" : "--public",
            "--set-upstream",
            "--no-confirm",
          ],
          timeoutMs: 120_000,
        })
        .pipe(Effect.mapError(fail));
      const repository = yield* cli.repository({ cwd: input.cwd }).pipe(Effect.mapError(fail));
      const id = `rad:${repository.rid}`;
      return { nameWithOwner: id, url: id, sshUrl: id };
    }),

    // `rad clone` seeds the repository and fetches it from the network first, which a plain
    // `git clone` of a `rad:` URL cannot do.
    cloneRepository: Effect.fn("RadicleSourceControlProvider.cloneRepository")(function* (input) {
      const rid = parseRadicleRemote(input.url)?.rid ?? parseRid(input.url);
      if (rid === null) {
        return yield* new SourceControlProviderError({
          provider: KIND,
          operation: "cloneRepository",
          cwd: input.cwd,
          detail:
            "A Radicle repository is cloned by its ID, such as rad:z3gqcJUoA1n9HaHKufZs5FCSGazv5.",
        });
      }
      yield* cli
        .rad({
          operation: "cloneRepository",
          cwd: input.cwd,
          args: ["clone", `rad:${rid}`, input.directory, "--timeout", "60s"],
          timeoutMs: 300_000,
        })
        .pipe(
          Effect.mapError(
            failure(
              "cloneRepository",
              input.cwd,
              "No seed this node can reach has the repository. Check that a seed you are connected to seeds it, or pass it with `rad clone --seed`.",
            ),
          ),
        );
    }),

    getDefaultBranch: Effect.fn("RadicleSourceControlProvider.getDefaultBranch")(function* (input) {
      const fail = failure("getDefaultBranch", input.cwd, "Failed to read the default branch.");
      const repository = yield* cli.repository({ cwd: input.cwd }).pipe(Effect.mapError(fail));
      return (yield* cli.project({ cwd: input.cwd, repository }).pipe(Effect.mapError(fail)))
        .defaultBranch;
    }),

    checkoutChangeRequest: Effect.fn("RadicleSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const fail = failure("checkoutChangeRequest", input.cwd, "Failed to check out the patch.");
        const number = patchNumberFromReference(input.reference);
        const repository = yield* cli.repository({ cwd: input.cwd }).pipe(Effect.mapError(fail));
        const patch =
          number === null
            ? null
            : yield* cli
                .getPatch({ cwd: input.cwd, repository, number })
                .pipe(Effect.mapError(fail));
        if (patch === null) {
          return yield* new SourceControlProviderError({
            provider: KIND,
            operation: "checkoutChangeRequest",
            cwd: input.cwd,
            detail: "Name a patch by its ID (at least 10 hex digits), number, or link.",
          });
        }
        yield* cli
          .rad({
            operation: "checkoutChangeRequest",
            cwd: input.cwd,
            args: ["patch", "checkout", patch.id, ...(input.force ? ["--force"] : [])],
            timeoutMs: 60_000,
          })
          .pipe(Effect.mapError(fail));
      },
    ),
  });
});

export const makeDiscovery = Effect.succeed({
  type: "cli",
  kind: KIND,
  label: "Radicle",
  installHint: RadicleCli.INSTALL_HINT,
  executable: "rad",
  versionArgs: ["--version"],
  authArgs: ["self", "--did"],
  parseAuth: ({ stdout, exitCode }) => {
    const did = stdout.trim();
    const signedIn = exitCode === 0 && did.startsWith("did:key:");
    return {
      status: signedIn ? "authenticated" : "unauthenticated",
      account: signedIn ? Option.some(did) : Option.none(),
      host: Option.some("radicle"),
      detail: signedIn
        ? Option.none()
        : Option.some("Run `rad auth` to create a Radicle identity."),
    };
  },
} satisfies SourceControlCliDiscoverySpec);
