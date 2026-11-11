import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { BackendClient } from "./BackendClient";
import { env } from "./Env";
import { FrontendApi, Hello, KvOk, KvValue } from "./NextApi";

const kvGet = (key: string) =>
  Effect.tryPromise({
    try: () => env.KV.get(key),
    catch: (cause) => new Error(String(cause)),
  }).pipe(Effect.orDie);

const kvPut = (key: string, value: string) =>
  Effect.tryPromise({
    try: () => env.KV.put(key, value),
    catch: (cause) => new Error(String(cause)),
  }).pipe(Effect.orDie);

export const FrontendHandlers = HttpApiBuilder.group(
  FrontendApi,
  "frontend",
  Effect.fn(function* (handlers) {
    const client = yield* BackendClient;

    return handlers
      .handle("hello", () =>
        client.Backend.listNotes().pipe(
          Effect.map(
            (listed) =>
              new Hello({
                message: env.GREETING ?? "Hello from vinext!",
                noteCount: listed.notes.length,
              }),
          ),
          Effect.orDie,
        ),
      )
      .handle("listNotes", () => client.Backend.listNotes().pipe(Effect.orDie))
      .handle("createNote", ({ payload }) =>
        client.Backend.createNote({ payload }).pipe(Effect.orDie),
      )
      .handle("deleteNote", ({ params }) =>
        client.Backend.deleteNote({ params }).pipe(Effect.orDie),
      )
      .handle("getKv", ({ params }) =>
        kvGet(params.key).pipe(Effect.map((value) => new KvValue({ value }))),
      )
      .handle("putKv", ({ params, payload }) =>
        kvPut(params.key, payload).pipe(Effect.as(new KvOk({ ok: true }))),
      );
  }),
);
