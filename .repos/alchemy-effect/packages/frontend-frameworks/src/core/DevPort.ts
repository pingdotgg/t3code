import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";
import { FrameworkError } from "./Framework.ts";

/**
 * Whether the given Vite version treats `server.port: 0` as a true
 * OS-assigned random port (vitejs/vite#23158, shipped in Vite 8.2.1).
 * Older Vite treats `0` as "no port given" and hunts upward from its 5173
 * default.
 *
 * Framework core is deliberately platform-neutral (see the decoupling
 * test), so this is a local definition — keep in sync with the copy in
 * `@alchemy.run/cloudflare-runtime`'s `core/internal/Port.ts`, which
 * serves that package's own Vite plugin consumers.
 */
export const viteSupportsPortZero = (
  version: string | null | undefined,
): boolean => {
  if (typeof version !== "string") return false;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (
    major > 8 || (major === 8 && (minor > 2 || (minor === 2 && patch >= 1)))
  );
};

/**
 * Resolve the port a Vite-based framework dev server should bind.
 *
 * - An explicitly configured port wins.
 * - On Vite >= 8.2.1 (vitejs/vite#23158) `port: 0` is a true OS-assigned
 *   random port — race-free at bind — so it is preferred whenever the
 *   loaded Vite's `version` export says it's supported. Callers drive the
 *   PROJECT's Vite install, so this is a runtime check, not a dependency
 *   floor.
 * - Older Vite treats `0` as "no port given" and hunts upward from its
 *   well-known default (5173, or the framework's own — 4321 for Astro) —
 *   exactly where users configure their `alchemy dev` proxy ports, so a
 *   hunting dev server can land on (or IPv6-shadow) a port the user is
 *   browsing. Fall back to {@link findEphemeralPort} there.
 *
 * TODO(vite>=8.2.1): delete the fallback (and `findEphemeralPort`) once
 * the supported Vite floor reaches 8.2.1 in user projects. Nuxt's chain
 * (nitro → listhen → get-port-please) already accepts `port: 0` — though
 * it performs the same probe-and-release internally (`getRandomPort`).
 * Next.js owns its listener and truly `listen(0)`s.
 */
export const resolveViteDevPort = (
  viteVersion: string | null | undefined,
  explicitPort?: number | undefined,
): Effect.Effect<number, FrameworkError> =>
  explicitPort
    ? Effect.succeed(explicitPort)
    : viteSupportsPortZero(viteVersion)
      ? Effect.succeed(0)
      : findEphemeralPort();

/**
 * Allocate a concrete ephemeral port for a framework dev server whose
 * listener cannot take `port: 0` (see {@link resolveViteDevPort}).
 *
 * This is deliberately a hint, not a claim: the probe→listen window is a
 * TOCTOU race, so every caller passes the port with non-strict semantics
 * (on a genuine collision the framework moves to the next port, still in
 * the ephemeral range) and wires the proxy to the URL the framework
 * REPORTS after binding, never to the probed number — a lost race can
 * shift a dev server by one port; it cannot serve the wrong app.
 */
export const findEphemeralPort = (
  host = "127.0.0.1",
): Effect.Effect<number, FrameworkError> =>
  Effect.callback<number, FrameworkError>((resume) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", (error) =>
      resume(
        Effect.fail(
          new FrameworkError({
            message: "Failed to allocate an ephemeral dev-server port",
            cause: error,
          }),
        ),
      ),
    );
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null
          ? address.port
          : undefined;
      server.close(() => {
        if (port !== undefined) {
          resume(Effect.succeed(port));
        } else {
          resume(
            Effect.fail(
              new FrameworkError({
                message: "Failed to allocate an ephemeral dev-server port",
              }),
            ),
          );
        }
      });
    });
    return Effect.sync(() => server.close());
  });
