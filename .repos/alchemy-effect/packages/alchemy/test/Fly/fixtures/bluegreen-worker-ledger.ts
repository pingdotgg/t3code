import * as Fly from "@/Fly";
import type { Input } from "@/Input";
import * as Redis from "@/Redis";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import {
  Cache,
  LedgerSite,
  scripts,
  services,
} from "./bluegreen-worker-shared.ts";

export class Ledger extends Fly.Service<Ledger>()("Ledger") {}
export const ledgerLayer = (secretDigest?: Input<string | undefined>) =>
  Ledger.make(
    {
      app: LedgerSite,
      main: import.meta.url,
      region: "iad",
      port: 3000,
      guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
      env: { SECRET_READY: secretDigest ?? "" },
      services,
    },
    Effect.gen(function* () {
      yield* Fly.ReadWriteRedis(Cache);
      const resource = yield* Cache;
      const boundUrl = yield* resource.url;
      const cache = Redis.makeReadWrite(
        Effect.gen(function* () {
          const url = yield* boundUrl;
          if (!url) return yield* Effect.die(new Error("Redis URL missing"));
          return Redacted.value(url);
        }),
      );
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest;
          if (request.url === "/health") {
            yield* cache.ping().pipe(Effect.orDie);
            return HttpServerResponse.text("ready");
          }
          const token = yield* Config.Redacted("LEDGER_TOKEN").pipe(
            Effect.orDie,
          );
          if (
            request.headers.authorization !== `Bearer ${Redacted.value(token)}`
          ) {
            return HttpServerResponse.empty({ status: 401 });
          }
          const body = (yield* request.json.pipe(Effect.orDie)) as {
            operation: keyof typeof scripts;
            args?: string[];
          };
          if (!Object.hasOwn(scripts, body.operation))
            return HttpServerResponse.empty({ status: 400 });
          const result = yield* cache
            .send("EVAL", [scripts[body.operation], 0, ...(body.args ?? [])])
            .pipe(Effect.orDie);
          return yield* HttpServerResponse.json({ result });
        }),
      };
    }).pipe(Effect.provide(Fly.ReadWriteRedisHttp)),
  );

export default ledgerLayer();
