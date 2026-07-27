import {
  createAtomCommandScheduler,
  type AtomCommand,
  type AtomCommandConcurrency,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  DiscoveredLocalServerList,
  EnvironmentId,
  PreviewAutomationHostFocus,
  PreviewAutomationHost,
  PreviewAutomationResponse,
  PreviewAutomationStreamEvent,
  PreviewCloseInput,
  PreviewEvent,
  PreviewListInput,
  PreviewListResult,
  PreviewNavigateInput,
  PreviewOpenInput,
  PreviewRefreshInput,
  PreviewReportStatusInput,
  PreviewResizeInput,
  PreviewSessionSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { readEnvironmentConnection } from "~/environments/runtime";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

/**
 * Fork adapter for the browser slice.
 *
 * Upstream drives preview RPCs through an environment-registry atom runtime.
 * The fork owns its connections imperatively (`environments/runtime`), so the
 * same atom/command shapes are rebuilt here on top of the fork's `WsRpcClient`
 * instead of transplanting the upstream connection stack.
 */

export class PreviewEnvironmentNotConnectedError extends Error {
  readonly _tag = "PreviewEnvironmentNotConnectedError";
  constructor(readonly environmentId: EnvironmentId) {
    super(`Environment ${environmentId} is not connected.`);
  }
}

interface Target<Input> {
  readonly environmentId: EnvironmentId;
  readonly input: Input;
}

function targetKey<Input>(target: Target<Input>): string {
  return JSON.stringify([target.environmentId, target.input]);
}

function parseTargetKey<Input>(key: string): Target<Input> {
  const [environmentId, input] = JSON.parse(key) as [EnvironmentId, Input];
  return { environmentId, input };
}

function previewClient(environmentId: EnvironmentId): WsRpcClient["preview"] {
  const connection = readEnvironmentConnection(environmentId);
  if (!connection) throw new PreviewEnvironmentNotConnectedError(environmentId);
  return connection.client.preview;
}

type PreviewResult<A> = AsyncResult.AsyncResult<A, never>;

/**
 * Query atom family with the refresh semantics the preview components rely on:
 * mounting (or `registry.refresh`) re-runs the request.
 */
function queryAtomFamily<Input, A>(
  label: string,
  execute: (client: WsRpcClient["preview"], input: Input) => Promise<A>,
): (target: Target<Input>) => Atom.Atom<PreviewResult<A>> {
  const family = Atom.family((key: string) => {
    const target = parseTargetKey<Input>(key);
    return Atom.make<PreviewResult<A>>((get) => {
      let disposed = false;
      get.addFinalizer(() => {
        disposed = true;
      });
      void (async () => {
        try {
          const value = await execute(previewClient(target.environmentId), target.input);
          if (!disposed) get.setSelf(AsyncResult.success<A, never>(value));
        } catch (cause) {
          if (!disposed) get.setSelf(AsyncResult.failure<A, never>(Cause.die(cause)));
        }
      })();
      return AsyncResult.initial<A, never>(true);
    }).pipe(Atom.withLabel(`${label}:${key}`));
  });
  return (target) => family(targetKey(target));
}

/** Subscription atom family exposing the latest streamed event as an AsyncResult. */
function subscriptionAtomFamily<Input, A>(
  label: string,
  subscribe: (
    client: WsRpcClient["preview"],
    input: Input,
    listener: (event: A) => void,
  ) => () => void,
  options?: { readonly idleTtlMs?: number },
): (target: Target<Input>) => Atom.Atom<PreviewResult<A>> {
  const family = Atom.family((key: string) => {
    const target = parseTargetKey<Input>(key);
    const atom = Atom.make<PreviewResult<A>>((get) => {
      let unsubscribe: (() => void) | null = null;
      try {
        unsubscribe = subscribe(previewClient(target.environmentId), target.input, (event) => {
          get.setSelf(AsyncResult.success<A, never>(event));
        });
      } catch (cause) {
        return AsyncResult.failure<A, never>(Cause.die(cause));
      }
      get.addFinalizer(() => unsubscribe?.());
      return AsyncResult.initial<A, never>(true);
    }).pipe(Atom.withLabel(`${label}:${key}`));
    return options?.idleTtlMs === undefined ? atom : atom.pipe(Atom.setIdleTTL(options.idleTtlMs));
  });
  return (target) => family(targetKey(target));
}

function command<Input, A>(
  label: string,
  execute: (client: WsRpcClient["preview"], input: Input) => Promise<A>,
  options: {
    readonly scheduler: ReturnType<typeof createAtomCommandScheduler>;
    readonly concurrency: AtomCommandConcurrency<Target<Input>>;
  },
): AtomCommand<Target<Input>, A, never> {
  return {
    label,
    run: (registry: AtomRegistry.AtomRegistry, target: Target<Input>) =>
      options.scheduler.schedule(
        registry,
        options.concurrency,
        target,
        async (): Promise<AtomCommandResult<A, never>> => {
          try {
            return AsyncResult.success<A, never>(
              await execute(previewClient(target.environmentId), target.input),
            );
          } catch (cause) {
            return AsyncResult.failure<A, never>(Cause.die(cause));
          }
        },
      ),
  };
}

const lifecycleScheduler = createAtomCommandScheduler();
const statusScheduler = createAtomCommandScheduler();
const automationScheduler = createAtomCommandScheduler();

const lifecycleConcurrency = <
  Input extends { readonly threadId: string },
>(): AtomCommandConcurrency<Target<Input>> => ({
  mode: "serial",
  key: ({ environmentId, input }) => JSON.stringify([environmentId, input.threadId]),
});

export const previewEnvironment = {
  list: queryAtomFamily<PreviewListInput, PreviewListResult>(
    "environment-data:preview:list",
    (client, input) => client.list(input),
  ),
  events: subscriptionAtomFamily<Record<string, never>, PreviewEvent>(
    "environment-data:preview:events",
    (client, _input, listener) => client.onEvent(listener),
  ),
  discoveredServers: subscriptionAtomFamily<Record<string, never>, DiscoveredLocalServerList>(
    "environment-data:preview:discovered-servers",
    (client, _input, listener) => client.onDiscoveredLocalServers(listener),
  ),
  automationRequests: subscriptionAtomFamily<PreviewAutomationHost, PreviewAutomationStreamEvent>(
    "environment-data:preview:automation-requests",
    (client, input, listener) => client.automation.connect(input, listener),
    // Automation requests are commands, not cached query data: dispose the
    // stream with its owner so stale requests cannot replay on remount.
    { idleTtlMs: 0 },
  ),
  open: command<PreviewOpenInput, PreviewSessionSnapshot>(
    "environment-data:preview:open",
    (client, input) => client.open(input),
    { scheduler: lifecycleScheduler, concurrency: lifecycleConcurrency<PreviewOpenInput>() },
  ),
  navigate: command<PreviewNavigateInput, PreviewSessionSnapshot>(
    "environment-data:preview:navigate",
    (client, input) => client.navigate(input),
    { scheduler: lifecycleScheduler, concurrency: lifecycleConcurrency<PreviewNavigateInput>() },
  ),
  resize: command<PreviewResizeInput, PreviewSessionSnapshot>(
    "environment-data:preview:resize",
    (client, input) => client.resize(input),
    { scheduler: lifecycleScheduler, concurrency: lifecycleConcurrency<PreviewResizeInput>() },
  ),
  refresh: command<PreviewRefreshInput, void>(
    "environment-data:preview:refresh",
    (client, input) => client.refresh(input),
    { scheduler: lifecycleScheduler, concurrency: lifecycleConcurrency<PreviewRefreshInput>() },
  ),
  close: command<PreviewCloseInput, unknown>(
    "environment-data:preview:close",
    (client, input) => client.close(input),
    { scheduler: lifecycleScheduler, concurrency: lifecycleConcurrency<PreviewCloseInput>() },
  ),
  reportStatus: command<PreviewReportStatusInput, void>(
    "environment-data:preview:report-status",
    (client, input) => client.reportStatus(input),
    {
      scheduler: statusScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId]),
      },
    },
  ),
  respondToAutomation: command<PreviewAutomationResponse, unknown>(
    "environment-data:preview:automation-respond",
    (client, input) => client.automation.respond(input),
    {
      scheduler: automationScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.connectionId, input.requestId]),
      },
    },
  ),
  focusAutomationHost: command<PreviewAutomationHostFocus, unknown>(
    "environment-data:preview:automation-focus-host",
    (client, input) => client.automation.focusHost(input),
    {
      scheduler: automationScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.clientId, input.connectionId]),
      },
    },
  ),
};
