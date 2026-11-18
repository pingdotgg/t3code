import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProjectId,
  ProviderDriverKind,
  ServerSourceUpdateError,
  type ServerProvider,
  type ServerRunSourceUpdateInput,
  type ServerRunSourceUpdateResult,
  type ServerSourceUpdateResult,
  type ServerSourceUpdateStatus,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Clock from "effect/Clock";
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
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ACTIVE_RUN_STATUSES } from "../orchestration-v2/ThreadManagementService.ts";
import {
  SOURCE_CHECKOUT_ENV,
  SOURCE_UPDATE_SERVICE_ENV,
  sourceCheckoutConfig,
  sourceUpdateCommandConfig,
  sourceUpdateServiceConfig,
} from "./sourceCheckout.ts";

const UPDATE_UNIT = "t3code-source-update";
const FETCH_INTERVAL = Duration.minutes(5);
// Bounds a run, restart wait included; clients give up on a run that outlives it.
const SOURCE_UPDATE_MAX_RUNTIME = Duration.minutes(30);
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

// No tty: a credential prompt would hang until the timeout, so git must fail instead.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", LANGUAGE: "C" };

export const PULL_UPSTREAM_PROMPT = `Merge upstream into this checkout. It is the source the T3 Code server you are running in is built from. Update stopped because \`upstream/main\` does not merge cleanly.

1. \`git fetch --multiple origin upstream\`, make sure the working tree is clean and on \`main\`, and fast-forward to \`origin/main\`.
2. \`git merge --no-edit upstream/main\`. Never rebase: \`main\` is published. Resolve every conflict so both sides' intent survives; read the upstream commits when a resolution is not obvious, and ask me when it is a real product decision.
3. Where a conflict came from our fork's code and upstream's sitting in the same lines, you may make a small refactor on our side so the next merge does not collide there: move our addition into its own function, file or module and keep only a one-line hook in upstream's code. Never remove or change what either side does, and keep it to the conflicted area.
4. Run \`vp i\` and \`vp run check:changed\`, and fix what fails.
5. Push to \`origin main\`. Never push to \`upstream\` or open pull requests against it.

Then stop. Do not build or restart the server; I press Update in the app once this is pushed.`;

const STARTED_LINE = /^\[source-update\] started (\S+)$/;
const RESULT_LINE = /^\[source-update\] (succeeded|failed) (\S+) (\S+)(?: (.*))?$/;

/** The run `scripts/self-update.sh` last logged, and its outcome once it wrote one. */
export const parseSourceUpdateLog = (
  log: string,
): { readonly lastRunId: string | null; readonly lastResult: ServerSourceUpdateResult | null } => {
  let lastRunId: string | null = null;
  let lastResult: ServerSourceUpdateResult | null = null;
  for (const line of log.split("\n")) {
    const trimmed = line.trim();
    const started = STARTED_LINE.exec(trimmed);
    if (started !== null) {
      lastRunId = started[1]!;
      lastResult = null;
      continue;
    }
    const match = RESULT_LINE.exec(trimmed);
    if (match === null || match[2] !== lastRunId) continue;
    const finishedAt = DateTime.make(match[3]!);
    if (Option.isNone(finishedAt)) continue;
    lastResult = {
      runId: match[2],
      outcome: match[1] as ServerSourceUpdateResult["outcome"],
      finishedAt: DateTime.formatIso(finishedAt.value),
      message: match[4]?.trim() ?? "",
    };
  }
  return { lastRunId, lastResult };
};

/** Whether `/proc/self/cgroup` puts this process inside the systemd unit `service`. */
export const runsInSystemdUnit = (cgroup: string, service: string): boolean =>
  service.length > 0 &&
  cgroup.split("\n").some((line) => line.split("/").includes(`${service}.service`));

/** Why an agent cannot be started here to resolve upstream conflicts, or null when it can. */
const claudeUnavailableReason = (provider: ServerProvider | undefined): string | null => {
  if (provider === undefined) return "Claude is not set up on this server.";
  if (!provider.enabled || provider.status === "disabled") {
    return "Claude is disabled on this server.";
  }
  if (!provider.installed) return "Claude Code is not installed on this server.";
  if (provider.status === "error") {
    return provider.message ?? "Claude is not working on this server.";
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
    ) => Effect.Effect<ServerRunSourceUpdateResult, ServerSourceUpdateError>;
    readonly cancel: Effect.Effect<void, ServerSourceUpdateError>;
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
  const serviceName = yield* sourceUpdateServiceConfig;
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunch.ThreadLaunchService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const random = yield* SecureRandom.SecureRandom;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const scope = yield* Effect.scope;

  if (Option.isNone(checkoutOption)) {
    return SourceUpdateService.of({
      status: Effect.fail(unavailable),
      update: Effect.fn("SourceUpdateService.update")(function* (_input) {
        return yield* unavailable;
      }),
      cancel: Effect.fail(unavailable),
    });
  }
  // Projects match on the resolved path, so a trailing slash or a symlink must not differ.
  const checkout = yield* fs
    .realPath(checkoutOption.value)
    .pipe(Effect.orElseSucceed(() => checkoutOption.value));
  const [updateProgram = path.join(checkout, "scripts", "self-update.sh"), ...updateArgs] =
    Option.match(updateCommandOption, { onNone: () => [], onSome: tokenizeCliArgs });
  const logPath = path.join(config.logsDir, "source-update.log");
  // A dev stack opts in without running inside the unit; it must never restart that unit.
  const restartService = yield* fs.readFileString("/proc/self/cgroup").pipe(
    Effect.map((cgroup) => (runsInSystemdUnit(cgroup, serviceName) ? serviceName : "")),
    Effect.orElseSucceed(() => ""),
  );
  const probeHost =
    config.host === undefined || ["", "0.0.0.0", "::", "[::]"].includes(config.host)
      ? "127.0.0.1"
      : config.host;

  const git = (args: ReadonlyArray<string>, timeout: Duration.Input = "30 seconds") =>
    runner.run({ command: "git", args: ["-C", checkout, ...args], env: GIT_ENV, timeout });

  // Update builds HEAD right before it restarts the server, so HEAD at startup is what runs.
  const builtHead = yield* git(["rev-parse", "HEAD"]).pipe(
    Effect.map((output) => (output.code === 0 ? output.stdout.trim() : null)),
    Effect.orElseSucceed(() => null),
  );

  const systemdUnavailableReason = yield* Effect.cached(
    Effect.gen(function* () {
      const probes = yield* Effect.all(
        [
          runner.run({ command: "systemd-run", args: ["--version"] }),
          runner.run({ command: "systemctl", args: ["--user", "show", "--property=Version"] }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.option);
      return Option.exists(probes, ([run, ctl]) => run.code === 0 && ctl.code === 0)
        ? null
        : "Update needs systemd-run and a systemd user manager (systemctl --user) on this server.";
    }),
  );

  const fetchedAt = yield* Ref.make<string | null>(null);
  const fetchState = yield* Ref.make({ inFlight: false, startedAtMs: null as number | null });
  // Sequential: two fetches in one repository contend for its ref locks.
  const fetchRemotes = Effect.gen(function* () {
    let fetched = false;
    for (const remote of ["origin", "upstream"]) {
      const output = yield* git(["fetch", "--quiet", remote, "main"], "1 minute").pipe(
        Effect.option,
      );
      fetched ||= Option.exists(output, (result) => result.code === 0);
    }
    if (fetched) yield* Ref.set(fetchedAt, DateTime.formatIso(yield* DateTime.now));
  });
  // Every client polls status; the remotes are fetched in the background at most once per interval.
  const fetchRemotesInBackground = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const start = yield* Ref.modify(fetchState, (state) =>
      state.inFlight ||
      (state.startedAtMs !== null && now - state.startedAtMs < Duration.toMillis(FETCH_INTERVAL))
        ? [false, state]
        : [true, { inFlight: true, startedAtMs: now }],
    );
    if (!start) return;
    yield* fetchRemotes.pipe(
      Effect.ensuring(Ref.update(fetchState, (state) => ({ ...state, inFlight: false }))),
      Effect.forkIn(scope),
    );
  });

  const updateRunning = runner
    .run({ command: "systemctl", args: ["--user", "is-active", UPDATE_UNIT] })
    .pipe(
      Effect.map((output) =>
        ["active", "activating", "reloading", "deactivating"].includes(output.stdout.trim()),
      ),
      Effect.orElseSucceed(() => false),
    );

  const lastRun = fs.readFileString(logPath).pipe(
    Effect.map(parseSourceUpdateLog),
    Effect.orElseSucceed(() => ({ lastRunId: null, lastResult: null })),
  );

  const claudeProvider = providers.getProviders.pipe(
    Effect.map((list) =>
      list.find((provider) => provider.instanceId === defaultInstanceIdForDriver(CLAUDE_DRIVER)),
    ),
  );

  const status: SourceUpdateService["Service"]["status"] = Effect.gen(function* () {
    const head = git(["log", "-1", "--format=%h%x00%s", "HEAD"]).pipe(
      Effect.filterOrFail(
        (output) => output.code === 0,
        (output) => new Error(output.stderr.trim()),
      ),
      Effect.mapError(failed(`Could not read the checkout at ${checkout}.`)),
    );
    const count = (range: string) =>
      git(["rev-list", "--count", range]).pipe(
        Effect.map(parseCommitCount),
        Effect.orElseSucceed(() => null),
      );
    const running = yield* updateRunning;
    // The update fetches origin itself.
    if (!running) yield* fetchRemotesInBackground;
    const [
      headOutput,
      behindOrigin,
      upstreamAhead,
      unbuiltCommits,
      run,
      updateUnavailable,
      claude,
    ] = yield* Effect.all(
      [
        head,
        count("HEAD..origin/main"),
        count("HEAD..upstream/main"),
        builtHead === null ? Effect.succeed(null) : count(`${builtHead}..HEAD`),
        lastRun,
        systemdUnavailableReason,
        claudeProvider,
      ],
      { concurrency: "unbounded" },
    );
    return {
      head: parseHeadCommit(headOutput.stdout),
      behindOrigin,
      upstreamAhead,
      unbuiltCommits,
      fetchedAt: yield* Ref.get(fetchedAt),
      updateRunning: running,
      lastRunId: run.lastRunId,
      lastResult: run.lastResult,
      updateUnavailableReason: updateUnavailable,
      pullUpstreamUnavailableReason: claudeUnavailableReason(claude),
      checkout,
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

  const startMergeAgent = Effect.gen(function* () {
    const claudeReason = claudeUnavailableReason(yield* claudeProvider);
    if (claudeReason !== null) {
      return yield* new ServerSourceUpdateError({
        reason: "unavailable",
        detail: `Upstream has conflicts, and no agent can resolve them here: ${claudeReason}`,
      });
    }
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
  }).pipe(Effect.withSpan("SourceUpdateService.startMergeAgent"));

  // The script merges upstream into origin/main, so that is the merge to try. `merge-tree
  // --write-tree` exits 1 on conflicts and leaves the index and working tree alone.
  const upstreamConflicts = Effect.gen(function* () {
    yield* fetchRemotes;
    const output = yield* git(["merge-tree", "--write-tree", "origin/main", "upstream/main"]).pipe(
      Effect.mapError(failed("Could not check whether upstream merges cleanly.")),
    );
    // Other codes mean a missing ref; the script reports that itself.
    return output.code === 1;
  });

  const update: SourceUpdateService["Service"]["update"] = Effect.fn("SourceUpdateService.update")(
    function* (input) {
      const reason = yield* systemdUnavailableReason;
      if (reason !== null) {
        return yield* new ServerSourceUpdateError({ reason: "unavailable", detail: reason });
      }
      if (yield* updateRunning) {
        return yield* new ServerSourceUpdateError({
          reason: "update-running",
          detail: "An update is already running.",
        });
      }
      // Nothing restarts on a conflict, so running turns do not matter for it.
      if (yield* upstreamConflicts) {
        return { upstreamConflict: yield* startMergeAgent };
      }
      if (input.force !== true && (yield* hasActiveRun)) {
        return yield* new ServerSourceUpdateError({
          reason: "turns-running",
          detail: "Agents are working on this server. Updating restarts it and stops their turns.",
        });
      }
      yield* fs
        .makeDirectory(config.logsDir, { recursive: true })
        .pipe(Effect.mapError(failed(`Could not create ${config.logsDir}.`)));
      const runId = yield* random.uuidV4();
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
            `--setenv=${SOURCE_UPDATE_SERVICE_ENV}=${restartService}`,
            `--setenv=T3CODE_SOURCE_UPDATE_RUN_ID=${runId}`,
            `--setenv=T3CODE_SOURCE_UPDATE_HOST=${probeHost}`,
            `--setenv=T3CODE_SOURCE_UPDATE_PORT=${String(config.port)}`,
            "-p",
            `RuntimeMaxSec=${String(Duration.toSeconds(SOURCE_UPDATE_MAX_RUNTIME))}`,
            // stderr inherits this descriptor; a second one on the file would overwrite it.
            "-p",
            `StandardOutput=truncate:${logPath}`,
            updateProgram,
            ...updateArgs,
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
      return { runId };
    },
  );

  // The script logs the stop as a failure; systemd stops it the same way when RuntimeMaxSec ends.
  const cancel: SourceUpdateService["Service"]["cancel"] = Effect.gen(function* () {
    if (!(yield* updateRunning)) return;
    const output = yield* runner
      .run({ command: "systemctl", args: ["--user", "stop", UPDATE_UNIT], timeout: "2 minutes" })
      .pipe(Effect.mapError(failed("Could not cancel the update.")));
    if (output.code !== 0) {
      return yield* new ServerSourceUpdateError({
        reason: "failed",
        detail: `Could not cancel the update: ${output.stderr.trim() || `systemctl exited with ${String(output.code)}`}`,
      });
    }
  }).pipe(Effect.withSpan("SourceUpdateService.cancel"));

  return SourceUpdateService.of({ status, update, cancel });
});

export const layer = Layer.effect(SourceUpdateService, make);
