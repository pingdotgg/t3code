import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";

import {
  KIND,
  parseRid,
  patchNumberFromId,
  patchPrefixFromNumber,
  settings,
} from "../shared/definition.ts";
import { RadicleIssueCob, type RadicleIssue, toRadicleIssue } from "./radicleIssueJson.ts";
import { parseJobLog, type RadicleJob } from "./radicleJobJson.ts";
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
const decodeIssueCob = decodeJsonResult(RadicleIssueCob);

const PATCH_TYPE = "xyz.radicle.patch";
const ISSUE_TYPE = "xyz.radicle.issue";
const JOB_TYPE = "xyz.radworks.job";
type CobType = typeof PATCH_TYPE | typeof ISSUE_TYPE | typeof JOB_TYPE;

const LOG_TAIL_BYTES = 4 * 1024 * 1024;

/** A path from a job record, safe to hand to a remote shell as one word. */
const LOG_PATH = /^\/[A-Za-z0-9._/-]+$/u;

const DELEGATE_LINE = /^(did:key:\S+)(?:\s+\((.+)\))?$/u;
// A row of `rad follow`'s table: DID, alias, policy.
const FOLLOW_ROW = /(did:key:z[1-9A-HJ-NP-Za-km-z]+)\s+(\S+)\s+(?:allow|block)\b/u;

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
    readonly listIssues: (
      input: RepositoryInput,
    ) => Effect.Effect<ReadonlyArray<RadicleIssue>, RadicleCliError>;
    /** The issue whose ID is `key` or starts with it. */
    readonly getIssue: (
      input: RepositoryInput & { readonly key: string },
    ) => Effect.Effect<RadicleIssue, RadicleCliError>;
    /** radicle-ci-broker's jobs for any of `commits`, or every job when absent. */
    readonly listJobs: (
      input: RepositoryInput & { readonly commits?: ReadonlyArray<string> },
    ) => Effect.Effect<ReadonlyArray<RadicleJob>, RadicleCliError>;
    /** A run's log from its job record's `file://` URL, on the configured CI host. */
    readonly readJobLog: (input: {
      readonly cwd: string;
      readonly url: string;
    }) => Effect.Effect<string, RadicleCliError>;
    /** Queues a rerun of `commit` with the configured rerun command. */
    readonly rerunJob: (
      input: RepositoryInput & { readonly commit: string },
    ) => Effect.Effect<void, RadicleCliError>;
    /** The patch whose ID starts with `number`'s hex digits. */
    readonly getPatch: (
      input: RepositoryInput & { readonly number: number },
    ) => Effect.Effect<RadiclePatch, RadicleCliError>;
  }
>()("@t3tools/source-control-radicle/server/RadicleCli") {}

const SHOW_BATCH = 100;

const make = Effect.gen(function* () {
  const { process, settings: hostSettings } = yield* SourceControlHost.SourceControlHost;
  const fileSystem = yield* FileSystem.FileSystem;
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
    // Callers may lowercase the selector, and `rad` needs the ID's case: the checkout's own ID
    // and the node's storage, named by ID, both keep it.
    const wanted = input.selector?.trim().replace(/^rad:/u, "").toLowerCase() || null;
    const local = yield* rad({ operation: "repository", cwd: input.cwd, args: ["."] }).pipe(
      Effect.map((stdout) => parseRid(stdout.trim())),
      Effect.orElseSucceed(() => null),
    );
    const stored =
      wanted === null || local?.toLowerCase() === wanted
        ? null
        : yield* fileSystem.readDirectory(`${yield* home(input.cwd)}/storage`).pipe(
            Effect.map((names) => names.find((name) => name.toLowerCase() === wanted) ?? null),
            Effect.orElseSucceed(() => null),
          );
    const rid = wanted === null || local?.toLowerCase() === wanted ? local : stored;
    if (rid === null) {
      return yield* new RadicleCliError({
        operation: "repository",
        reason: "not-found",
        detail:
          wanted === null
            ? "This checkout is not a Radicle repository. Run `rad init` or `rad clone` first."
            : "This node does not have that Radicle repository. Clone it with `rad clone` first.",
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
    const [delegates, remotes, follows, me] = yield* Effect.all(
      [
        rad({
          operation: "aliases",
          cwd: input.cwd,
          args: ["inspect", `rad:${input.repository.rid}`, "--delegates"],
        }),
        git({ operation: "aliases", cwd: input.cwd, args: ["remote"], allowNonZeroExit: true }),
        // Followed nodes, such as a CI node, are named nowhere else.
        rad({ operation: "aliases", cwd: input.cwd, args: ["follow"] }).pipe(
          Effect.orElseSucceed(() => ""),
        ),
        self(input.cwd),
      ],
      { concurrency: 4 },
    );
    const map = new Map(
      aliasesFromRemoteNames(remotes.stdout.split("\n").map((name) => name.trim())),
    );
    for (const line of follows.split("\n")) {
      const row = FOLLOW_ROW.exec(line);
      if (row?.[1] && row[2]) map.set(row[1], row[2]);
    }
    for (const delegate of parseDelegates(delegates)) {
      if (delegate.alias !== null) map.set(delegate.did, delegate.alias);
    }
    if (me.alias !== null) map.set(me.did, me.alias);
    return map;
  });

  const listCobIds = (input: RepositoryInput, type: CobType) =>
    rad({
      operation: "listCobs",
      cwd: input.cwd,
      args: ["cob", "list", "--repo", `rad:${input.repository.rid}`, "--type", type],
    }).pipe(
      Effect.map((stdout) =>
        stdout
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^[0-9a-f]{40}$/u.test(line)),
      ),
    );

  /** One JSON document per object, in batches so a long list stays within argument limits. */
  const showCobs = Effect.fn("RadicleCli.showCobs")(function* <A>(
    input: RepositoryInput & { readonly ids: ReadonlyArray<string> },
    type: CobType,
    decode: (line: string, requested: ReadonlySet<string>) => Result.Result<A | null, unknown>,
  ) {
    const objects: Array<A> = [];
    for (let start = 0; start < input.ids.length; start += SHOW_BATCH) {
      const ids = input.ids.slice(start, start + SHOW_BATCH);
      const requested = new Set(ids);
      const stdout = yield* rad({
        operation: "showCobs",
        cwd: input.cwd,
        args: [
          "cob",
          "show",
          "--repo",
          `rad:${input.repository.rid}`,
          "--type",
          type,
          ...ids.flatMap((id) => ["--object", id]),
        ],
      });
      for (const line of stdout.split("\n")) {
        if (line.trim().length === 0) continue;
        const decoded = decode(line, requested);
        if (Result.isFailure(decoded)) {
          return yield* new RadicleCliError({
            operation: "showCobs",
            reason: "failed",
            detail: `Could not read a Radicle ${type === PATCH_TYPE ? "patch" : type === ISSUE_TYPE ? "issue" : "CI job"}. Check that \`rad\` is version 1.10 or later.`,
            cause: decoded.failure,
          });
        }
        if (decoded.success !== null) objects.push(decoded.success);
      }
    }
    return objects;
  });

  const decodePatch = (line: string, requested: ReadonlySet<string>) =>
    Result.map(decodePatchCob(line), (cob) => toRadiclePatch(cob, requested));
  const decodeIssue = (line: string, requested: ReadonlySet<string>) =>
    Result.map(decodeIssueCob(line), (cob) => toRadicleIssue(cob, requested));

  const listPatches = Effect.fn("RadicleCli.listPatches")(function* (input: RepositoryInput) {
    const ids = yield* listCobIds(input, PATCH_TYPE);
    return yield* showCobs({ ...input, ids }, PATCH_TYPE, decodePatch);
  });

  const getPatch = Effect.fn("RadicleCli.getPatch")(function* (
    input: RepositoryInput & { readonly number: number },
  ) {
    const prefix = patchPrefixFromNumber(input.number);
    const ids = (yield* listCobIds(input, PATCH_TYPE)).filter(
      (id) => id.startsWith(prefix) && patchNumberFromId(id) === input.number,
    );
    const [patch] =
      ids.length === 1 ? yield* showCobs({ ...input, ids }, PATCH_TYPE, decodePatch) : [];
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

  const listIssues = Effect.fn("RadicleCli.listIssues")(function* (input: RepositoryInput) {
    const ids = yield* listCobIds(input, ISSUE_TYPE);
    return yield* showCobs({ ...input, ids }, ISSUE_TYPE, decodeIssue);
  });

  const getIssue = Effect.fn("RadicleCli.getIssue")(function* (
    input: RepositoryInput & { readonly key: string },
  ) {
    const key = input.key.trim().toLowerCase();
    const ids = /^[0-9a-f]{7,40}$/u.test(key)
      ? (yield* listCobIds(input, ISSUE_TYPE)).filter((id) => id.startsWith(key))
      : [];
    const [issue] =
      ids.length === 1 ? yield* showCobs({ ...input, ids }, ISSUE_TYPE, decodeIssue) : [];
    if (issue === undefined) {
      return yield* new RadicleCliError({
        operation: "getIssue",
        reason: "not-found",
        detail:
          ids.length > 1
            ? `More than one issue starts with ${key}.`
            : "No such issue in this repository. Name it by its ID or an ID prefix.",
      });
    }
    return issue;
  });

  // A job's commit never changes, so each record is read in full once to learn it.
  const jobCommits = new Map<string, string>();

  const readJob = (input: RepositoryInput, id: string) =>
    rad({
      operation: "readJob",
      cwd: input.cwd,
      args: [
        "cob",
        "log",
        "--repo",
        `rad:${input.repository.rid}`,
        "--type",
        JOB_TYPE,
        "--object",
        id,
        "--format",
        "json",
      ],
    }).pipe(Effect.map((stdout) => parseJobLog(id, stdout)));

  const listJobs = Effect.fn("RadicleCli.listJobs")(function* (
    input: RepositoryInput & { readonly commits?: ReadonlyArray<string> },
  ) {
    const wanted = input.commits === undefined ? null : new Set(input.commits);
    const ids = yield* listCobIds(input, JOB_TYPE);
    const jobs: Array<RadicleJob> = [];
    for (const id of ids) {
      const known = jobCommits.get(id);
      if (known !== undefined && wanted !== null && !wanted.has(known)) continue;
      const job = yield* readJob(input, id);
      if (job === null) continue;
      jobCommits.set(id, job.commit);
      if (wanted === null || wanted.has(job.commit)) jobs.push(job);
    }
    return jobs;
  });

  const ciSettings = hostSettings.get.pipe(
    Effect.map((saved) => readSourceControlHostSettings(settings, saved.sourceControlHosts[KIND])),
    Effect.orElseSucceed(() => readSourceControlHostSettings(settings, {})),
  );

  const readJobLog = Effect.fn("RadicleCli.readJobLog")(function* (input: {
    readonly cwd: string;
    readonly url: string;
  }) {
    // Not decoded: the path's character class has no `%`, so an escaped path is refused.
    const path = input.url.startsWith("file://") ? input.url.slice("file://".length) : null;
    if (path === null || !LOG_PATH.test(path) || path.includes("..")) {
      return yield* new RadicleCliError({
        operation: "readJobLog",
        reason: "not-found",
        detail: "Only a file:// log path from a CI job record can be read.",
      });
    }
    const { ciHost } = yield* ciSettings;
    const host = ciHost.trim();
    if (host.length === 0) {
      return yield* fileSystem.readFileString(path).pipe(
        Effect.map((text) => text.slice(-LOG_TAIL_BYTES)),
        Effect.mapError(
          (cause) =>
            new RadicleCliError({
              operation: "readJobLog",
              reason: "not-found",
              detail: "The log is not on this machine. Set the CI host in Radicle's settings.",
              cause,
            }),
        ),
      );
    }
    const output = yield* process
      .run({
        operation: "RadicleCli.readJobLog",
        command: "ssh",
        // The end of a log is where a failure is, so only the tail crosses the network.
        args: ["-o", "BatchMode=yes", "--", host, "tail", "-c", String(LOG_TAIL_BYTES), "--", path],
        cwd: input.cwd,
        timeoutMs: 30_000,
        maxOutputBytes: LOG_TAIL_BYTES + 1024,
        outputMode: "truncate",
      })
      .pipe(Effect.mapError(toError("readJobLog", "ssh")));
    return output.stdout;
  });

  const rerunJob = Effect.fn("RadicleCli.rerunJob")(function* (
    input: RepositoryInput & { readonly commit: string },
  ) {
    const { ciHost, ciRerunCommand } = yield* ciSettings;
    const command = ciRerunCommand.trim();
    if (command.length === 0 || !/^[0-9a-f]{40}$/u.test(input.commit)) {
      return yield* new RadicleCliError({
        operation: "rerunJob",
        reason: "failed",
        detail: "Set the CI rerun command in Radicle's settings to rerun CI from T3 Code.",
      });
    }
    const target = [`rad:${input.repository.rid}`, input.commit];
    const host = ciHost.trim();
    yield* process
      .run({
        operation: "RadicleCli.rerunJob",
        ...(host.length === 0
          ? { command, args: target }
          : { command: "ssh", args: ["-o", "BatchMode=yes", "--", host, command, ...target] }),
        cwd: input.cwd,
        timeoutMs: 60_000,
      })
      .pipe(Effect.mapError(toError("rerunJob", host.length === 0 ? command : "ssh")));
  });

  return RadicleCli.of({
    rad,
    git,
    self,
    repository,
    project,
    aliases,
    listPatches,
    getPatch,
    listIssues,
    getIssue,
    listJobs,
    readJobLog,
    rerunJob,
  });
});

export const layer = Layer.effect(RadicleCli, make);
