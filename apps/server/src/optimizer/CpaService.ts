import {
  type CpaStatus,
  normalizeHeadroomProxyUrl,
  OptimizerStartError,
  type OptimizerStatusSnapshot,
  type ServerProvider,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { SessionOptimizerAttachments } from "@t3tools/provider-core/server/sessionOptimizerAttachments";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../processRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeCliproxyApi } from "../usage/cliproxyApi.ts";
import {
  cpaHeadroomUpstream,
  readCpaRoutingState,
  setClaudeSettingsCpaRouting,
  setCodexConfigCpaRouting,
} from "./CpaRouting.ts";
import { OptimizerProbeService } from "./OptimizerProbeService.ts";

const START_TIMEOUT_MS = 10_000;
const START_POLL = Duration.millis(250);
const USAGE_TTL = Duration.seconds(60);

/**
 * The local CLIProxyAPI (CPA): its status, a macOS launchd start, the one global switch that
 * points the Claude and Codex CLI configs at it, and its quota as those providers' usage limits.
 */
export class CpaService extends Context.Service<
  CpaService,
  {
    /** The optimizer snapshot with CPA status attached. */
    readonly getStatus: (input: {
      readonly refresh?: boolean | undefined;
    }) => Effect.Effect<OptimizerStatusSnapshot>;
    readonly start: () => Effect.Effect<OptimizerStatusSnapshot, OptimizerStartError>;
    readonly setRouting: (
      enabled: boolean,
    ) => Effect.Effect<OptimizerStatusSnapshot, OptimizerStartError>;
    /** Swaps in CPA's quota for a Claude or Codex instance whose endpoint is CPA. */
    readonly overlayUsageLimits: (provider: ServerProvider) => Effect.Effect<ServerProvider>;
  }
>()("t3/optimizer/CpaService") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const sessionOptimizers = yield* SessionOptimizerAttachments;
  const probe = yield* OptimizerProbeService;
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const userId = yield* HostProcess.UserId;
  const cliproxy = yield* makeCliproxyApi;

  const provideFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  const isRunning = (url: string) =>
    httpClient.get(`${url}/`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(Duration.seconds(2)),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  const cpaStatus = Effect.fn("CpaService.cpaStatus")(function* (
    snapshot: OptimizerStatusSnapshot,
  ) {
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    if (Option.isNone(settings)) return undefined;
    const state = yield* provideFiles(readCpaRoutingState(settings.value)).pipe(Effect.option);
    if (Option.isNone(state)) return undefined;
    const running = yield* isRunning(state.value.cpaUrl);
    const expected = cpaHeadroomUpstream(state.value);
    const owned = yield* probe.ownedHeadroomUpstream;
    const headroomRunning = snapshot.optimizers.some(
      (optimizer) => optimizer.id === "headroom" && optimizer.running === true,
    );
    return {
      url: state.value.cpaUrl,
      running,
      routing:
        state.value.claude && state.value.codex
          ? "on"
          : state.value.claude || state.value.codex
            ? "partial"
            : "off",
      canStart: platform === "darwin",
      headroomUpstreamMismatch:
        headroomRunning &&
        (owned === null
          ? expected.anthropic !== undefined || expected.openai !== undefined
          : owned.anthropic !== expected.anthropic || owned.openai !== expected.openai),
    } satisfies CpaStatus;
  });

  const getStatus: CpaService["Service"]["getStatus"] = Effect.fn("CpaService.getStatus")(
    function* (input) {
      const snapshot = yield* sessionOptimizers.getStatus(
        input.refresh === undefined ? {} : { refresh: input.refresh },
      );
      const cpa = yield* cpaStatus(snapshot);
      return cpa === undefined ? snapshot : { ...snapshot, cpa };
    },
  );

  const start: CpaService["Service"]["start"] = Effect.fn("CpaService.start")(function* () {
    if (platform !== "darwin" || userId === undefined) {
      return yield* new OptimizerStartError({
        message: "Starting CLIProxyAPI from T3 is only supported on macOS.",
      });
    }
    const settings = yield* settingsService.getSettings.pipe(
      Effect.mapError(
        () => new OptimizerStartError({ message: "Could not read server settings." }),
      ),
    );
    const url = normalizeHeadroomProxyUrl(settings.cpa.url) ?? settings.cpa.url;
    if (yield* isRunning(url)) return yield* getStatus({ refresh: true });
    const label = settings.cpa.launchdLabel;
    const launchctl = (args: ReadonlyArray<string>) =>
      processRunner
        .run({ command: "launchctl", args, timeout: Duration.seconds(10) })
        .pipe(
          Effect.mapError(
            () =>
              new OptimizerStartError({ message: "Could not run launchctl to start CLIProxyAPI." }),
          ),
        );
    const loaded = (yield* launchctl(["print", `gui/${userId}/${label}`])).code === 0;
    const result = yield* launchctl(
      loaded
        ? ["kickstart", "-k", `gui/${userId}/${label}`]
        : [
            "bootstrap",
            `gui/${userId}`,
            path.join(home, "Library", "LaunchAgents", `${label}.plist`),
          ],
    );
    if (result.code !== 0) {
      return yield* new OptimizerStartError({
        message: `launchctl could not start ${label} (exit ${String(result.code)}). Check that its LaunchAgent plist exists.`,
      });
    }
    const deadline = (yield* Clock.currentTimeMillis) + START_TIMEOUT_MS;
    while (!(yield* isRunning(url))) {
      if ((yield* Clock.currentTimeMillis) >= deadline) {
        return yield* new OptimizerStartError({
          message: `CLIProxyAPI did not answer at ${url} within 10 seconds.`,
        });
      }
      yield* Effect.sleep(START_POLL);
    }
    return yield* getStatus({ refresh: true });
  });

  const setRouting: CpaService["Service"]["setRouting"] = Effect.fn("CpaService.setRouting")(
    function* (enabled) {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          () => new OptimizerStartError({ message: "Could not read server settings." }),
        ),
      );
      const state = yield* provideFiles(readCpaRoutingState(settings)).pipe(
        Effect.mapError(
          () => new OptimizerStartError({ message: "Could not read the Claude or Codex config." }),
        ),
      );
      const target = {
        url: state.cpaUrl,
        clientKeyPath: settings.cpa.clientKeyPath,
        clientKeyFile: expandHomePath(settings.cpa.clientKeyPath, home),
      };
      const write = (filePath: string, current: string, next: string) =>
        next === current
          ? Effect.void
          : provideFiles(writeFileStringAtomically({ filePath, contents: next })).pipe(
              Effect.mapError(
                () => new OptimizerStartError({ message: `Could not update ${filePath}.` }),
              ),
            );
      yield* write(
        state.claudeSettingsPath,
        state.claudeSettings,
        setClaudeSettingsCpaRouting(state.claudeSettings, enabled, target),
      );
      yield* write(
        state.codexConfigPath,
        state.codexConfig,
        setCodexConfigCpaRouting(state.codexConfig, enabled, target),
      );
      if ((yield* probe.ownedHeadroomUpstream) !== null) {
        yield* probe.startHeadroom().pipe(
          Effect.mapError(
            (error) =>
              new OptimizerStartError({
                message: `Routing changed, but Headroom did not restart: ${error.message}`,
              }),
          ),
        );
      }
      return yield* getStatus({ refresh: true });
    },
  );

  // Failures cache too, so an unreachable CPA falls back to native limits for one TTL.
  const accounts = yield* Effect.cachedWithTTL(
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings;
      const managementKey = (yield* fileSystem.readFileString(
        expandHomePath(settings.cpa.managementKeyPath, home),
      )).trim();
      return yield* cliproxy.readAccounts({ url: settings.cpa.url, managementKey });
    }).pipe(Effect.option),
    USAGE_TTL,
  );

  const overlayUsageLimits: CpaService["Service"]["overlayUsageLimits"] = Effect.fn(
    "CpaService.overlayUsageLimits",
  )(function* (provider) {
    const driver = String(provider.driver);
    if (driver !== "claudeAgent" && driver !== "codex") return provider;
    const settings = yield* settingsService.getSettings.pipe(Effect.option);
    if (
      Option.isNone(settings) ||
      provider.auth.endpoint === undefined ||
      provider.auth.endpoint !== normalizeHeadroomProxyUrl(settings.value.cpa.url)
    ) {
      return provider;
    }
    const read = yield* accounts;
    if (Option.isNone(read)) return provider;
    const account = read.value.find(
      (candidate) => String(candidate.driver) === driver && !candidate.usageLimits.unavailable,
    );
    return account === undefined ? provider : { ...provider, usageLimits: account.usageLimits };
  });

  return CpaService.of({ getStatus, start, setRouting, overlayUsageLimits });
});

export const layer = Layer.effect(CpaService, make);
