import { loadInternalWorker } from "../internal/internal-worker.ts";
import * as Cause from "effect/Cause";
import * as Cron from "effect/Cron";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
const EntryWorker = {
  worker: () =>
    loadInternalWorker("#cloudflare-runtime-core-worker/globals/entry.worker"),
};
import {
  SERVICE_USER_WORKER,
  SOCKET_USER_ENTRY,
} from "../internal/constants.ts";
import { formatInternalWorkerModules } from "../internal/internal-modules.ts";
import * as Plugin from "../Plugin.ts";
import { PluginContext } from "../PluginContext.ts";
import { ConfigError } from "../RuntimeError.shared.ts";
import type * as WorkerdConfig from "../workerd/Config.ts";
import * as Cf from "./Cf.ts";
import {
  BINDING_EMAIL_DIRECTORY,
  BINDING_EMAIL_DISK,
  SERVICE_EMAIL_STORAGE,
} from "./EmailOptions.shared.ts";
import { BINDING_USER_WORKER_DIRECT } from "./EntryOptions.shared.ts";
import * as Internet from "./Internet.ts";
import { PATH_SCHEDULED } from "./ScheduledOptions.shared.ts";
import * as Storage from "./Storage.ts";

export class Globals extends Plugin.Service<Globals>()(
  "cloudflare-runtime/plugin/Globals",
) {}

/**
 * Fire one cron expression against the entry socket's scheduled route.
 *
 * Driven by `Schedule.cron`: each iteration sleeps until the expression's
 * next match, then triggers the route — no polling, no manual clock math.
 * Trigger failures are logged and the loop continues. The loop runs on the
 * worker's start `Scope`, so it dies with the worker.
 */
const cronLoop = (
  workerName: string,
  expression: string,
  cron: Cron.Cron,
  port: number,
) => {
  const fire = Effect.gen(function* () {
    const time = yield* Effect.sync(() => Date.now());
    const url =
      `http://127.0.0.1:${port}${PATH_SCHEDULED}` +
      `?cron=${encodeURIComponent(expression)}&time=${time}`;
    const response = yield* Effect.tryPromise(() =>
      fetch(url, { method: "POST" }),
    );
    const body = yield* Effect.tryPromise(() => response.text());
    if (response.ok) {
      yield* Effect.logInfo(
        `[cron:${workerName}] "${expression}" triggered scheduled(): ${body}`,
      );
    } else {
      yield* Effect.logWarning(
        `[cron:${workerName}] "${expression}" scheduled() handler failed: ${body}`,
      );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(
        `[cron:${workerName}] "${expression}" trigger failed`,
        Cause.squash(cause),
      ),
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
    const modules = formatInternalWorkerModules(
      yield* Effect.promise(EntryWorker.worker),
    );

    // Inbound email replies (`message.reply(...)` from the user worker's
    // `email()` handler) are persisted under `{storage}/email` — the same
    // directory the send-email simulator writes to. The entry middleware
    // gets a disk service binding plus the node-side absolute path so its
    // logged file paths point at real files. Miniflare persists replies via
    // its loopback `store-temp-file` endpoint instead.
    const storageDiskPath = "disk" in storage ? storage.disk?.path : undefined;
    const email =
      storageDiskPath === undefined
        ? undefined
        : yield* Effect.gen(function* () {
            const persistPath = path.join(storageDiskPath, "email");
            yield* fs.makeDirectory(persistPath, { recursive: true }).pipe(
              Effect.mapError(
                (cause) =>
                  new ConfigError({
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
        const crons = yield* Effect.forEach(
          worker.crons ?? [],
          (expression) => {
            const parsed = Cron.parse(expression, "UTC");
            return Result.isSuccess(parsed)
              ? Effect.succeed({ expression, cron: parsed.success })
              : Effect.fail(
                  new ConfigError({
                    subtag: "InvalidCron",
                    message: `Invalid cron expression "${expression}": ${parsed.failure.message}`,
                    hint: 'Use a standard cron expression, e.g. "*/5 * * * *".',
                    detail: { workerName: worker.name, expression },
                  }),
                );
          },
        );
        return {
          middlewares: [
            {
              name: "plugin:entry",
              worker: {
                compatibilityDate: "2026-03-10",
                compatibilityFlags: [
                  "experimental",
                  "enable_request_signal",
                  "service_binding_extra_handlers",
                ],
                modules,
                bindings: [
                  { name: "CF_BLOB", json: JSON.stringify(blob) },
                  // Non-fetch dispatch (queue/scheduled/email JSRPC) goes
                  // straight to the raw user worker: the `USER_WORKER`
                  // upstream binding points at the next middleware in the
                  // chain, and middlewares are fetch-only HTTP interceptors
                  // (see EntryOptions.shared.ts).
                  {
                    name: BINDING_USER_WORKER_DIRECT,
                    service: { name: SERVICE_USER_WORKER },
                  },
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
          services: [
            internet,
            storage,
            ...(email === undefined ? [] : [email.service]),
          ],
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
                        Effect.forkScoped(
                          cronLoop(worker.name, expression, cron, port),
                        ),
                      { discard: true },
                    );
                  }),
        };
      }),
    );
  }),
);
