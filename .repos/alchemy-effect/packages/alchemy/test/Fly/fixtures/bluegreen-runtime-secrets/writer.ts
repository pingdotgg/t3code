import * as Fly from "@/Fly";
import type { Input } from "@/Input";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

export const Site = Fly.App("Site");
export const TRIGGER_SECRET = "RUNTIME_WRITER_TRIGGER";
export const Token = Fly.Secret("Token", {
  app: Site,
  name: "ACCEPTANCE_RUNTIME_SECRET",
  value: Redacted.make("fixture-token-two"),
});

export class Writer extends Fly.Service<Writer>()("Writer") {}

export const writerLayer = (triggerDigest?: Input<string | undefined>) =>
  Writer.make(
    {
      app: Site,
      main: import.meta.url,
      region: "iad",
      port: 3000,
      guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
      env: { TRIGGER_READY: triggerDigest ?? "" },
      services: [
        {
          protocol: "tcp",
          internalPort: 3000,
          autostop: "off",
          ports: [{ port: 443, handlers: ["tls", "http"] }],
          checks: [
            {
              type: "http",
              port: 3000,
              path: "/health",
              interval: "2s",
              timeout: "1s",
            },
          ],
        },
      ],
    },
    Effect.gen(function* () {
      const token = yield* Token;
      const name = yield* token.name;
      const write = yield* Fly.WriteSecret(Token);
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          if (request.url === "/health" && request.method === "GET") {
            return HttpServerResponse.empty({ status: 200 });
          }
          if (
            request.url !== "/writer" ||
            (request.method !== "GET" && request.method !== "POST")
          ) {
            return HttpServerResponse.empty({ status: 404 });
          }
          return yield* Effect.gen(function* () {
            const trigger = yield* Config.Redacted(TRIGGER_SECRET);
            if (
              request.headers.authorization !==
              `Bearer ${Redacted.value(trigger)}`
            ) {
              return HttpServerResponse.empty({ status: 401 });
            }
            const machineId = yield* Effect.sync(
              () => process.env.FLY_MACHINE_ID,
            );
            if (!machineId) {
              return HttpServerResponse.empty({ status: 503 });
            }
            if (request.method === "GET") {
              return yield* HttpServerResponse.json({
                version: 0,
                machineId,
                marker: "ready",
              });
            }
            const updated = yield* write.update(
              yield* name,
              Redacted.make("fixture-token-three"),
            );
            const version = updated.version ?? updated.Version;
            if (
              version === undefined ||
              !Number.isSafeInteger(version) ||
              version <= 0
            ) {
              return HttpServerResponse.empty({ status: 502 });
            }
            return yield* HttpServerResponse.json({
              version,
              machineId,
              marker: "three",
            });
          }).pipe(
            // SDK failures may contain request details; never return or log them.
            Effect.catch(() =>
              Effect.succeed(HttpServerResponse.empty({ status: 502 })),
            ),
          );
        }),
      };
    }).pipe(Effect.provide(Fly.WriteSecretHttp)),
  );

export default writerLayer();
