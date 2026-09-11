import * as Fly from "alchemy/Fly";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { API_PORT, Data, Site } from "./shared.ts";

/**
 * HTTP Service that puts and gets an object on a Tigris bucket via
 * the S3 API.
 */
export default class Api extends Fly.Service<Api>()(
  "Api",
  {
    app: Site,
    main: import.meta.url,
    region: "iad",
    port: API_PORT,
    guest: { cpuKind: "shared", cpus: 1, memoryMb: 256 },
  },
  Effect.gen(function* () {
    const putObject = yield* Fly.PutObject(Data);
    const getObject = yield* Fly.GetObject(Data);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;
        if (path === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        yield* putObject({
          Key: "hello.txt",
          Body: "hello-from-tigris",
          ContentType: "text/plain",
        }).pipe(Effect.orDie);
        const obj = yield* getObject({ Key: "hello.txt" }).pipe(Effect.orDie);
        const text =
          obj.Body === undefined
            ? ""
            : yield* Stream.mkString(Stream.decodeText(obj.Body)).pipe(
                Effect.orDie,
              );
        return yield* HttpServerResponse.json({
          ok: text === "hello-from-tigris",
          text,
        });
      }),
    };
  }).pipe(Effect.provide([Fly.PutObjectHttp, Fly.GetObjectHttp])),
) {}
