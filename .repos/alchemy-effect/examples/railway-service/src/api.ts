import * as Drizzle from "alchemy/Drizzle/Postgres";
import * as Railway from "alchemy/Railway";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  API_PORT,
  Cache,
  Data,
  Db,
  Marker,
  OBJECT_KEY,
  REDIS_KEY,
  SECRET_NAME,
  Site,
} from "./shared.ts";

const runtime = Layer.mergeAll(
  Railway.ConnectPostgresHttp,
  Railway.ReadWriteRedisHttp,
  Railway.PutObjectHttp,
  Railway.GetObjectHttp,
  Railway.HeadObjectHttp,
  Railway.ListObjectsV2Http,
  Railway.DeleteObjectHttp,
);

/**
 * HTTP Service. Binds Postgres, Redis, and the Bucket. Reads the
 * shared {@link Marker} variable from env.
 */
export default class Api extends Railway.Service<Api>()(
  "Api",
  {
    project: Site,
    main: import.meta.url,
    port: API_PORT,
    build: { install: ["pg"] },
    healthcheck: "/health",
    env: {
      [SECRET_NAME]: Railway.ref("shared", SECRET_NAME),
    },
  },
  Effect.gen(function* () {
    yield* Marker;
    const conn = yield* Railway.ConnectPostgres(Db);
    const db = yield* Drizzle.Postgres(conn.connectionString);
    const cache = yield* Railway.ReadWriteRedis(Cache);
    const putObject = yield* Railway.PutObject(Data);
    const getObject = yield* Railway.GetObject(Data);
    const headObject = yield* Railway.HeadObject(Data);
    const listObjects = yield* Railway.ListObjectsV2(Data);
    const deleteObject = yield* Railway.DeleteObject(Data);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const path = new URL(request.url, "http://service").pathname;

        if (path === "/secret") {
          const value = yield* Config.string(SECRET_NAME).pipe(
            Effect.orElseSucceed(() => ""),
          );
          return yield* HttpServerResponse.json({
            ok: value.length > 0,
            name: SECRET_NAME,
          });
        }

        if (path === "/redis") {
          yield* cache.set(REDIS_KEY, "hello");
          const value = yield* cache.get(REDIS_KEY);
          return yield* HttpServerResponse.json({
            ok: value === "hello",
            value,
          });
        }

        if (path === "/bucket") {
          yield* putObject({
            Key: OBJECT_KEY,
            Body: "hello",
            ContentType: "text/plain",
          });
          const head = yield* headObject({ Key: OBJECT_KEY });
          const listed = yield* listObjects({
            Prefix: OBJECT_KEY,
            MaxKeys: 10,
          });
          const obj = yield* getObject({ Key: OBJECT_KEY });
          const text =
            obj.Body === undefined
              ? ""
              : yield* Stream.mkString(Stream.decodeText(obj.Body));
          yield* deleteObject({ Key: OBJECT_KEY });
          return yield* HttpServerResponse.json({
            ok: text === "hello",
            etag: head.ETag,
            listed: listed.KeyCount,
          });
        }

        const rows = yield* db.execute("select 1 as ok");
        if (path === "/health" || path === "/" || path === "/postgres") {
          return yield* HttpServerResponse.json({ rows });
        }
        return yield* HttpServerResponse.json({ rows }, { status: 404 });
      }).pipe(
        Effect.catch((error) =>
          HttpServerResponse.json(
            { ok: false, error: String(error) },
            { status: 500 },
          ),
        ),
      ),
    };
  }).pipe(Effect.provide(runtime)),
) {}
