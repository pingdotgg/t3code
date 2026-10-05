import * as Effect from "effect/Effect";
import { version } from "./version.ts";

let initialized = false;
let stopping: { signal: string; at: number; active: number } | undefined;
let active = 0;
let exiting = false;

const exitWhenIdle = () => {
  if (!stopping || active !== 0 || exiting) return;
  exiting = true;
  // Give the generated Node adapter time to flush the closed response streams.
  Effect.runFork(
    Effect.sleep("1 second").pipe(
      Effect.andThen(Effect.sync(() => process.exit(0))),
    ),
  );
};

const initialize = Effect.sync(() => {
  if (initialized) return;
  if (!process.env.FLY_MACHINE_ID)
    throw new Error("The shutdown fixture requires a deployed Fly Machine");
  initialized = true;
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () =>
      Effect.runSync(
        Effect.sync(() => {
          if (stopping) return;
          stopping = { signal, at: Date.now(), active };
          // This external application owns its deadline; the managed Fly bootstrap is absent.
          Effect.runFork(
            Effect.sleep(Number(process.env.WEBSITE_SHUTDOWN_MS) * 0.9).pipe(
              Effect.andThen(Effect.sync(() => process.exit(1))),
            ),
          );
          exitWhenIdle();
        }),
      ),
    );
  }
});

export const accepting = () => stopping === undefined;

export const respond = ({ params }: { params: { operation: string } }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* initialize;
      return yield* Effect.sync(() => {
        const identity = {
          version,
          machine: process.env.FLY_MACHINE_ID,
          managedTimeout: process.env.ALCHEMY_FLY_SHUTDOWN_TIMEOUT_MS ?? null,
        };
        if (stopping) return new Response("stopping", { status: 503 });
        if (params.operation === "ready" || params.operation === "version") {
          return Response.json(identity, {
            headers: { "cache-control": "no-store" },
          });
        }
        if (params.operation !== "slow" && params.operation !== "stream") {
          return new Response("not found", { status: 404 });
        }
        const streamed = params.operation === "stream";
        const startedAt = Date.now();
        const encoder = new TextEncoder();
        const payload = `website-${version}\n`.repeat(4096);
        const delay = Number(process.env.WEBSITE_AFTER_SIGNAL_MS);
        active++;
        let first = true;
        let finished = false;
        const complete = () => {
          if (finished) return;
          finished = true;
          active--;
          exitWhenIdle();
        };
        const body = new ReadableStream<Uint8Array>({
          pull: (controller) =>
            Effect.runPromise(
              Effect.gen(function* () {
                if (!first) yield* Effect.sleep("1 second");
                yield* Effect.sync(() => {
                  if (finished) return;
                  if (first) {
                    first = false;
                    controller.enqueue(
                      encoder.encode(
                        streamed
                          ? `${JSON.stringify({ event: "started", ...identity, payload })}\n`
                          : " \n",
                      ),
                    );
                    return;
                  }
                  const now = Date.now();
                  if (stopping && now - stopping.at >= delay) {
                    controller.enqueue(
                      encoder.encode(
                        `${JSON.stringify({
                          event: "finished",
                          ...identity,
                          startedAt,
                          signaledAt: stopping.at,
                          completedAt: now,
                          signal: stopping.signal,
                          activeAtSignal: stopping.active,
                          shutdownMs: Number(process.env.WEBSITE_SHUTDOWN_MS),
                          ...(streamed ? { payload } : {}),
                        })}\n`,
                      ),
                    );
                    controller.close();
                    complete();
                  } else {
                    // Heartbeats keep the real Fly Proxy connection alive during the next image build.
                    controller.enqueue(
                      encoder.encode(
                        streamed ? '{"event":"waiting"}\n' : " \n",
                      ),
                    );
                  }
                });
              }),
            ),
          cancel: () => Effect.runPromise(Effect.sync(complete)),
        });
        return new Response(body, {
          headers: {
            "content-type": streamed
              ? "application/x-ndjson"
              : "application/json",
            "cache-control": "no-store",
            "x-website-machine": process.env.FLY_MACHINE_ID!,
            "x-website-version": version,
          },
        });
      });
    }),
  );
