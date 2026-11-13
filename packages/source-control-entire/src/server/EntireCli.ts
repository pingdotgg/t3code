import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  firstNonEmptyLine,
  isMissingExecutable,
} from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

const TOKEN_TTL = Duration.minutes(5);
const MISSING_TTL = Duration.seconds(10);
const REPOSITORY_TTL = Duration.minutes(30);
const TIMEOUT_MS = 15_000;
const MAX_DETAIL = 300;

/** Every `entire` run: no telemetry for a program the user did not type. */
export const ENTIRE_CLI_ENV: NodeJS.ProcessEnv = { ENTIRE_TELEMETRY_OPTOUT: "1" };

export class EntireCliMissingError extends Schema.TaggedError<EntireCliMissingError>()(
  "EntireCliMissingError",
  {},
) {
  override get message(): string {
    return "The Entire CLI is not installed on the server. Install it from https://entire.com, then run `entire login`.";
  }
}

export class EntireNotSignedInError extends Schema.TaggedError<EntireNotSignedInError>()(
  "EntireNotSignedInError",
  {},
) {
  override get message(): string {
    return "The Entire CLI on the server is not signed in. Run `entire login`.";
  }
}

export class EntireCliFailedError extends Schema.TaggedError<EntireCliFailedError>()(
  "EntireCliFailedError",
  { operation: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `The Entire CLI could not ${this.operation}: ${this.detail}`;
  }
}

export type EntireCliError = EntireCliMissingError | EntireNotSignedInError | EntireCliFailedError;

export interface EntireRepositoryCoordinates {
  readonly repoId: string;
  readonly projectId: string | null;
  readonly apiUrl: string;
  /** The cluster a clone goes to: the native primary, else the first ready placement. */
  readonly cluster: string | null;
}

/** One of Entire's processing cells, as `entire cluster list` names it. */
export interface EntireCell {
  readonly slug: string;
  readonly jurisdiction: string;
  readonly apiUrl: string;
}

export class EntireCli extends Context.Service<
  EntireCli,
  {
    readonly repository: (
      reference: string,
    ) => Effect.Effect<EntireRepositoryCoordinates, EntireCliError>;
    readonly token: Effect.Effect<Redacted.Redacted<string>, EntireCliError>;
    readonly invalidateToken: Effect.Effect<void>;
    readonly viewer: Effect.Effect<string, EntireCliError>;
    /** Where a project trail is served: its project's processing cell, not a repository's. */
    readonly cells: Effect.Effect<ReadonlyArray<EntireCell>, EntireCliError>;
  }
>()("@t3tools/source-control-entire/server/EntireCli") {}

const decodeClusterList = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(
      Schema.Struct({ slug: Schema.String, jurisdiction: Schema.String, apiUrl: Schema.String }),
    ),
  ),
);

const decodeRepositoryView = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      repoId: Schema.optional(Schema.String),
      owningProjectId: Schema.optional(Schema.String),
      apiUrl: Schema.optional(Schema.String),
      placements: Schema.optional(
        Schema.Array(
          Schema.Struct({
            cluster: Schema.String,
            status: Schema.optional(Schema.String),
            role: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
);

export const decodeAuthStatus = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      logged_in: Schema.Boolean,
      user: Schema.optional(Schema.String),
      server: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
    }),
  ),
);

// `auth status` says `github:alice`; trails spell people by the bare login.
function viewerLogin(user: string | undefined): string | null {
  const handle = user?.trim().split(":").at(-1)?.trim();
  return handle ? handle : null;
}

export function boundedDetail(text: string | undefined): string | undefined {
  const line = text?.replace(/\s+/gu, " ").trim();
  if (!line) return undefined;
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL)}…` : line;
}

// `repo view --json` exits 0 without `repoId` and `apiUrl` when it cannot place the repository.
function parseRepositoryView(stdout: string): EntireRepositoryCoordinates | null {
  const view = Option.getOrUndefined(decodeRepositoryView(stdout.trim()));
  const repoId = view?.repoId?.trim();
  const apiUrl = view?.apiUrl?.trim();
  if (!repoId || !apiUrl) return null;
  const placements = view?.placements ?? [];
  const placement =
    placements.find((candidate) => candidate.role === "primary") ??
    placements.find((candidate) => candidate.status === "ready") ??
    placements[0];
  return {
    repoId,
    projectId: view?.owningProjectId?.trim() || null,
    apiUrl,
    cluster: placement?.cluster.trim() || null,
  };
}

/** @public */
export const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const workingDirectory = yield* HostProcess.WorkingDirectory;

  const run = (operation: string, args: ReadonlyArray<string>) =>
    process
      .run({
        operation,
        command: "entire",
        args,
        cwd: workingDirectory,
        env: ENTIRE_CLI_ENV,
        allowNonZeroExit: true,
        timeoutMs: TIMEOUT_MS,
        maxOutputBytes: 64_000,
      })
      .pipe(
        Effect.mapError((error) =>
          isMissingExecutable(error)
            ? new EntireCliMissingError()
            : new EntireCliFailedError({
                operation: "run",
                detail: "The Entire CLI did not finish.",
                cause: error,
              }),
        ),
      );

  const lookupRepository = Effect.fn("EntireCli.repository")(function* (reference: string) {
    const output = yield* run("EntireCli.repository", ["repo", "view", reference, "--json"]);
    if (output.exitCode !== 0)
      return yield* new EntireCliFailedError({
        operation: "find the repository",
        detail:
          boundedDetail(Option.getOrUndefined(firstNonEmptyLine(output.stderr))) ??
          `\`entire repo view\` exited ${output.exitCode}.`,
      });
    const coordinates = parseRepositoryView(output.stdout);
    if (coordinates === null)
      return yield* new EntireCliFailedError({
        operation: "find the repository",
        detail: "Entire did not say which API cell serves this repository.",
      });
    return coordinates;
  });

  const lookupToken = Effect.fn("EntireCli.token")(function* () {
    // `auth token` prints only the bearer on stdout; its not-signed-in hint goes to stderr.
    const output = yield* run("EntireCli.token", ["auth", "token"]);
    const token = output.stdout.trim();
    if (output.exitCode !== 0 || token.length === 0 || /\s/u.test(token))
      return yield* new EntireNotSignedInError();
    return Redacted.make(token);
  });

  const lookupViewer = Effect.fn("EntireCli.viewer")(function* () {
    const output = yield* run("EntireCli.viewer", ["auth", "status", "--json"]);
    const status = Option.getOrUndefined(decodeAuthStatus(output.stdout.trim()));
    const login = status?.logged_in ? viewerLogin(status.user) : null;
    if (login === null) return yield* new EntireNotSignedInError();
    return login;
  });

  const lookupCells = Effect.fn("EntireCli.cells")(function* () {
    const output = yield* run("EntireCli.cells", ["cluster", "list", "--json"]);
    const cells = output.exitCode === 0 ? decodeClusterList(output.stdout.trim()) : Option.none();
    if (Option.isNone(cells))
      return yield* new EntireCliFailedError({
        operation: "list Entire's cells",
        detail:
          boundedDetail(Option.getOrUndefined(firstNonEmptyLine(output.stderr))) ??
          `\`entire cluster list\` exited ${output.exitCode}.`,
      });
    return cells.value;
  });

  const repositories = yield* Cache.makeWith(lookupRepository, {
    capacity: 64,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? REPOSITORY_TTL : Duration.zero),
  });
  const signedInTtl = (exit: Exit.Exit<unknown, EntireCliError>) =>
    Exit.isSuccess(exit)
      ? TOKEN_TTL
      : Exit.findErrorOption(exit).pipe(
            Option.exists((error) => error._tag === "EntireCliFailedError"),
          )
        ? Duration.zero
        : MISSING_TTL;
  const tokens = yield* Cache.makeWith(lookupToken, { capacity: 1, timeToLive: signedInTtl });
  const viewers = yield* Cache.makeWith(lookupViewer, { capacity: 1, timeToLive: signedInTtl });
  const cells = yield* Cache.makeWith(lookupCells, {
    capacity: 1,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? REPOSITORY_TTL : Duration.zero),
  });

  return EntireCli.of({
    repository: Effect.fn("EntireCli.repository")((reference) =>
      Cache.get(repositories, reference),
    ),
    token: Cache.get(tokens, "token"),
    invalidateToken: Effect.andThen(
      Cache.invalidate(tokens, "token"),
      Cache.invalidate(viewers, "viewer"),
    ),
    viewer: Cache.get(viewers, "viewer"),
    cells: Cache.get(cells, "cells"),
  });
});

export const layer = Layer.effect(EntireCli, make);
