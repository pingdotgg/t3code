import * as Cause from "effect/Cause";
import * as Cron from "effect/Cron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import { loadInternalWorker } from "../internal/internal-worker.ts";
const EntryWorker = {
  worker: () => loadInternalWorker("#cloudflare-runtime-core-worker/globals/entry.worker"),
};
const AccessIdentityWorker = {
  worker: () =>
    loadInternalWorker("#cloudflare-runtime-core-worker/globals/access-identity.worker"),
};
/** Resolves `ctx.access.getIdentity()` for a Worker simulating Access. */
const SERVICE_ACCESS_IDENTITY = "globals:access-identity";
const OutboundWorker = {
  worker: () => loadInternalWorker("#cloudflare-runtime-core-worker/globals/outbound.worker"),
};
/** The outbound interceptor at the top of the user Worker's `globalOutbound`. */
const SERVICE_OUTBOUND = "globals:outbound";
import {
  DEFAULT_COMPATIBILITY_DATE,
  SERVICE_USER_WORKER,
  SOCKET_USER_ENTRY,
} from "../internal/constants.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Plugin from "../Plugin.ts";
import { PluginContext } from "../PluginContext.ts";
import { ConfigError } from "../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../workerd/Config.ts";
import * as Cf from "./Cf.ts";
import { cfImageHandler } from "./CfImage.ts";
import {
  BINDING_EMAIL_DIRECTORY,
  BINDING_EMAIL_DISK,
  SERVICE_EMAIL_STORAGE,
} from "./EmailOptions.shared.ts";
import {
  BINDING_ACCESS_BLOB,
  BINDING_USER_WORKER_DIRECT,
  HEADER_ACCESS_BLOB,
} from "./EntryOptions.shared.ts";
import * as Internet from "./Internet.ts";
import * as Loopback from "./Loopback.ts";
import { BINDING_PROXY_SHARED_SECRET } from "./ProxyHeaders.shared.ts";
import { PATH_SCHEDULED } from "./ScheduledOptions.shared.ts";
import * as Storage from "./Storage.ts";

export class Globals extends Plugin.Service<Globals>()("cloudflare-runtime/plugin/Globals") {}

/**
 * Fire one cron expression against the entry socket's scheduled route.
 *
 * Driven by `Schedule.cron`: each iteration sleeps until the expression's
 * next match, then triggers the route — no polling, no manual clock math.
 * Trigger failures are logged and the loop continues. The loop runs on the
 * worker's start `Scope`, so it dies with the worker.
 */
const cronLoop = (workerName: string, expression: string, cron: Cron.Cron, port: number) => {
  const fire = Effect.gen(function* () {
    const time = yield* Effect.sync(() => Date.now());
    const url =
      `http://127.0.0.1:${port}${PATH_SCHEDULED}` +
      `?cron=${encodeURIComponent(expression)}&time=${time}`;
    const response = yield* Effect.tryPromise(() => fetch(url, { method: "POST" }));
    const body = yield* Effect.tryPromise(() => response.text());
    if (response.ok) {
      yield* Effect.logInfo(`[cron:${workerName}] "${expression}" triggered scheduled(): ${body}`);
    } else {
      yield* Effect.logWarning(
        `[cron:${workerName}] "${expression}" scheduled() handler failed: ${body}`,
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`[cron:${workerName}] "${expression}" trigger failed`, Cause.squash(cause)),
    ),
  );
  // `Schedule.cron` over a pre-parsed `Cron` cannot fail to parse, so the
  // loop's error channel is `never`.
  return fire.pipe(Effect.schedule(Schedule.cron(cron)), Effect.asVoid);
};

export const GlobalsLive = Layer.effect(
  Globals,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const internet = yield* Internet.Internet;
    const storage = yield* Storage.Storage;
    const cf = yield* Cf.Cf;
    const modules = formatInternalWorkerModules(yield* Effect.promise(EntryWorker.worker));
    const outboundModules = formatInternalWorkerModules(
      yield* Effect.promise(OutboundWorker.worker),
    );
    const accessIdentityModules = formatInternalWorkerModules(
      yield* Effect.promise(AccessIdentityWorker.worker),
    );

    // Inbound email replies (`message.reply(...)` from the user worker's
    // `email()` handler) are persisted under `{storage}/email` — the same
    // directory the send-email simulator writes to. The entry middleware
    // gets a disk service binding plus the node-side absolute path so its
    // logged file paths point at real files. Miniflare persists replies via
    // its loopback `store-temp-file` endpoint instead.
    const storageDiskPath = "disk" in storage ? storage.disk?.path : undefined;
    const createEmailStorage = Effect.gen(function* () {
      if (storageDiskPath === undefined) {
        return undefined;
      }
      const persistPath = path.join(storageDiskPath, "email");
      yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
        Effect.mapError((cause) =>
          ConfigError.make({
            subtag: "Globals",
            message: `Failed to create email persistence directory "${persistPath}": ${cause.message}`,
            hint: "Ensure the storage directory is writable.",
            detail: { persistPath },
            cause,
          }),
        ),
      );
      return {
        persistPath,
        service: {
          name: SERVICE_EMAIL_STORAGE,
          disk: { path: persistPath, writable: true },
        } satisfies WorkerdConfig.Service,
      };
    });
    const email = yield* createEmailStorage;
    return Globals.of(
      Effect.gen(function* () {
        const { worker } = yield* PluginContext;
        // Per-worker `request.cf` override; falls back to the runtime-wide
        // `Cf` reference (Miniflare's static placeholder by default).
        const blob = worker.cf ?? cf;
        // Validate cron expressions up front so a typo is a `ConfigError` at
        // plan/config time rather than a dead timer at runtime. Cloudflare
        // evaluates crons in UTC; pin the parse to UTC so `Cron.next`
        // matches production timing.
        const crons = yield* Effect.forEach(worker.crons ?? [], (expression) => {
          const parsed = Cron.parse(expression, "UTC");
          return Result.isSuccess(parsed)
            ? Effect.succeed({ expression, cron: parsed.success })
            : Effect.fail(
                ConfigError.make({
                  subtag: "InvalidCron",
                  message: `Invalid cron expression "${expression}": ${parsed.failure.message}`,
                  hint: 'Use a standard cron expression, e.g. "*/5 * * * *".',
                  detail: { workerName: worker.name, expression },
                }),
              );
        });
        const context = yield* PluginContext;
        return {
          middlewares: [
            {
              name: "plugin:entry",
              // Accept and route internal requests before assets or other middleware.
              order: -2,
              worker: {
                compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                compatibilityFlags: [
                  "experimental",
                  "enable_request_signal",
                  "service_binding_extra_handlers",
                ],
                modules,
                bindings: [
                  { name: "CF_BLOB", json: JSON.stringify(blob) },
                  {
                    name: BINDING_PROXY_SHARED_SECRET,
                    text: worker.proxySharedSecret ?? "",
                  },
                  // Non-fetch dispatch (queue/scheduled/email JSRPC) goes
                  // straight to the raw user worker: the `USER_WORKER`
                  // upstream binding points at the next middleware in the
                  // chain, and middlewares are fetch-only HTTP interceptors
                  // (see EntryOptions.shared.ts).
                  {
                    name: BINDING_USER_WORKER_DIRECT,
                    service: { name: SERVICE_USER_WORKER },
                  },
                  ...(worker.access === undefined
                    ? []
                    : [
                        {
                          name: BINDING_ACCESS_BLOB,
                          json: JSON.stringify({
                            app_aud: worker.access.aud ?? "dev",
                            ...(worker.access.identity === undefined
                              ? {}
                              : { jwt_claims: worker.access.identity }),
                          }),
                        },
                      ]),
                  ...(email === undefined
                    ? []
                    : [
                        {
                          name: BINDING_EMAIL_DISK,
                          service: { name: SERVICE_EMAIL_STORAGE },
                        },
                        {
                          name: BINDING_EMAIL_DIRECTORY,
                          json: JSON.stringify(email.persistPath),
                        },
                      ]),
                ],
              },
              upstreamBindingName: "USER_WORKER",
            },
          ],
          // Deferred until every plugin is built: the outbound interceptor
          // reaches its Sharp transform through the Loopback plugin.
          defer: Effect.gen(function* () {
            const loopback = yield* context.get(Loopback.Loopback);
            // Sharp transforms for `cf.image` fetches, served Node-side.
            const cfImage = yield* loopback.api.route(
              `globals:cf-image:${worker.name}`,
              cfImageHandler,
            );
            return {
              services: [
                internet,
                storage,
                ...(email === undefined ? [] : [email.service]),
                ...(worker.access === undefined
                  ? []
                  : [
                      {
                        name: SERVICE_ACCESS_IDENTITY,
                        worker: {
                          compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                          compatibilityFlags: ["experimental", "service_binding_extra_handlers"],
                          modules: accessIdentityModules,
                        },
                      },
                    ]),
                {
                  name: SERVICE_OUTBOUND,
                  worker: {
                    compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
                    // `connect()` sockets (Hyperdrive, `cloudflare:sockets`)
                    // go through `globalOutbound` too; pass them straight
                    // through, as Miniflare's interceptor does.
                    compatibilityFlags: ["connect_pass_through", "experimental"],
                    modules: outboundModules,
                    bindings: [
                      {
                        name: "CF_WORKER_ZONE",
                        text: worker.zone ?? `${worker.name}.example.com`,
                      },
                      { name: "CF_IMAGE", service: cfImage },
                    ],
                  },
                },
              ],
              // Outbound `fetch()`es pass through the interceptor, as in
              // Miniflare, which continues to the internet.
              // A Worker simulating Access gets `ctx.access` from the entry's
              // blob header, and its identity from the identity service.
              userWorker: {
                globalOutbound: { name: SERVICE_OUTBOUND },
                ...(worker.access === undefined
                  ? {}
                  : {
                      accessBlobHeader: HEADER_ACCESS_BLOB,
                      accessBindingService: { name: SERVICE_ACCESS_IDENTITY },
                    }),
              },
            };
          }),
          start:
            crons.length === 0
              ? undefined
              : (ports) =>
                  Effect.gen(function* () {
                    const port = ports[SOCKET_USER_ENTRY];
                    if (port === undefined) return;
                    yield* Effect.forEach(
                      crons,
                      ({ expression, cron }) =>
                        Effect.forkScoped(cronLoop(worker.name, expression, cron, port)),
                      { discard: true },
                    );
                  }),
        };
      }),
    );
  }),
);
