import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Result from "effect/Result";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { LegacyAlarmObject } from "./legacy.ts";
import { AlarmObject, type RegistrationResult } from "./object.ts";

export default class AlarmCallbackWorker extends Cloudflare.Worker<AlarmCallbackWorker>()(
  "AlarmCallbackWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const objects = yield* AlarmObject;
    const legacyObjects = yield* LegacyAlarmObject;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://alarm-callback");
        if (url.pathname === "/ready") {
          return HttpServerResponse.text("alarm-callback-ready");
        }
        const [, id, operation] = url.pathname.split("/");
        if (!id || !operation) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const object = objects.getByName(id);
        if (request.method === "GET" && operation === "snapshot") {
          return yield* HttpServerResponse.json(yield* object.snapshot());
        }
        if (request.method === "GET" && operation === "legacy") {
          return yield* HttpServerResponse.json(
            yield* legacyObjects.getByName(id).snapshot(),
          );
        }
        if (request.method !== "POST") {
          return HttpServerResponse.text("Method Not Allowed", { status: 405 });
        }
        switch (operation) {
          case "worker-registration": {
            const snapshot = yield* object.snapshot();
            const context = yield* Alchemy.RuntimeContext;
            const exit = yield* Effect.exit(
              Alchemy.makeCallback(
                "unsupported-worker",
                (_payload: { value: string }) => Effect.void,
              ),
            );
            const defect = Exit.isFailure(exit)
              ? Result.getOrUndefined(Cause.findDefect(exit.cause))
              : undefined;
            const result: RegistrationResult & { runtimeType: string } = {
              runtimeType: context.Type,
              failure:
                defect instanceof Alchemy.CallbackError
                  ? {
                      tag: defect._tag,
                      callback: defect.callback,
                      message: defect.message,
                    }
                  : null,
              snapshot,
            };
            return yield* HttpServerResponse.json(result);
          }
          case "late-registration":
            return yield* HttpServerResponse.json(yield* object.registerLate());
          case "bookkeeping":
            return yield* HttpServerResponse.json(yield* object.bookkeeping());
          case "cancel-bookkeeping":
            return yield* HttpServerResponse.json(
              yield* object.cancelBookkeeping(),
            );
          case "bookkeeping-rollback":
            return yield* HttpServerResponse.json(
              yield* object.failedBookkeeping(true),
            );
          case "bookkeeping-failure":
            return yield* HttpServerResponse.json(
              yield* object.failedBookkeeping(false),
            );
          case "alarm-observations":
            return yield* HttpServerResponse.json(
              yield* object.alarmObservations(),
            );
          case "timing":
            return yield* HttpServerResponse.json(yield* object.timing());
          case "atomic":
            return yield* HttpServerResponse.json(yield* object.atomic());
          case "transactional-registration":
            return yield* HttpServerResponse.json(
              yield* object.transactionalRegistration(),
            );
          case "sibling-transaction":
            return yield* HttpServerResponse.json(
              yield* object.siblingTransaction(),
            );
          case "rollback-explicit":
            return yield* HttpServerResponse.json(
              yield* object.rollbackExplicit(),
            );
          case "rollback-typed":
            return yield* HttpServerResponse.json(
              yield* object.rollbackTyped(),
            );
          case "rollback-defect":
            return yield* HttpServerResponse.json(
              yield* object.rollbackDefect(),
            );
          case "rollback-interrupt":
            return yield* HttpServerResponse.json(
              yield* object.rollbackInterrupt(),
            );
          case "retry":
            yield* object.retry();
            break;
          case "replace":
            yield* object.replace();
            break;
          case "recovery":
            yield* object.recovery();
            break;
          case "recovery-no-retry":
            yield* object.recovery(false);
            break;
          case "wake":
            yield* object.wake();
            break;
          case "reset":
            return yield* HttpServerResponse.json(
              yield* object.prepareReset(url.searchParams.get("value") ?? id),
            );
          case "optional":
            return yield* HttpServerResponse.json(yield* object.optional());
          case "release-pending":
            return yield* HttpServerResponse.json(
              yield* object.releasePending(),
            );
          case "enable-optional":
            yield* object.enableOptional();
            break;
          case "batch":
            yield* object.batch();
            break;
          case "legacy":
            yield* legacyObjects.getByName(id).start();
            break;
          case "abort":
            return yield* object.crash().pipe(
              Effect.matchCauseEffect({
                onFailure: () => HttpServerResponse.json({ aborted: true }),
                onSuccess: () => HttpServerResponse.json({ aborted: false }),
              }),
            );
          default:
            return HttpServerResponse.text("Not Found", { status: 404 });
        }
        return yield* HttpServerResponse.json({ ok: true });
      }).pipe(Effect.orDie),
    };
  }),
) {}
