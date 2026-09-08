import * as Cloudflare from "@/Cloudflare";
import * as Alchemy from "@/index.ts";
import type { RuntimeContext } from "@/RuntimeContext.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ProbeEnv, ProbeEnvBinding } from "./env-binding.ts";
import { Storage } from "./storage.ts";

export class MyContainer extends Cloudflare.Container<
  MyContainer,
  {
    ping: () => Effect.Effect<string>;
    /** The value a `Binding.Service` injected into the container's env. */
    boundEnv: () => Effect.Effect<string | undefined, never, RuntimeContext>;
    /** Read an object's text body from R2 (or `null` when absent). */
    readObject: (
      key: string,
    ) => Effect.Effect<string | null, never, RuntimeContext>;
  }
>()("EffectfulContainer") {}

export default MyContainer.make(
  {
    main: import.meta.url,
    image: "oven/bun:latest",
  },
  Effect.gen(function* () {
    // The container reads R2 over a scoped HTTP API token (not the native
    // Worker binding) — this proves the HTTP R2 client works from inside a
    // container process. `Alchemy.remote()` pins the bucket (and the minted
    // token) live even under `alchemy dev`: the HTTP client talks to real
    // Cloudflare, which a `dev:` local bucket can't serve. This is the
    // FIRST registration site (the container layer builds before the stack
    // body), so the DO's later undecorated native-binding site inherits the
    // pin and both paths converge on the same live bucket.
    const bucket = yield* Cloudflare.R2.ReadWriteBucket(Storage).pipe(
      Alchemy.remote(),
    );

    // A capability whose only deploy-time contribution is an env var. A
    // container has no workerd bindings, so this is the channel every
    // env-shaped capability (Prisma.Connect, …) reaches it through.
    const boundEnv = yield* ProbeEnv(Storage);

    const read = (key: string) =>
      bucket.get(key).pipe(
        Effect.flatMap((object) =>
          object ? object.text() : Effect.succeed(null),
        ),
        Effect.orDie,
      );

    return {
      ping: () => Effect.succeed("pong"),
      boundEnv: () => boundEnv,
      readObject: read,
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://container");
        if (url.pathname === "/bound-env") {
          return yield* HttpServerResponse.json({ value: yield* boundEnv });
        }
        if (url.pathname === "/health") {
          return yield* HttpServerResponse.json({ ok: true });
        }
        if (url.pathname === "/object") {
          const key = url.searchParams.get("key") ?? "";
          const value = yield* read(key);
          return yield* HttpServerResponse.json({ value });
        }
        return HttpServerResponse.text("hello from effectful container");
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(Cloudflare.R2.ReadWriteBucketHttp, ProbeEnvBinding),
    ),
  ),
);
