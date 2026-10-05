import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DEFAULT_HOME_SETTINGS,
  type EnvironmentId,
  type FleetHostRegistration,
  type FleetHostRequest,
  type HomeSettings,
  type HomeWatchEvent,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isElectron } from "../../env";
import { useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { homeEnvironment, liveShellEnvironmentIdsAtom } from "../../state/home";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { diffWatchedThreads, homeWatchKey, type WatchedThreadState } from "./homeWatch";

/** How long watched events gather before Home is woken with all of them. */
const WATCH_REPORT_DELAY_MS = 1_500;
/** A failed report is retried this often, for about a minute, then dropped. */
const WATCH_REPORT_RETRY_MS = 5_000;
const WATCH_REPORT_ATTEMPTS = 12;

/**
 * Desktop-only host for Home, which runs on the desktop's own server. While
 * Home is on, this renderer relays Home's calls to the user's other
 * environments over the connections it already holds, reports watched thread
 * changes back to Home, and keeps itself alive when the window closes.
 */
export function HomeFleetHost() {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (!isElectron || primaryEnvironmentId === null) return null;
  return <HomeHub environmentId={primaryEnvironmentId} />;
}

function HomeHub({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const home = settings?.home ?? DEFAULT_HOME_SETTINGS;
  const on = home.threadId !== null;
  useEffect(() => {
    void window.desktopBridge?.setKeepAliveOnClose?.(on);
    // Without a relay running, closing the window should quit as usual.
    return () => void window.desktopBridge?.setKeepAliveOnClose?.(false);
  }, [on]);
  if (!on) return null;
  return (
    <>
      <HomeRelay environmentId={environmentId} />
      <HomeWatchReporter environmentId={environmentId} home={home} />
    </>
  );
}

const isRelayFailure = Schema.is(OrchestratorMcpFailure);
function createRelayClientId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return `home-relay-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const relayFailure = (error: unknown) =>
  isRelayFailure(error)
    ? error
    : new OrchestratorMcpFailure({
        code: "environment_unavailable",
        message:
          error instanceof Error ? error.message : "The other environment could not be reached.",
      });

function HomeRelay({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const { environments } = useEnvironments();
  const [clientId] = useState(createRelayClientId);
  // The hub keeps the newest registration, so a changed list re-registers.
  const reachKey = JSON.stringify(
    environments
      .filter((environment) => environment.environmentId !== environmentId)
      .map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.label,
        connected: environment.connection.phase === "connected",
      })),
  );
  const registration = useMemo<FleetHostRegistration>(
    () => ({ clientId, environments: JSON.parse(reachKey) }),
    [clientId, reachKey],
  );
  const requestsAtom = homeEnvironment.relayRequests({ environmentId, input: registration });
  const invoke = useAtomCommand(homeEnvironment.invoke, { reportFailure: false });
  const respond = useAtomCommand(homeEnvironment.relayRespond, { reportFailure: false });

  const handle = useCallback(
    async (request: FleetHostRequest) => {
      const result = await invoke({ environmentId: request.environmentId, input: request.invoke });
      await respond({
        environmentId,
        input:
          result._tag === "Success"
            ? { requestId: request.requestId, result: result.value }
            : {
                requestId: request.requestId,
                failure: relayFailure(squashAtomCommandFailure(result)),
              },
      });
    },
    [environmentId, invoke, respond],
  );
  // The consumer outlives renders, so it reads the latest handler from an atom.
  const [handlerAtom] = useState(() => Atom.make({ handle }));
  const setHandler = useAtomSet(handlerAtom);
  useEffect(() => {
    setHandler({ handle });
  }, [handle, setHandler]);

  const consumerAtom = useMemo(
    () =>
      Atom.make((get) => {
        get.mount(handlerAtom);
        // A request runs once even if the stream value is seen again.
        const handled = new Set<string>();
        // `immediate` reads the stream atom now, which opens fleet.connect. Without
        // it the atom is never computed and the hub never hears from this window.
        get.subscribe(
          requestsAtom,
          (result) => {
            if (!AsyncResult.isSuccess(result) || handled.has(result.value.requestId)) return;
            handled.add(result.value.requestId);
            void get.once(handlerAtom).handle(result.value);
          },
          { immediate: true },
        );
      }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`home:relay:${environmentId}:${clientId}`)),
    [clientId, environmentId, handlerAtom, requestsAtom],
  );
  useAtomValue(consumerAtom);
  return null;
}

function HomeWatchReporter({
  environmentId,
  home,
}: {
  readonly environmentId: EnvironmentId;
  readonly home: HomeSettings;
}) {
  const shells = useThreadShells();
  const liveEnvironmentIds = useAtomValue(liveShellEnvironmentIdsAtom);
  const { environments } = useEnvironments();
  // Watches that exist when the reporter starts only set a baseline.
  const [knownWatchKeys] = useState(
    () => new Set(home.watches.map((watch) => homeWatchKey(watch.environmentId, watch.threadId))),
  );
  const labels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const report = useAtomCommand(homeEnvironment.reportWatchEvents, { reportFailure: false });
  const previous = useRef<ReadonlyMap<string, WatchedThreadState>>(new Map());
  const pending = useRef<Array<HomeWatchEvent>>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failures = useRef(0);
  const sending = useRef(false);
  const stopped = useRef(false);

  useEffect(() => {
    const { next, events } = diffWatchedThreads({
      previous: previous.current,
      shells,
      home,
      knownWatchKeys,
      liveEnvironmentIds,
      labelFor: (id) => labels.get(id),
    });
    previous.current = next;
    pending.current.push(...events);
    // Queued events also restart here after an effect replay cleared the timer.
    if (pending.current.length === 0 || timer.current !== null || sending.current) return;
    // One batch is in flight at a time, and a failed one goes back to the
    // front. A later batch that ends a watch must not land before an earlier
    // batch about the same thread.
    const send = async () => {
      timer.current = null;
      sending.current = true;
      const batch = pending.current;
      pending.current = [];
      const result = await report({ environmentId, input: { events: batch } });
      sending.current = false;
      if (stopped.current) return;
      if (result._tag !== "Success" && ++failures.current < WATCH_REPORT_ATTEMPTS) {
        pending.current = [...batch, ...pending.current];
        timer.current = setTimeout(() => void send(), WATCH_REPORT_RETRY_MS);
        return;
      }
      failures.current = 0;
      if (pending.current.length > 0) {
        timer.current = setTimeout(() => void send(), WATCH_REPORT_DELAY_MS);
      }
    };
    timer.current = setTimeout(() => void send(), WATCH_REPORT_DELAY_MS);
  }, [environmentId, home, knownWatchKeys, labels, liveEnvironmentIds, report, shells]);

  useEffect(() => {
    stopped.current = false;
    return () => {
      stopped.current = true;
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);
  return null;
}
