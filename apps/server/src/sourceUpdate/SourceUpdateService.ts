import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ServerSourceUpdateError,
  type ServerPullUpstreamResult,
  type ServerRunSourceUpdateInput,
  type ServerSourceUpdateResult,
  type ServerSourceUpdateStatus,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ACTIVE_RUN_STATUSES } from "../orchestration-v2/ThreadManagementService.ts";
import {
  SOURCE_CHECKOUT_ENV,
  sourceCheckoutConfig,
  sourceUpdateCommandConfig,
} from "./sourceCheckout.ts";

const UPDATE_UNIT = "t3code-source-update";
const FETCH_INTERVAL = Duration.minutes(5);
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

// No tty: a credential prompt would hang until the timeout, so git must fail instead.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", LANGUAGE: "C" };

export const PULL_UPSTREAM_PROMPT = `Merge upstream into this checkout. It is the source the T3 Code server you are running in is built from.

1. \`git fetch origin upstream\` and make sure the working tree is clean and on \`main\`, up to date with \`origin/main\`.
2. \`git merge upstream/main\`. Resolve every conflict so both sides' intent survives; read the upstream commits when a resolution is not obvious, and ask me when it is a real product decision.
3. Run \`vp i\` and \`vp run check:changed\`, and fix what fails.
4. Push to \`origin main\`. Never push to \`upstream\` or open pull requests against it.

Do not build or restart the server; I run Update from the app once this is pushed.`;

const RESULT_LINE = /^\[source-update\] (succeeded|failed) (\S+)(?: (.*))?$/;

/** The last outcome line `scripts/self-update.sh` wrote to the log. */
export const parseLastSourceUpdateResult = (log: string): ServerSourceUpdateResult | null => {
  const lines = log.split("\n");
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = RESULT_LINE.exec(lines[index]!.trim());
    if (match === null) continue;
    const finishedAt = DateTime.make(match[2]!);
    if (Option.isNone(finishedAt)) continue;
    return {
      outcome: match[1] as ServerSourceUpdateResult["outcome"],
      finishedAt: DateTime.formatIso(finishedAt.value),
      message: match[3]?.trim() ?? "",
    };
  }
  return null;
};

/** `git log -1 --format=%h%x00%s` output. */
const parseHeadCommit = (output: string) => {
  const [sha = "", subject = ""] = output.trim().split("\0");
  return { sha, subject };
};

/** `git rev-list --count` output, or null when the range did not resolve. */
const parseCommitCount = (output: ProcessRunner.ProcessRunOutput): number | null => {
  if (output.code !== 0) return null;
  const count = Number.parseInt(output.stdout.trim(), 10);
  return Number.isFinite(count) && count >= 0 ? count : null;
};

export class SourceUpdateService extends Context.Service<
  SourceUpdateService,
  {
    readonly status: Effect.Effect<ServerSourceUpdateStatus, ServerSourceUpdateError>;
    readonly update: (
      input: ServerRunSourceUpdateInput,
    ) => Effect.Effect<void, ServerSourceUpdateError>;
    readonly pullUpstream: Effect.Effect<ServerPullUpstreamResult, ServerSourceUpdateError>;
  }
>()("t3/sourceUpdate/SourceUpdateService") {}

const unavailable = new ServerSourceUpdateError({
  reason: "unavailable",
  detail: `This server does not run from a source checkout; set ${SOURCE_CHECKOUT_ENV} to enable source updates.`,
});

const failed = (detail: string) => (cause: unknown) =>
  new ServerSourceUpdateError({ reason: "failed", detail, cause });

const make = Effect.gen(function* () {
  const checkoutOption = yield* sourceCheckoutConfig;
  const updateCommandOption = yield* sourceUpdateCommandConfig;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;

  if (Option.isNone(checkoutOption)) {
    return SourceUpdateService.of({
      status: Effect.fail(unavailable),
      update: Effect.fn("SourceUpdateService.update")(function* (_input) {
        return yield* unavailable;
      }),
      pullUpstream: Effect.fail(unavailable),
    });
  }
  const checkout = checkoutOption.value;
  const updateCommand = Option.getOrElse(updateCommandOption, () =>
    path.join(checkout, "scripts", "self-update.sh"),
  );
  const logPath = path.join(config.logsDir, "source-update.log");

  const git = (args: ReadonlyArray<string>, timeout: Duration.Input = "30 seconds") =>
    runner.run({ command: "git", args: ["-C", checkout, ...args], env: GIT_ENV, timeout });

  const fetchedAt = yield* Ref.make<string | null>(null);
  // Every client polls status; the remotes are fetched at most once per interval for all of them.
  const fetchRemotes = yield* Effect.gen(function* () {
    const results = yield* Effect.forEach(
      ["origin", "upstream"],
      (remote) =>
        git(["fetch", "--quiet", remote, "main"], "1 minute").pipe(
          Effect.map((output) => output.code === 0),
          Effect.orElseSucceed(() => false),
        ),
      { concurrency: "unbounded" },
    );
    if (results.some(Boolean)) {
      yield* Ref.set(fetchedAt, DateTime.formatIso(yield* DateTime.now));
    }
  }).pipe(Effect.cachedWithTTL(FETCH_INTERVAL));

  const updateRunning = runner
    .run({ command: "systemctl", args: ["--user", "is-active", UPDATE_UNIT] })
    .pipe(
      Effect.map((output) => ["active", "activating", "reloading"].includes(output.stdout.trim())),
      Effect.orElseSucceed(() => false),
    );

  const lastResult = fs.readFileString(logPath).pipe(
    Effect.map(parseLastSourceUpdateResult),
    Effect.orElseSucceed(() => null),
  );

  const status: SourceUpdateService["Service"]["status"] = Effect.gen(function* () {
    const head = git(["log", "-1", "--format=%h%x00%s", "HEAD"]).pipe(
      Effect.filterOrFail(
        (output) => output.code === 0,
        (output) => new Error(output.stderr.trim()),
      ),
      Effect.mapError(failed(`Could not read the checkout at ${checkout}.`)),
    );
    const count = (ref: string) =>
      git(["rev-list", "--count", `HEAD..${ref}`]).pipe(
        Effect.map(parseCommitCount),
        Effect.orElseSucceed(() => null),
      );
    const counts = Effect.andThen(
      fetchRemotes,
      Effect.all([count("origin/main"), count("upstream/main")], { concurrency: "unbounded" }),
    );
    const [headOutput, [behindOrigin, upstreamAhead], running, result] = yield* Effect.all(
      [head, counts, updateRunning, lastResult],
      { concurrency: "unbounded" },
    );
    return {
      head: parseHeadCommit(headOutput.stdout),
      behindOrigin,
      upstreamAhead,
      fetchedAt: yield* Ref.get(fetchedAt),
      updateRunning: running,
      lastResult: result,
    };
  }).pipe(Effect.withSpan("SourceUpdateService.status"));

  const hasActiveRun = sql<{ readonly active: number }>`
    SELECT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_runs
      WHERE status IN ${sql.in(ACTIVE_RUN_STATUSES)}
    ) AS active
  `.pipe(
    Effect.map((rows) => rows[0]?.active === 1),
    Effect.mapError(failed("Could not check for running turns.")),
  );

  const update: SourceUpdateService["Service"]["update"] = Effect.fn("SourceUpdateService.update")(
    function* (input) {
      if (input.force !== true && (yield* hasActiveRun)) {
        return yield* new ServerSourceUpdateError({
          reason: "turns-running",
          detail: "Agents are working on this server. Updating restarts it and stops their turns.",
        });
      }
      if (yield* updateRunning) {
        return yield* new ServerSourceUpdateError({
          reason: "update-running",
          detail: "An update is already running.",
        });
      }
      yield* fs
        .makeDirectory(config.logsDir, { recursive: true })
        .pipe(Effect.mapError(failed(`Could not create ${config.logsDir}.`)));
      // A transient unit outside the server's cgroup, so the service restart does not kill it.
      const output = yield* runner
        .run({
          command: "systemd-run",
          args: [
            "--user",
            "--unit",
            UPDATE_UNIT,
            "--collect",
            "--quiet",
            `--working-directory=${checkout}`,
            `--setenv=${SOURCE_CHECKOUT_ENV}=${checkout}`,
            // stderr inherits this descriptor; a second one on the file would overwrite it.
            "-p",
            `StandardOutput=truncate:${logPath}`,
            updateCommand,
          ],
        })
        .pipe(Effect.mapError(failed("Could not start the update.")));
      if (output.code !== 0) {
        return yield* new ServerSourceUpdateError({
          // Another request started the unit between the check above and this launch.
          reason: output.stderr.includes("already") ? "update-running" : "failed",
          detail: `Could not start the update: ${output.stderr.trim() || `systemd-run exited with ${String(output.code)}`}`,
        });
      }
    },
  );

  const pullUpstream: SourceUpdateService["Service"]["pullUpstream"] = Effect.gen(function* () {
    const { project } = yield* projects
      .bootstrap({
        commandId: CommandId.make(yield* random.uuidV4()),
        projectId: ProjectId.make(yield* random.uuidV4()),
        title: path.basename(checkout) || "t3code",
        workspaceRoot: checkout,
      })
      .pipe(Effect.mapError(failed(`Could not open the project at ${checkout}.`)));
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(failed("Could not read server settings.")),
    );
    const launched = yield* threadLaunch
      .launch({
        commandId: CommandId.make(yield* random.uuidV4()),
        projectId: project.id,
        title: "Merge upstream",
        modelSelection: {
          instanceId: defaultInstanceIdForDriver(CLAUDE_DRIVER),
          model: DEFAULT_MODEL_BY_PROVIDER[CLAUDE_DRIVER]!,
        },
        runtimeMode: resolveProjectSettings(settings, project.id, project).settings
          .defaultRuntimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        workspaceStrategy: { type: "root" },
        initialMessage: { text: PULL_UPSTREAM_PROMPT, attachments: [] },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError((error) => failed(error.message)(error)));
    return { projectId: project.id, threadId: launched.threadId };
  }).pipe(Effect.withSpan("SourceUpdateService.pullUpstream"));

  return SourceUpdateService.of({ status, update, pullUpstream });
});

export const layer = Layer.effect(SourceUpdateService, make);
