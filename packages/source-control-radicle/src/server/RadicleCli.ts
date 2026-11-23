import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import { parseRid, patchNumberFromId, patchPrefixFromNumber } from "../shared/definition.ts";
import { RadiclePatchCob, type RadiclePatch, toRadiclePatch } from "./radiclePatchJson.ts";

export class RadicleCliError extends Schema.TaggedError<RadicleCliError>()("RadicleCliError", {
  operation: Schema.String,
  reason: Schema.Literals(["missing-cli", "unauthenticated", "not-found", "failed"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const INSTALL_HINT =
  "Install Radicle (`rad` 1.10 or later) from https://radicle.dev and run `rad auth` on the T3 Code server.";

// `rad` opens an editor when a message is missing; with no terminal that would hang, so fail.
const NO_EDITOR = { EDITOR: "false", VISUAL: "false", GIT_EDITOR: "false" };

export interface RadicleRepository {
  /** The repository ID without `rad:`, in its own case. */
  readonly rid: string;
  /** The node's copy of the repository, which holds every peer's refs and patch revisions. */
  readonly storage: string;
}

export interface RadicleProject {
  readonly name: string;
  readonly description: string;
  readonly defaultBranch: string;
  readonly delegates: ReadonlyArray<string>;
}

export interface RadicleSelf {
  readonly did: string;
  readonly alias: string | null;
}

const Payload = Schema.Struct({
  "xyz.radicle.project": Schema.Struct({
    name: Schema.String,
    description: Schema.optional(Schema.String),
    defaultBranch: Schema.String,
  }),
});
const decodePayload = decodeJsonResult(Payload);
const decodePatchCob = decodeJsonResult(RadiclePatchCob);

const DELEGATE_LINE = /^(did:key:\S+)(?:\s+\((.+)\))?$/u;

/** `rad clone` names a remote `alias@NID` for every delegate it knows. */
function aliasesFromRemoteNames(names: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const name of names) {
    const at = name.lastIndexOf("@");
    if (at <= 0) continue;
    const nid = name.slice(at + 1);
    if (/^z6Mk[1-9A-HJ-NP-Za-km-z]+$/u.test(nid)) aliases.set(`did:key:${nid}`, name.slice(0, at));
  }
  return aliases;
}

function parseDelegates(
  stdout: string,
): ReadonlyArray<{ readonly did: string; readonly alias: string | null }> {
  return stdout.split("\n").flatMap((line) => {
    const match = DELEGATE_LINE.exec(line.trim());
    return match?.[1] ? [{ did: match[1], alias: match[2] ?? null }] : [];
  });
}

interface RepositoryInput {
  readonly cwd: string;
  readonly repository: RadicleRepository;
}

export class RadicleCli extends Context.Service<
  RadicleCli,
  {
    readonly rad: (input: {
      readonly operation: string;
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
    }) => Effect.Effect<string, RadicleCliError>;
    /** Git in `cwd`, which may be the repository's storage. */
    readonly git: (input: {
      readonly operation: string;
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly allowNonZeroExit?: boolean;
      readonly maxOutputBytes?: number;
    }) => Effect.Effect<SourceControlHost.SourceControlProcessOutput, RadicleCliError>;
    readonly self: (cwd: string) => Effect.Effect<RadicleSelf, RadicleCliError>;
    /** The repository `selector` (`rad:z…`) names, else the one `cwd` is a checkout of. */
    readonly repository: (input: {
      readonly cwd: string;
      readonly selector?: string | undefined;
    }) => Effect.Effect<RadicleRepository, RadicleCliError>;
    readonly project: (input: RepositoryInput) => Effect.Effect<RadicleProject, RadicleCliError>;
    /** DIDs to aliases, from the delegates, the checkout's peer remotes, and this node. */
    readonly aliases: (
      input: RepositoryInput,
    ) => Effect.Effect<ReadonlyMap<string, string>, RadicleCliError>;
    readonly listPatches: (
      input: RepositoryInput,
    ) => Effect.Effect<ReadonlyArray<RadiclePatch>, RadicleCliError>;
    /** The patch whose ID starts with `number`'s hex digits. */
    readonly getPatch: (
      input: RepositoryInput & { readonly number: number },
    ) => Effect.Effect<RadiclePatch, RadicleCliError>;
  }
>()("@t3tools/source-control-radicle/server/RadicleCli") {}

const SHOW_BATCH = 100;

const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  let cachedSelf: RadicleSelf | null = null;
  let cachedHome: string | null = null;

  const toError = (operation: string, command: string) => (cause: { readonly _tag: string }) =>
    new RadicleCliError({
      operation,
      cause,
      ...(cause._tag === "VcsProcessSpawnError"
        ? { reason: "missing-cli" as const, detail: INSTALL_HINT }
        : { reason: "failed" as const, detail: `\`${command}\` failed in ${operation}.` }),
    });

  const rad: RadicleCli["Service"]["rad"] = (input) =>
    process
      .run({
        operation: `RadicleCli.${input.operation}`,
        command: "rad",
        args: input.args,
        cwd: input.cwd,
        env: NO_EDITOR,
        timeoutMs: input.timeoutMs ?? 30_000,
        maxOutputBytes: 16 * 1024 * 1024,
      })
      .pipe(
        Effect.map((output) => output.stdout),
        Effect.mapError(toError(input.operation, "rad")),
      );

  const git: RadicleCli["Service"]["git"] = (input) =>
    process
      .run({
        operation: `RadicleCli.${input.operation}`,
        command: "git",
        args: input.args,
        cwd: input.cwd,
        env: NO_EDITOR,
        timeoutMs: 60_000,
        ...(input.allowNonZeroExit ? { allowNonZeroExit: true } : {}),
        maxOutputBytes: input.maxOutputBytes ?? 16 * 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.mapError(toError(input.operation, "git")));

  const self = Effect.fn("RadicleCli.self")(function* (cwd: string) {
    if (cachedSelf !== null) return cachedSelf;
    const did = (yield* rad({ operation: "self", cwd, args: ["self", "--did"] })).trim();
    if (!did.startsWith("did:key:")) {
      return yield* new RadicleCliError({
        operation: "self",
        reason: "unauthenticated",
        detail: "Run `rad auth` on the T3 Code server to create a Radicle identity.",
      });
    }
    const alias = (yield* rad({ operation: "self", cwd, args: ["self", "--alias"] })).trim();
    cachedSelf = { did, alias: alias.length > 0 ? alias : null };
    return cachedSelf;
  });

  const home = Effect.fn("RadicleCli.home")(function* (cwd: string) {
    if (cachedHome !== null) return cachedHome;
    cachedHome = (yield* rad({ operation: "home", cwd, args: ["self", "--home"] })).trim();
    return cachedHome;
  });

  const repository = Effect.fn("RadicleCli.repository")(function* (input: {
    readonly cwd: string;
    readonly selector?: string | undefined;
  }) {
    const given = input.selector === undefined ? null : parseRid(input.selector);
    // The checkout's own ID has the case `rad` needs, which a lowercased selector lost.
    const local = yield* rad({ operation: "repository", cwd: input.cwd, args: ["."] }).pipe(
      Effect.map((stdout) => parseRid(stdout.trim())),
      Effect.orElseSucceed(() => null),
    );
    const rid =
      local !== null && (given === null || given.toLowerCase() === local.toLowerCase())
        ? local
        : given;
    if (rid === null) {
      return yield* new RadicleCliError({
        operation: "repository",
        reason: "not-found",
        detail: "This checkout is not a Radicle repository. Run `rad init` or `rad clone` first.",
      });
    }
    return { rid, storage: `${yield* home(input.cwd)}/storage/${rid}` };
  });

  const project = Effect.fn("RadicleCli.project")(function* (input: RepositoryInput) {
    const repo = `rad:${input.repository.rid}`;
    const [payloadOutput, delegatesOutput] = yield* Effect.all(
      [
        rad({ operation: "project", cwd: input.cwd, args: ["inspect", repo, "--payload"] }),
        rad({ operation: "project", cwd: input.cwd, args: ["inspect", repo, "--delegates"] }),
      ],
      { concurrency: 2 },
    );
    const payload = decodePayload(payloadOutput);
    if (Result.isFailure(payload)) {
      return yield* new RadicleCliError({
        operation: "project",
        reason: "failed",
        detail: "Could not read the repository's Radicle project payload.",
        cause: payload.failure,
      });
    }
    const data = payload.success["xyz.radicle.project"];
    return {
      name: data.name,
      description: data.description ?? "",
      defaultBranch: data.defaultBranch,
      delegates: parseDelegates(delegatesOutput).map((delegate) => delegate.did),
    } satisfies RadicleProject;
  });

  const aliases = Effect.fn("RadicleCli.aliases")(function* (input: RepositoryInput) {
    const [delegates, remotes, me] = yield* Effect.all(
      [
        rad({
          operation: "aliases",
          cwd: input.cwd,
          args: ["inspect", `rad:${input.repository.rid}`, "--delegates"],
        }),
        git({ operation: "aliases", cwd: input.cwd, args: ["remote"], allowNonZeroExit: true }),
        self(input.cwd),
      ],
      { concurrency: 3 },
    );
    const map = new Map(
      aliasesFromRemoteNames(remotes.stdout.split("\n").map((name) => name.trim())),
    );
    for (const delegate of parseDelegates(delegates)) {
      if (delegate.alias !== null) map.set(delegate.did, delegate.alias);
    }
    if (me.alias !== null) map.set(me.did, me.alias);
    return map;
  });

  const listPatchIds = (input: RepositoryInput) =>
    rad({
      operation: "listPatches",
      cwd: input.cwd,
      args: ["cob", "list", "--repo", `rad:${input.repository.rid}`, "--type", "xyz.radicle.patch"],
    }).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^[0-9a-f]{40}$/u.test(line)),
      ),
    );

  const showPatches = Effect.fn("RadicleCli.showPatches")(function* (
    input: RepositoryInput & { readonly ids: ReadonlyArray<string> },
  ) {
    const patches: Array<RadiclePatch> = [];
    for (let start = 0; start < input.ids.length; start += SHOW_BATCH) {
      const ids = input.ids.slice(start, start + SHOW_BATCH);
      const requested = new Set(ids);
      const stdout = yield* rad({
        operation: "showPatches",
        cwd: input.cwd,
        args: [
          "cob",
          "show",
          "--repo",
          `rad:${input.repository.rid}`,
          "--type",
          "xyz.radicle.patch",
          ...ids.flatMap((id) => ["--object", id]),
        ],
      });
      for (const line of stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        const cob = decodePatchCob(line);
        if (Result.isFailure(cob)) {
          return yield* new RadicleCliError({
            operation: "showPatches",
            reason: "failed",
            detail: "Could not read a Radicle patch. Check that `rad` is version 1.10 or later.",
            cause: cob.failure,
          });
        }
        const patch = toRadiclePatch(cob.success, requested);
        if (patch !== null) patches.push(patch);
      }
    }
    return patches;
  });

  const listPatches = Effect.fn("RadicleCli.listPatches")(function* (input: RepositoryInput) {
    const ids = yield* listPatchIds(input);
    return yield* showPatches({ ...input, ids });
  });

  const getPatch = Effect.fn("RadicleCli.getPatch")(function* (
    input: RepositoryInput & { readonly number: number },
  ) {
    const prefix = patchPrefixFromNumber(input.number);
    const ids = (yield* listPatchIds(input)).filter(
      (id) => id.startsWith(prefix) && patchNumberFromId(id) === input.number,
    );
    const [patch] = ids.length === 1 ? yield* showPatches({ ...input, ids }) : [];
    if (patch === undefined) {
      return yield* new RadicleCliError({
        operation: "getPatch",
        reason: "not-found",
        detail:
          ids.length > 1
            ? `More than one patch starts with ${prefix}.`
            : `No patch starting with ${prefix} was found in this repository.`,
      });
    }
    return patch;
  });

  return RadicleCli.of({ rad, git, self, repository, project, aliases, listPatches, getPatch });
});

export const layer = Layer.effect(RadicleCli, make);
