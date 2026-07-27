import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { BunObject } from "./bun-object.ts";
import { EffectfulObject } from "./effectful-object.ts";
import { OpencodeObject } from "./opencode-object.ts";
import { RemoteObject } from "./remote-object.ts";

/**
 * Cloudflare Worker host for the container cold-start benchmark. Each request
 * names a fresh DO instance (`?name=`), which boots its own container.
 *
 * - `GET /boot?variant=effectful|bun|remote|opencode&name=K` boots one
 *   container and returns `{ readyMs }`. It does NOT shut down.
 * - `GET /shutdown?variant=…&name=K` tears the container down so the next boot
 *   is an independent cold start and the account's container cap isn't exhausted.
 *
 * TIMING: the clock runs HERE in the Worker, around the entire DO call — not
 * inside the DO. The container layer eagerly calls `container.start()` during
 * DO construction, so a clock started inside `boot()` would miss instance
 * allocation and start entirely, undercounting the cold start. Wrapping the
 * `getByName(name).boot()` call captures DO creation + container start +
 * readiness probe, while staying inside Cloudflare (no client network in the
 * number) — symmetric with the MicroVM hosts, which start the clock before
 * `RunMicrovm`.
 */
export default class ContainerWorker extends Cloudflare.Worker<ContainerWorker>()(
  "BenchContainerWorker",
  {
    main: import.meta.filename,
  },
  Effect.gen(function* () {
    const effectful = yield* EffectfulObject;
    const remote = yield* RemoteObject;
    const bun = yield* BunObject;
    const opencode = yield* OpencodeObject;

    const objectFor = (variant: string) =>
      variant === "remote"
        ? remote
        : variant === "bun"
          ? bun
          : variant === "opencode"
            ? opencode
            : effectful;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://x");
        const name = url.searchParams.get("name") ?? "default";
        const variant = url.searchParams.get("variant") ?? "effectful";

        if (url.pathname === "/boot") {
          // Time the WHOLE thing: DO creation, eager container start during
          // layer construction, and the readiness probe inside boot().
          const start = yield* Effect.sync(() => Date.now());
          yield* objectFor(variant).getByName(name).boot();
          const readyMs = (yield* Effect.sync(() => Date.now())) - start;
          return yield* HttpServerResponse.json({ readyMs });
        }
        if (url.pathname === "/shutdown") {
          yield* objectFor(variant).getByName(name).shutdown();
          return yield* HttpServerResponse.json({ ok: true });
        }
        return HttpServerResponse.text("ok");
      }).pipe(
        Effect.catch((err) =>
          Effect.succeed(HttpServerResponse.text(String(err), { status: 500 })),
        ),
      ),
    };
  }),
) {}
