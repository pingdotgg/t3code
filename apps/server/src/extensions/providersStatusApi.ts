import {
  AuthOrchestrationReadScope,
  ExtensionOperationError,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  PROVIDER_STATUS_DISPLAY_NAME_MAX_LENGTH,
  providersStatusApi,
  type ProvidersStatusEvent,
  type ProviderStatusEntry,
} from "@t3tools/extension-sdk/catalogue";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../provider/Services/ProviderRegistry.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "providers.status", detail });
const inputSchema = Schema.Record(Schema.String, Schema.Never);
const MAX_PROVIDERS = 64;

/**
 * Identity, lifecycle and capability flags only — auth details, free-text
 * diagnostics, workspace paths and credential-bearing fields never cross the
 * extension boundary. Optional flags are copied explicitly so a new sensitive
 * `ServerProvider` field cannot leak through a spread.
 */
export function projectProviderStatuses(
  providers: ReadonlyArray<ServerProvider>,
): ProvidersStatusEvent {
  const entries = providers.slice(0, MAX_PROVIDERS).map((provider): ProviderStatusEntry => ({
    instanceId: provider.instanceId,
    driver: provider.driver,
    // Host display names are unbounded; the projected label is capped so a
    // valid long name cannot invalidate the whole frame.
    ...(provider.displayName === undefined
      ? {}
      : { displayName: provider.displayName.slice(0, PROVIDER_STATUS_DISPLAY_NAME_MAX_LENGTH) }),
    enabled: provider.enabled,
    installed: provider.installed,
    status: provider.status,
    availability: provider.availability ?? "available",
    checkedAt: provider.checkedAt,
    ...(provider.supportsConversationRollback === undefined
      ? {}
      : { supportsConversationRollback: provider.supportsConversationRollback }),
    ...(provider.supportsTextGeneration === undefined
      ? {}
      : { supportsTextGeneration: provider.supportsTextGeneration }),
    ...(provider.requiresNewThreadForModelChange === undefined
      ? {}
      : { requiresNewThreadForModelChange: provider.requiresNewThreadForModelChange }),
    ...(provider.showInteractionModeToggle === undefined
      ? {}
      : { showInteractionModeToggle: provider.showInteractionModeToggle }),
    ...(provider.reportsContextWindow === undefined
      ? {}
      : { reportsContextWindow: provider.reportsContextWindow }),
  }));
  return { kind: "snapshot", scope: "environment", providers: entries };
}

const sameProjection = (left: ProvidersStatusEvent, right: ProvidersStatusEvent) =>
  JSON.stringify(left) === JSON.stringify(right);

export function createProvidersStatusApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly providers: Pick<ProviderRegistryShape, "getProvidersSnapshot" | "subscribeChanges">;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  return {
    providerId: "host.providers-status",
    definition: providersStatusApi.definition,
    requiresRootAuthority: true,
    invoke: () => Promise.reject(failure("Provider status has no methods.")),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "subscribe" || resumeCursor !== undefined)
        throw failure("Unsupported provider status stream or resume cursor.");
      try {
        Schema.decodeUnknownSync(inputSchema, { onExcessProperty: "error" })(input);
      } catch {
        throw failure("Invalid provider status request.");
      }
      const principal = metadata.principal;
      if (
        !principal ||
        principal.environmentId !== dependencies.environmentId ||
        !principal.scopes.includes(AuthOrchestrationReadScope) ||
        !metadata.assertAuthority
      )
        throw failure("Provider status read authority is unavailable.");
      const assertAuthority = metadata.assertAuthority;
      return (async function* () {
        signal.throwIfAborted();
        const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect, { signal });
        const scope = await run(resolve(context));
        await assertAuthority();
        signal.throwIfAborted();
        // Initial snapshot then registry changes, deduplicated on the
        // projection so provider fields the contract drops (usage meters,
        // diagnostics) do not produce resends. The change subscription is
        // acquired before the snapshot read: the registry publishes on a
        // PubSub whose stream subscribes lazily, so reading first would let
        // an update published mid-read fall into the gap. Anything published
        // between the subscribe and the snapshot replays from the
        // subscription — but a queued publication can also predate the
        // snapshot it is already folded into, so each carries the registry
        // revision and is fenced at-or-below the latest delivered revision.
        // The queue must suspend, not slide: the pre-acquired subscription
        // can replay in the same burst as the snapshot, and a sliding
        // buffer would drop the snapshot.
        const source = Stream.callback<ProvidersStatusEvent>(
          (queue) =>
            Effect.gen(function* () {
              const live = yield* dependencies.providers.subscribeChanges;
              const initial = yield* dependencies.providers.getProvidersSnapshot;
              yield* Stream.runForEach(
                Stream.concat(
                  Stream.make(initial.providers),
                  Stream.fromSubscription(live).pipe(
                    Stream.mapAccum(
                      () => initial.revision,
                      (fence, change) => {
                        if (change.revision <= fence) return [fence, []] as const;
                        return [change.revision, [change.providers]] as const;
                      },
                    ),
                  ),
                ).pipe(Stream.map(projectProviderStatuses), Stream.changesWith(sameProjection)),
                (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
              );
            }),
          { bufferSize: 1, strategy: "suspend" },
        );
        const iterator = Stream.toAsyncIterable(source)[Symbol.asyncIterator]();
        const cancel = () => {
          void iterator.return?.().catch(() => {});
        };
        signal.addEventListener("abort", cancel, { once: true });
        try {
          signal.throwIfAborted();
          for (;;) {
            const next = await iterator.next();
            signal.throwIfAborted();
            await run(resolve(scope.context));
            await assertAuthority();
            signal.throwIfAborted();
            if (next.done) {
              yield {
                type: "closed" as const,
                value: { kind: "closed", reason: "source-unavailable" },
              };
              return;
            }
            yield { type: "snapshot" as const, value: next.value };
          }
        } finally {
          signal.removeEventListener("abort", cancel);
          await iterator.return?.();
        }
      })();
    },
  };
}

export const makeProvidersStatusApiProvider = Effect.fn("ProvidersStatusApi.make")(function* () {
  const environment = yield* ServerEnvironment;
  return createProvidersStatusApiProvider({
    environmentId: yield* environment.getEnvironmentId,
    projects: yield* ProjectionProjectRepository,
    threads: yield* ProjectionThreadRepository,
    providers: yield* ProviderRegistry,
  });
});
