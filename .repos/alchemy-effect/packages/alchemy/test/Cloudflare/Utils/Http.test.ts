// Pins expectUrlContains's time bounds against hostile servers: the total
// timeout must fire even when the underlying fetch never settles. A wedged
// bun fetch (keep-alive reuse against a closed connection) once pinned the
// timeout's interruption and turned a 300s assertion bound into a
// suite-timeout hang — these three shapes keep that class of bug dead.
import { expect, test } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { createServer } from "node:http";
import { expectUrlContains } from "./Http.ts";

const timed = <A, E>(eff: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const start = Date.now();
    const result = yield* Effect.result(eff);
    return { ms: Date.now() - start, ok: Result.isSuccess(result) };
  });

test(
  "total timeout fires against a connect-blackhole",
  async () =>
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { ms, ok } = yield* timed(
            expectUrlContains("https://192.0.2.1/", "nope", {
              timeout: "8 seconds",
              label: "blackhole",
            }),
          );
          expect(ok).toBe(false);
          expect(ms).toBeLessThan(25_000);
        }),
      ),
    ),
  { timeout: 60_000 },
);

test(
  "total timeout fires against an accept-but-never-respond server",
  async () =>
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Effect.acquireRelease(
            Effect.callback<ReturnType<typeof createServer>>((resume) => {
              const s = createServer(() => {
                /* accept request, never respond */
              });
              s.listen(0, "127.0.0.1", () => resume(Effect.succeed(s)));
            }),
            (s) => Effect.sync(() => void s.close()),
          );
          const port = (server.address() as { port: number }).port;
          const { ms, ok } = yield* timed(
            expectUrlContains(`http://127.0.0.1:${port}/`, "nope", {
              timeout: "8 seconds",
              label: "black-hole-response",
            }),
          );
          expect(ok).toBe(false);
          expect(ms).toBeLessThan(25_000);
        }),
      ),
    ),
  { timeout: 60_000 },
);

test(
  "total timeout fires against a fast keep-alive 502 server",
  async () =>
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* Effect.acquireRelease(
            Effect.callback<ReturnType<typeof createServer>>((resume) => {
              const s = createServer((_req, res) => {
                res.writeHead(502, {
                  "content-type": "text/html",
                  connection: "keep-alive",
                });
                res.end("<html>Bad gateway</html>");
              });
              s.listen(0, "127.0.0.1", () => resume(Effect.succeed(s)));
            }),
            (s) => Effect.sync(() => void s.close()),
          );
          const port = (server.address() as { port: number }).port;
          const { ms, ok } = yield* timed(
            expectUrlContains(`http://127.0.0.1:${port}/`, "nope", {
              timeout: "8 seconds",
              label: "fast-502",
            }),
          );
          expect(ok).toBe(false);
          expect(ms).toBeLessThan(25_000);
        }),
      ),
    ),
  { timeout: 60_000 },
);
