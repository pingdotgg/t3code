import { Effect } from "effect"
import * as esbuild from "esbuild"
import { Miniflare } from "miniflare"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

let bundled: Promise<string> | undefined

const bundleWorker = () => {
  bundled ??= esbuild.build({
    entryPoints: [path.join(import.meta.dirname, "fixtures", "worker.ts")],
    bundle: true,
    format: "esm",
    write: false,
    external: ["cloudflare:workers"],
    alias: {
      "@effect/platform-cloudflare": path.join(import.meta.dirname, "..", "..", "src")
    }
  }).then((bundle) => bundle.outputFiles[0].text)
  return bundled
}

export interface Cluster {
  /** Fetches a fixture worker endpoint and decodes its JSON response. */
  readonly fetchJson: (path: string) => Effect.Effect<any>
  /** Opens a named gate that a fixture handler is blocked on. */
  readonly openGate: (key: string) => Effect.Effect<void>
  /**
   * Restarts the workerd isolates while keeping Durable Object SQLite storage,
   * simulating an isolate crash, hibernation eviction, or deploy.
   */
  readonly restart: Effect.Effect<void>
  /**
   * Polls `check` until it returns true, failing with `description` and a dump
   * of the fixture worker state after the deadline.
   */
  readonly waitUntil: (
    description: string,
    check: Effect.Effect<boolean>,
    timeoutMillis?: number
  ) => Effect.Effect<void>
}

export const makeClusterWithHeartbeat = (keepAliveHeartbeat: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const script = await bundleWorker()
      const persistPath = await fs.mkdtemp(path.join(os.tmpdir(), "effect-cloudflare-integration-"))
      const options = {
        modules: [{ type: "ESModule" as const, path: "worker.mjs", contents: script }],
        compatibilityDate: "2026-08-01",
        bindings: { KEEP_ALIVE_HEARTBEAT: keepAliveHeartbeat },
        durableObjectsPersist: persistPath,
        durableObjects: {
          CLUSTER_ENTITY: { className: "ClusterEntity", useSQLite: true },
          CLUSTER_WORKFLOW: { className: "ClusterWorkflow", useSQLite: true },
          CLUSTER_QUEUE: { className: "ClusterDurableQueue", useSQLite: true },
          CLUSTER_SINGLETON: { className: "ClusterSingleton", useSQLite: true }
        }
      }
      const miniflare = new Miniflare(options)
      await miniflare.ready

      const fetchJson = (endpoint: string) =>
        Effect.promise(async () => {
          const response = await miniflare.dispatchFetch(`http://placeholder${endpoint}`)
          const body = await response.text()
          if (response.status !== 200) {
            throw new Error(`${endpoint} failed with status ${response.status}:\n${body}`)
          }
          return JSON.parse(body)
        })

      const cluster: Cluster = {
        fetchJson,
        openGate: (key) => Effect.asVoid(fetchJson(`/gate/open?key=${encodeURIComponent(key)}`)),
        restart: Effect.promise(() => miniflare.setOptions(options)),
        waitUntil: (description, check, timeoutMillis = 10_000) =>
          Effect.promise<void>(async () => {
            const deadline = Date.now() + timeoutMillis
            while (true) {
              if (await Effect.runPromise(check)) return
              if (Date.now() > deadline) {
                const state = await Effect.runPromise(fetchJson("/state")).catch((error) => String(error))
                throw new Error(`${description}\nFixture state: ${JSON.stringify(state)}`)
              }
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
          })
      }
      return { cluster, miniflare, persistPath }
    }),
    ({ miniflare, persistPath }) =>
      Effect.promise(async () => {
        await miniflare.dispose()
        await fs.rm(persistPath, { recursive: true, force: true })
      })
  ).pipe(Effect.map(({ cluster }) => cluster))

export const makeCluster = makeClusterWithHeartbeat("1 second")
