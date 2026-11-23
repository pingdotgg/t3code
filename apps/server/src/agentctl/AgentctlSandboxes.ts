import {
  AgentctlManifestRootError,
  AgentctlSandboxError,
  AgentctlSandboxSettings,
  EnvironmentId,
  type AgentctlActionResult,
  type AgentctlCreateSandboxInput,
  type AgentctlManifestRoot,
  type AgentctlPullResult,
  type AgentctlSandboxAction,
  type AgentctlSandboxManifest,
  type AgentctlSandboxPairing,
  type AgentctlSandboxesSnapshot,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as AgentctlCli from "./AgentctlCli.ts";
import * as AgentctlSandboxTunnels from "./AgentctlSandboxTunnels.ts";
import { isConnectable, shouldCloseTunnel, sshAliasFor, type AgentResource } from "./agentState.ts";
import { discoverManifests } from "./manifests.ts";
import { describeManifestRoots, pullManifestRepositories } from "./manifestRepositories.ts";
import {
  DEFAULT_SANDBOX_SETTINGS,
  IDLE_RUNTIME,
  SandboxStoreDocument,
  buildSandbox,
  reconcileRecords,
  type SandboxLinkRecord,
  type SandboxRuntime,
} from "./sandboxModel.ts";

// Discovers agentctl Agents on this machine and keeps each Ready one with SSH access forwarded
// to loopback, where the relay serves it to every client. Clients register each Sandbox as an
// environment from `changes`, so a stopped one behaves like any unreachable environment. This
// service never starts an Agent on its own.

export class AgentctlSandboxes extends Context.Service<
  AgentctlSandboxes,
  {
    readonly snapshot: Effect.Effect<AgentctlSandboxesSnapshot>;
    /** The current snapshot, then every change to it. Watching starts with the first subscriber. */
    readonly changes: Stream.Stream<AgentctlSandboxesSnapshot>;
    /** Reads agentctl now instead of waiting for its watch or the next poll. */
    readonly refresh: Effect.Effect<AgentctlSandboxesSnapshot>;
    readonly start: (name: string) => Effect.Effect<AgentctlActionResult>;
    readonly stop: (name: string) => Effect.Effect<AgentctlActionResult>;
    readonly remove: (name: string) => Effect.Effect<AgentctlActionResult>;
    readonly create: (input: AgentctlCreateSandboxInput) => Effect.Effect<AgentctlActionResult>;
    readonly listManifests: Effect.Effect<ReadonlyArray<AgentctlSandboxManifest>>;
    readonly listManifestRoots: Effect.Effect<ReadonlyArray<AgentctlManifestRoot>>;
    /** Fetches each manifest repository before describing it. */
    readonly refreshManifestRoots: Effect.Effect<ReadonlyArray<AgentctlManifestRoot>>;
    readonly getSettings: Effect.Effect<AgentctlSandboxSettings>;
    /** Folders are merged here, so two views never overwrite each other's changes. */
    readonly addManifestRoot: (
      folder: string,
    ) => Effect.Effect<AgentctlSandboxSettings, AgentctlManifestRootError>;
    readonly removeManifestRoot: (folder: string) => Effect.Effect<AgentctlSandboxSettings>;
    readonly pullManifestRoots: (
      folders: ReadonlyArray<string>,
    ) => Effect.Effect<AgentctlPullResult>;
    /** Remembers that this environment of the Sandbox got its preference settings. */
    readonly markSettingsSeeded: (
      name: string,
      environmentId: EnvironmentId,
    ) => Effect.Effect<void>;
    /** Asks a running Sandbox's server for a one-time pairing code, for a client of this server. */
    readonly pair: (name: string) => Effect.Effect<AgentctlSandboxPairing, AgentctlSandboxError>;
    /** Where the relay reaches a Sandbox's server: its forward on this machine's loopback. */
    readonly relayUpstream: (name: string) => Effect.Effect<Option.Option<string>>;
    /** The relay could not reach the forward, so the next check opens it again. */
    readonly reportUnreachable: (name: string) => Effect.Effect<void>;
    /** Starts watching agentctl. Later calls do nothing. */
    readonly startWatching: Effect.Effect<void>;
    /** Each time this server reaches a Sandbox's server, at its forward, which moves each time. */
    readonly reached: Stream.Stream<SandboxReached>;
    /** The links this server made to its Sandboxes, by Sandbox name. */
    readonly sandboxLinks: Effect.Effect<Readonly<Record<string, SandboxLinkRecord>>>;
    readonly recordSandboxLink: (
      name: string,
      link: SandboxLinkRecord | null,
    ) => Effect.Effect<void>;
  }
>()("t3/agentctl/AgentctlSandboxes") {}

export interface SandboxReached {
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrl: string;
}

const POLL_INTERVAL = Duration.seconds(3);
const UNAVAILABLE_POLL_INTERVAL = Duration.seconds(30);
// How long an agentctl without `get --watch` is polled before trying to watch again, in case it
// was updated.
const WATCH_RETRY_INTERVAL = Duration.minutes(1);
// A Sandbox that could not be reached is retried, but not on every poll.
const DISCOVERY_RETRY_MS = 30_000;
// Closing a tunnel also stops T3's server over SSH, which hangs while the
// Sandbox is stopping; nothing waits for it, and it gives up after this.
const TUNNEL_CLOSE_TIMEOUT = Duration.seconds(15);

const sandboxTarget = (name: string): DesktopSshEnvironmentTarget => {
  const alias = sshAliasFor(name);
  return { alias, hostname: alias, username: null, port: null };
};

/** SSH's own wording when agentctl's generated config is not included. */
function discoveryErrorMessage(error: { readonly message: string }): string {
  return /could not resolve hostname/i.test(error.message)
    ? "SSH cannot resolve this Sandbox. Run `agentctl ssh-config install` and try again."
    : error.message;
}

const DescriptorIdentity = Schema.Struct({ environmentId: EnvironmentId });

const decodeStore = Schema.decodeUnknownEffect(Schema.fromJsonString(SandboxStoreDocument));
const encodeStore = Schema.encodeEffect(Schema.fromJsonString(SandboxStoreDocument, { space: 2 }));

export const make = Effect.gen(function* () {
  const cli = yield* AgentctlCli.AgentctlCli;
  const tunnels = yield* AgentctlSandboxTunnels.AgentctlSandboxTunnels;
  const config = yield* ServerConfig.ServerConfig;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  >();
  // Overlapping manifest folders can refer to the same repository.
  const pullLock = yield* Semaphore.make(1);
  const reachedHub = yield* PubSub.unbounded<SandboxReached>();
  // Each Sandboxes page asks for a refresh when it opens; they share the one in flight.
  const refreshing = yield* Ref.make<Deferred.Deferred<ReadonlyArray<AgentctlManifestRoot>> | null>(
    null,
  );

  const storePath = path.join(config.stateDir, "agentctl-sandboxes.json");
  // A file T3 cannot read is kept aside rather than overwritten by the next save.
  const loaded = yield* fileSystem.readFileString(storePath).pipe(
    Effect.map((raw): string | null => raw),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.flatMap((raw) =>
      raw === null ? Effect.succeed<SandboxStoreDocument>({}) : decodeStore(raw),
    ),
    Effect.catch((error) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const aside = `${storePath}.unreadable-${now}`;
          return fileSystem
            .rename(storePath, aside)
            .pipe(
              Effect.ignore,
              Effect.andThen(
                Effect.logWarning("Set aside unreadable agentctl Sandbox state.", { aside, error }),
              ),
            );
        }),
        Effect.as<SandboxStoreDocument>({}),
      ),
    ),
  );
  const store = yield* Ref.make<SandboxStoreDocument>(loaded);
  // Writes go to a temporary file first, so a crash never leaves half a document.
  const persist = Ref.get(store).pipe(
    Effect.flatMap(encodeStore),
    Effect.flatMap((json) =>
      fileSystem
        .writeFileString(`${storePath}.tmp`, `${json}\n`)
        .pipe(Effect.andThen(fileSystem.rename(`${storePath}.tmp`, storePath))),
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not save agentctl Sandbox state.", { storePath, error }),
    ),
  );
  // One update at a time, each saved before the next, so none is lost or reordered.
  const storeLock = yield* Semaphore.make(1);
  const updateStore = (update: (document: SandboxStoreDocument) => SandboxStoreDocument) =>
    storeLock.withPermits(1)(Ref.update(store, update).pipe(Effect.andThen(persist)));
  const scope = yield* Effect.scope;

  const agentsRef = yield* Ref.make<ReadonlyArray<AgentResource>>([]);
  const runtimes = yield* Ref.make<ReadonlyMap<string, SandboxRuntime>>(new Map());
  const snapshotRef = yield* SubscriptionRef.make<AgentctlSandboxesSnapshot>({
    status: "loading",
    error: null,
    sandboxes: [],
    homeDirectory,
  });
  const refreshLock = yield* Semaphore.make(1);
  const nextCheck = yield* Ref.make(0);

  const closeTunnelSoon = (name: string) =>
    tunnels
      .disconnect(sandboxTarget(name))
      .pipe(
        Effect.timeout(TUNNEL_CLOSE_TIMEOUT),
        Effect.ignore,
        Effect.forkIn(scope),
        Effect.asVoid,
      );

  const updateRuntime = (name: string, update: (runtime: SandboxRuntime) => SandboxRuntime) =>
    Ref.update(runtimes, (current) => {
      const next = new Map(current);
      next.set(name, update(current.get(name) ?? IDLE_RUNTIME));
      return next;
    });

  const publish = Effect.gen(function* () {
    const agents = yield* Ref.get(agentsRef);
    const records = (yield* Ref.get(store)).sandboxes ?? {};
    const runtime = yield* Ref.get(runtimes);
    yield* SubscriptionRef.update(snapshotRef, (snapshot) => ({
      ...snapshot,
      sandboxes: agents.map((agent) =>
        buildSandbox(
          agent,
          records[agent.metadata.name],
          runtime.get(agent.metadata.name) ?? IDLE_RUNTIME,
        ),
      ),
    }));
  });

  const fetchEnvironmentId = (httpBaseUrl: string) =>
    httpClient.get(new URL(".well-known/t3/environment", httpBaseUrl).toString()).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(DescriptorIdentity)),
      Effect.map((descriptor) => descriptor.environmentId),
      Effect.mapError((cause) => ({ message: "The Sandbox's T3 server did not answer.", cause })),
    );

  // Opens the forward to the Sandbox's T3 server and learns its environment id:
  // the first time in each run of the server, and again each time it becomes
  // reachable, in case it was recreated or its T3 home reset. The forward then
  // stays open for the relay until the Sandbox stops.
  const discover = Effect.fn("AgentctlSandboxes.discover")(function* (name: string, check: number) {
    const result = yield* Effect.all([
      tunnels.ensure(sandboxTarget(name)).pipe(
        Effect.flatMap((tunnel) =>
          fetchEnvironmentId(tunnel.httpBaseUrl).pipe(
            Effect.map((environmentId) => ({
              environmentId,
              sshTarget: tunnel.target,
              httpBaseUrl: tunnel.httpBaseUrl,
            })),
          ),
        ),
      ),
      cli.sshInfo(name),
    ]).pipe(Effect.result);
    // Under the refresh lock, which a stop or deletion takes to drop this check.
    yield* refreshLock.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(runtimes)).get(name)?.check !== check) return;
        const now = yield* Clock.currentTimeMillis;
        if (result._tag === "Failure") {
          yield* Effect.logWarning("Could not reach an agentctl Sandbox.", {
            name,
            error: result.failure,
          });
          // A known Sandbox keeps its environment; its live connection reports trouble.
          const known = (yield* Ref.get(store)).sandboxes?.[name] !== undefined;
          yield* updateRuntime(name, (runtime) => ({
            ...runtime,
            discovering: false,
            retryAt: now + DISCOVERY_RETRY_MS,
            connectError: known ? runtime.connectError : discoveryErrorMessage(result.failure),
          }));
        } else {
          const [{ environmentId, sshTarget, httpBaseUrl }, sshInfo] = result.success;
          yield* updateStore((document) => ({
            ...document,
            sandboxes: {
              ...document.sandboxes,
              // Registering the resolved target keeps the SSH connection from
              // recording a changed profile on every connect. A recreated
              // Sandbox has a new environment, which is seeded again.
              [name]: {
                environmentId,
                sshTarget,
                ...(document.sandboxes?.[name]?.environmentId === environmentId &&
                document.sandboxes[name].settingsSeeded === true
                  ? { settingsSeeded: true }
                  : {}),
              },
            },
          }));
          yield* updateRuntime(name, (runtime) => ({
            ...runtime,
            discovering: false,
            connectError: null,
            verified: true,
            workingDirectory: sshInfo.workingDirectory,
            relayUpstream: httpBaseUrl,
          }));
          yield* PubSub.publish(reachedHub, { name, environmentId, httpBaseUrl });
        }
        yield* publish;
      }),
    );
  });

  // Keep the last known Sandboxes: dropping them would remove their environments, and with them
  // cached threads and drafts, over one failed call such as agentd restarting.
  const applyFailure = (error: string) =>
    SubscriptionRef.update(snapshotRef, (snapshot): AgentctlSandboxesSnapshot =>
      snapshot.status === "loading"
        ? { ...snapshot, status: "unavailable", error, sandboxes: [] }
        : { ...snapshot, error },
    );

  // Brings the records, tunnels and checks in line with a listing that replaced `previousAgents`.
  // Untraced, like what calls it: a provisioning Sandbox's watch prints every few hundred ms.
  const reconcile = Effect.fnUntraced(function* (
    previousAgents: ReadonlyArray<AgentResource>,
    agents: ReadonlyArray<AgentResource>,
  ) {
    const known = (yield* Ref.get(store)).sandboxes ?? {};
    if (Object.keys(reconcileRecords(known, agents)).length !== Object.keys(known).length) {
      yield* updateStore((document) => ({
        ...document,
        sandboxes: reconcileRecords(document.sandboxes ?? {}, agents),
      }));
    }

    // Close tunnels to Sandboxes that are stopping or went away; a Sandbox
    // that is only re-provisioning keeps its SSH server.
    for (const previous of previousAgents) {
      const current = agents.find((agent) => agent.metadata.name === previous.metadata.name);
      if (isConnectable(previous) && shouldCloseTunnel(current)) {
        yield* closeTunnelSoon(previous.metadata.name);
      }
    }

    // Forget Sandboxes that are gone, unless a request on them is still running.
    yield* Ref.update(runtimes, (current) => {
      const next = new Map(current);
      for (const [name, state] of current) {
        const present = agents.some((agent) => agent.metadata.name === name);
        if (!present && state.action === null) next.delete(name);
      }
      return next;
    });

    const now = yield* Clock.currentTimeMillis;
    const states = yield* Ref.get(runtimes);
    for (const agent of agents) {
      const name = agent.metadata.name;
      const state = states.get(name) ?? IDLE_RUNTIME;
      if (!isConnectable(agent)) {
        // Check again, without waiting out the throttle, once it is back.
        if (
          state.verified ||
          state.discovering ||
          state.retryAt !== 0 ||
          state.relayUpstream !== null
        ) {
          yield* updateRuntime(name, (current) => ({
            ...current,
            verified: false,
            discovering: false,
            check: 0,
            retryAt: 0,
            relayUpstream: null,
          }));
        }
        continue;
      }
      if (state.verified || state.discovering || now < state.retryAt) continue;
      const check = yield* Ref.updateAndGet(nextCheck, (id) => id + 1);
      yield* updateRuntime(name, (current) => ({ ...current, discovering: true, check }));
      yield* Effect.forkIn(discover(name, check), scope);
    }
    yield* publish;
  });

  const applyAgents = Effect.fnUntraced(function* (agents: ReadonlyArray<AgentResource>) {
    const previousAgents = yield* Ref.getAndSet(agentsRef, agents);
    yield* SubscriptionRef.update(snapshotRef, (snapshot): AgentctlSandboxesSnapshot => ({
      ...snapshot,
      status: "available",
      error: null,
    }));
    yield* reconcile(previousAgents, agents);
  });

  const refreshBody = cli.listAgents.pipe(
    Effect.result,
    Effect.flatMap((listed) =>
      listed._tag === "Failure"
        ? applyFailure(listed.failure.message)
        : applyAgents(listed.success),
    ),
  );

  const nextActionId = yield* Ref.make(0);

  const refresh = refreshLock
    .withPermits(1)(refreshBody)
    .pipe(Effect.andThen(SubscriptionRef.get(snapshotRef)));

  const performAction = Effect.fn("AgentctlSandboxes.runAction")(function* (
    name: string,
    action: AgentctlSandboxAction,
    run: Effect.Effect<void, AgentctlCli.AgentctlError>,
  ) {
    const actionId = yield* Ref.updateAndGet(nextActionId, (id) => id + 1);
    yield* updateRuntime(name, (runtime) => ({
      ...runtime,
      action,
      actionId,
      actionError: null,
    }));
    yield* publish;
    const result = yield* Effect.result(run);
    const error = result._tag === "Failure" ? result.failure.message : null;
    // A later request took over, such as a stop while a start was waiting;
    // this one's outcome, even a failure caused by it, no longer matters.
    const superseded = (yield* Ref.get(runtimes)).get(name)?.actionId !== actionId;
    if (!superseded) {
      yield* updateRuntime(name, (runtime) => ({ ...runtime, action: null, actionError: error }));
    }
    yield* refresh;
    return { error: superseded ? null : error } satisfies AgentctlActionResult;
  });
  // agentctl carries on when the request that asked is interrupted, so the action does too.
  const runAction = (
    name: string,
    action: AgentctlSandboxAction,
    run: Effect.Effect<void, AgentctlCli.AgentctlError>,
  ) => performAction(name, action, run).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join));

  const getSettings = Ref.get(store).pipe(
    Effect.map((document) => document.settings ?? DEFAULT_SANDBOX_SETTINGS),
  );
  const isDirectory = (directory: string) =>
    fileSystem.stat(directory).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
  const updateManifestRoots = (update: (roots: ReadonlyArray<string>) => ReadonlyArray<string>) =>
    updateStore((document) => {
      const settings = document.settings ?? DEFAULT_SANDBOX_SETTINGS;
      return {
        ...document,
        settings: { ...settings, manifestRoots: update(settings.manifestRoots) },
      };
    }).pipe(Effect.andThen(getSettings));
  const watching = yield* Ref.make(false);
  const watchRetryAt = yield* Ref.make(0);

  // Without agentctl there is nothing to watch closely, so check rarely.
  const pollOnce = refresh.pipe(
    Effect.catchCause((cause) => Effect.logError("agentctl Sandbox polling failed.", { cause })),
    Effect.andThen(SubscriptionRef.get(snapshotRef)),
    Effect.flatMap((snapshot) =>
      Effect.sleep(snapshot.status === "unavailable" ? UNAVAILABLE_POLL_INTERVAL : POLL_INTERVAL),
    ),
  );

  // A watch prints only changes, so a retried check or a forward the relay lost waits for this.
  // While agentctl reports trouble it reads, as a poll did: that starts agentd, and clears the
  // error once agentd answers, which a recovered watch with an unchanged list never prints.
  const recheck = Effect.forever(
    Effect.sleep(POLL_INTERVAL).pipe(
      Effect.andThen(
        refreshLock.withPermits(1)(
          Effect.gen(function* () {
            const snapshot = yield* SubscriptionRef.get(snapshotRef);
            if (snapshot.error !== null) return yield* refreshBody;
            if (snapshot.status !== "available") return;
            const agents = yield* Ref.get(agentsRef);
            yield* reconcile(agents, agents);
          }),
        ),
      ),
    ),
  );

  const onWatchEvent = (event: AgentctlCli.AgentctlWatchEvent) =>
    event._tag === "Agents"
      ? refreshLock.withPermits(1)(applyAgents(event.agents))
      : // The watch waits for agentd rather than starting it; a read starts it, as a poll did.
        refreshLock
          .withPermits(1)(applyFailure(event.message))
          .pipe(Effect.andThen(refresh.pipe(Effect.forkIn(scope))), Effect.asVoid);

  // Follows `get agents --watch` while agentctl has it, and polls otherwise. After a watch ends,
  // a read starts a stopped agentd and reports a missing agentctl before the next watch.
  const followOnce = Effect.gen(function* () {
    if ((yield* Clock.currentTimeMillis) >= (yield* Ref.get(watchRetryAt))) {
      const watched = yield* cli.watchAgents.pipe(
        Stream.runForEach(onWatchEvent),
        Effect.raceFirst(recheck),
        Effect.result,
      );
      if (watched._tag === "Failure" && watched.failure.reason === "unsupported") {
        const now = yield* Clock.currentTimeMillis;
        yield* Ref.set(watchRetryAt, now + Duration.toMillis(WATCH_RETRY_INTERVAL));
      } else if (watched._tag === "Failure" && watched.failure.reason !== "unavailable") {
        yield* Effect.logInfo("agentctl stopped watching Agents.", { error: watched.failure });
      }
    }
    yield* pollOnce;
  });

  const startWatching = Ref.getAndSet(watching, true).pipe(
    Effect.flatMap((started) =>
      started ? Effect.void : Effect.forever(followOnce).pipe(Effect.forkIn(scope), Effect.asVoid),
    ),
  );

  const notRunning = (name: string) =>
    new AgentctlSandboxError({
      sandboxName: name,
      reason: "not-running",
      message: `${name} is not running. Start it and try again.`,
    });

  return AgentctlSandboxes.of({
    snapshot: SubscriptionRef.get(snapshotRef),
    // Each listing publishes; clients only hear about a change.
    changes: Stream.unwrap(
      startWatching.pipe(Effect.as(SubscriptionRef.changes(snapshotRef))),
    ).pipe(
      Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
    ),
    refresh,
    start: Effect.fn("AgentctlSandboxes.start")(function (name) {
      return runAction(name, "starting", cli.start(name));
    }),
    stop: Effect.fn("AgentctlSandboxes.stop")(function (name) {
      return runAction(name, "stopping", cli.stop(name));
    }),
    remove: Effect.fn("AgentctlSandboxes.remove")(function (name) {
      return runAction(name, "deleting", cli.remove(name));
    }),
    create: Effect.fn("AgentctlSandboxes.create")(function* (input) {
      // Applying an existing name would replace that Sandbox's manifest, so
      // check agentctl now rather than the last listing.
      const agents = yield* cli.listAgents.pipe(Effect.result);
      if (agents._tag === "Failure") {
        return { error: agents.failure.message } satisfies AgentctlActionResult;
      }
      if (agents.success.some((agent) => agent.metadata.name === input.name)) {
        return {
          error: `A Sandbox named ${input.name} already exists.`,
        } satisfies AgentctlActionResult;
      }
      // Its manifest is offered first for the next Sandbox.
      const remember = updateStore((document) => ({
        ...document,
        settings: {
          ...(document.settings ?? DEFAULT_SANDBOX_SETTINGS),
          lastManifestPath: input.manifestPath,
        },
      }));
      return yield* runAction(
        input.name,
        "creating",
        cli
          .apply({ manifestPath: input.manifestPath, name: input.name })
          .pipe(Effect.tap(() => remember)),
      );
    }),
    listManifests: getSettings.pipe(
      Effect.flatMap((settings) => discoverManifests(settings.manifestRoots)),
      Effect.provide(context),
    ),
    getSettings,
    listManifestRoots: getSettings.pipe(
      Effect.flatMap((settings) => describeManifestRoots(settings.manifestRoots, { fetch: false })),
      Effect.provide(context),
    ),
    // Fetching takes no lock: Git guards its refs, and a slow remote must not hold up a pull.
    refreshManifestRoots: Effect.gen(function* () {
      const next = yield* Deferred.make<ReadonlyArray<AgentctlManifestRoot>>();
      const running = yield* Ref.modify(refreshing, (current) =>
        current === null ? [null, next] : [current, current],
      );
      if (running !== null) return yield* Deferred.await(running);
      yield* getSettings.pipe(
        Effect.flatMap((settings) =>
          describeManifestRoots(settings.manifestRoots, { fetch: true }),
        ),
        Effect.provide(context),
        Effect.exit,
        Effect.flatMap((exit) => Deferred.done(next, exit)),
        Effect.ensuring(Ref.set(refreshing, null)),
        Effect.forkIn(scope),
      );
      return yield* Deferred.await(next);
    }),
    addManifestRoot: Effect.fn("AgentctlSandboxes.addManifestRoot")(function* (folder) {
      // "/a/" and "/a" are one folder, and a client names this machine's home as `~`.
      const expanded = folder.trim().replace(/^~(?=$|[\\/])/u, homeDirectory);
      const resolved = path.resolve(expanded);
      // Only directories, since a desktop client can open a configured folder with the system handler.
      if (!path.isAbsolute(expanded) || !(yield* isDirectory(resolved))) {
        return yield* new AgentctlManifestRootError({
          folder,
          message: `${folder} is not a folder on this host.`,
        });
      }
      return yield* updateManifestRoots((roots) =>
        roots.some((root) => path.resolve(root) === resolved) ? roots : [...roots, resolved],
      );
    }),
    removeManifestRoot: Effect.fn("AgentctlSandboxes.removeManifestRoot")(function (folder) {
      return updateManifestRoots((roots) => roots.filter((root) => root !== folder));
    }),
    pullManifestRoots: Effect.fn("AgentctlSandboxes.pullManifestRoots")(function (folders) {
      return pullLock.withPermits(1)(
        Effect.gen(function* () {
          const settings = yield* getSettings;
          if (folders.some((folder) => !settings.manifestRoots.includes(folder))) {
            return {
              error: "This manifest folder is no longer configured.",
              repositories: [],
            } satisfies AgentctlPullResult;
          }
          return yield* pullManifestRepositories(folders).pipe(
            Effect.provide(context),
            Effect.map((repositories): AgentctlPullResult => ({ error: null, repositories })),
            Effect.catch((error) => Effect.succeed({ error: error.message, repositories: [] })),
          );
        }),
      );
    }),
    markSettingsSeeded: Effect.fn("AgentctlSandboxes.markSettingsSeeded")(
      function (name, environmentId) {
        return updateStore((document) => {
          const record = document.sandboxes?.[name];
          return record?.environmentId === environmentId
            ? {
                ...document,
                sandboxes: { ...document.sandboxes, [name]: { ...record, settingsSeeded: true } },
              }
            : document;
        }).pipe(Effect.andThen(publish));
      },
    ),
    pair: Effect.fn("AgentctlSandboxes.pair")(function* (name) {
      yield* startWatching;
      const agent = (yield* Ref.get(agentsRef)).find(
        (candidate) => candidate.metadata.name === name,
      );
      if (agent === undefined) {
        return yield* new AgentctlSandboxError({
          sandboxName: name,
          reason: "not-found",
          message: `There is no Sandbox named ${name}.`,
        });
      }
      if (!isConnectable(agent)) return yield* notRunning(name);
      const tunnel = yield* tunnels.ensure(sandboxTarget(name), { issuePairingToken: true }).pipe(
        Effect.mapError(
          (error) =>
            new AgentctlSandboxError({
              sandboxName: name,
              reason: "unreachable",
              message: discoveryErrorMessage(error),
            }),
        ),
      );
      const environmentId = yield* fetchEnvironmentId(tunnel.httpBaseUrl).pipe(
        Effect.mapError(
          (error) =>
            new AgentctlSandboxError({
              sandboxName: name,
              reason: "unreachable",
              message: error.message,
            }),
        ),
      );
      if (tunnel.pairingToken === null) {
        return yield* new AgentctlSandboxError({
          sandboxName: name,
          reason: "unreachable",
          message: `${name} did not issue a pairing code.`,
        });
      }
      return { environmentId, pairingToken: tunnel.pairingToken };
    }),
    // Untraced: the relay looks this up for every request it forwards.
    relayUpstream: Effect.fnUntraced(function* (name) {
      yield* startWatching;
      const current = yield* Ref.get(runtimes);
      return Option.fromNullishOr(current.get(name)?.relayUpstream);
    }),
    reportUnreachable: Effect.fn("AgentctlSandboxes.reportUnreachable")(function (name) {
      return updateRuntime(name, (runtime) =>
        runtime.relayUpstream === null
          ? runtime
          : { ...runtime, verified: false, retryAt: 0, relayUpstream: null },
      );
    }),
    startWatching,
    reached: Stream.fromPubSub(reachedHub),
    sandboxLinks: Ref.get(store).pipe(Effect.map((document) => document.links ?? {})),
    recordSandboxLink: Effect.fn("AgentctlSandboxes.recordSandboxLink")((name, link) =>
      updateStore((document) => {
        const { [name]: _previous, ...links } = document.links ?? {};
        return { ...document, links: link === null ? links : { ...links, [name]: link } };
      }),
    ),
  });
});

export const layer = Layer.effect(AgentctlSandboxes, make).pipe(
  Layer.provide(AgentctlCli.layer),
  Layer.provide(AgentctlSandboxTunnels.layer),
);
