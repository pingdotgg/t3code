import { AuthOrchestrationReadScope, ExtensionOperationError } from "@t3tools/contracts";
import type { DiscoveredLocalServer } from "@t3tools/contracts";
import {
  browserLocalServersApi,
  type BrowserLocalServersSnapshot,
} from "@t3tools/extension-sdk/catalogue";
import type { HostApiProvider } from "@t3tools/extension-runtime";
import { isLoopbackHost } from "@t3tools/shared/preview";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../persistence/Services/ProjectionThreads.ts";
import { PortDiscovery } from "../preview/PortScanner.ts";
import { makeExtensionScopeResolver } from "./scope.ts";

const failure = (detail: string) =>
  new ExtensionOperationError({ operation: "browser.local-servers", detail });
const inputSchema = Schema.Record(Schema.String, Schema.Never);

/** Only environment loopback origins leave the scanner; process and terminal metadata stay private. */
export function projectBrowserLocalServers(
  input: ReadonlyArray<DiscoveredLocalServer>,
): BrowserLocalServersSnapshot {
  const entries = new Map<string, { url: string; port: number }>();
  let truncated = false;
  for (const server of input) {
    try {
      const url = new URL(server.url);
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !isLoopbackHost(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.href.length > 256 ||
        port !== server.port
      ) {
        truncated = true;
        continue;
      }
      entries.set(url.href, { url: url.href, port });
    } catch {
      truncated = true;
    }
  }
  const servers = [...entries.values()].sort(
    (left, right) => left.port - right.port || left.url.localeCompare(right.url),
  );
  return {
    kind: "snapshot",
    scope: "environment",
    servers: servers.slice(0, 64),
    truncated: truncated || servers.length > 64,
  };
}

export function createBrowserLocalServersApiProvider(
  dependencies: Parameters<typeof makeExtensionScopeResolver>[0] & {
    readonly discovery: Pick<PortDiscovery["Service"], "retain" | "scan" | "subscribe">;
  },
): HostApiProvider {
  const resolve = makeExtensionScopeResolver(dependencies);
  return {
    providerId: "host.browser-local-servers",
    definition: browserLocalServersApi.definition,
    requiresRootAuthority: true,
    invoke: () => Promise.reject(failure("Local servers has no methods.")),
    subscribe: (name, input, context, signal, metadata, resumeCursor) => {
      if (name !== "subscribe" || resumeCursor !== undefined)
        throw failure("Unsupported local server stream or resume cursor.");
      try {
        Schema.decodeUnknownSync(inputSchema, { onExcessProperty: "error" })(input);
      } catch {
        throw failure("Invalid local server request.");
      }
      const principal = metadata.principal;
      if (
        !principal ||
        principal.environmentId !== dependencies.environmentId ||
        !principal.scopes.includes(AuthOrchestrationReadScope) ||
        !metadata.assertAuthority
      )
        throw failure("Local server read authority is unavailable.");
      const assertAuthority = metadata.assertAuthority;
      return (async function* () {
        signal.throwIfAborted();
        const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect, { signal });
        const scope = await run(resolve(context));
        await assertAuthority();
        signal.throwIfAborted();
        // Same retain/scan/subscribe seam as subscribeDiscoveredLocalServers in ws.ts.
        const source = Stream.callback<BrowserLocalServersSnapshot>(
          (queue) =>
            Effect.gen(function* () {
              yield* dependencies.discovery.retain;
              const initial = yield* dependencies.discovery.scan([]);
              yield* Queue.offer(queue, projectBrowserLocalServers(initial));
              yield* dependencies.discovery.subscribe(
                { configuredUrls: [], initialSnapshot: initial },
                (servers) =>
                  Queue.offer(queue, projectBrowserLocalServers(servers)).pipe(Effect.asVoid),
              );
            }),
          { bufferSize: 1, strategy: "sliding" },
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

export const makeBrowserLocalServersApiProvider = Effect.fn("BrowserLocalServersApi.make")(
  function* () {
    const environment = yield* ServerEnvironment;
    return createBrowserLocalServersApiProvider({
      environmentId: yield* environment.getEnvironmentId,
      projects: yield* ProjectionProjectRepository,
      threads: yield* ProjectionThreadRepository,
      discovery: yield* PortDiscovery,
    });
  },
);
