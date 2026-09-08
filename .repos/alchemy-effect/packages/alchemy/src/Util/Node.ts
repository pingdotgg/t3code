import * as Effect from "effect/Effect";
import * as NodeNet from "node:net";

/**
 * The process's working directory, captured ONCE at module load.
 *
 * Relative user paths (Vite roots, asset directories) must resolve against
 * this instead of a live `process.cwd()` read: third-party code sharing the
 * process can change the working directory transiently — most notably
 * cross-spawn, which `process.chdir`s into a spawn's `cwd` to resolve its
 * binary on PATH and then chdirs back. A live read racing that window
 * resolves against an unrelated directory. (`State/LocalState.ts` anchors
 * the state tree the same way, for the same reason.)
 */
export const initialCwd: string = process.cwd();

/**
 * Opt out of cross-spawn's temporary `process.chdir` dance.
 *
 * cross-spawn (bundled inside vite, wrangler, next, tinyexec, playwright,
 * tsx, prisma, …) resolves a spawn's binary by `process.chdir`ing the
 * WHOLE parent process into the spawn's `cwd`, calling `which.sync`, and
 * chdiring back. In an alchemy process — which runs many resource builds
 * and hashers concurrently on one event loop — every fiber that touches a
 * relative path can race that window and resolve against an unrelated
 * directory.
 *
 * `process.chdir.disabled = true` is NODE'S OWN convention: Node sets it
 * on `process.chdir` inside worker threads (where chdir is forbidden),
 * and cross-spawn checks it to skip the dance. Setting it on the main
 * thread opts us into the exact mode every cross-spawn copy already runs
 * in inside jest/vitest/playwright workers daily — not an untested path.
 * The flag is purely advisory: `process.chdir` itself keeps working, and
 * an audit of the dependency tree shows the only readers are bundled
 * cross-spawn copies; nothing else writes or consults it.
 *
 * Behavior delta: a spawn combining a custom `cwd` with a command that is
 * neither absolute nor on PATH (e.g. `./scripts/build.sh`). POSIX still
 * works (cross-spawn falls back to the raw command; the OS resolves it in
 * the child's cwd). On Windows that shape can fail to resolve — the same
 * limitation those tools already have inside worker threads. Everything
 * alchemy and its toolchains spawn is absolute or on PATH, and `Command`
 * resources use effect's ChildProcess (plain spawn, no cross-spawn).
 */
export const disableCrossSpawnChdir = (): void => {
  (process.chdir as { disabled?: boolean }).disabled = true;
};

export const isTransformTypesSupported = (
  version = process.versions.node,
): boolean => {
  const [major, minor] = version.split(".").map(Number);
  return (major === 22 && minor >= 7) || (major >= 23 && major < 26);
};

/**
 * Node CLI flags that transparently transform TypeScript types so `.ts`
 * entry points work the same way they do under Bun. Empty when the running
 * Node doesn't support (or no longer needs) the experimental flag.
 */
export const transformTypesFlags = (
  version = process.versions.node,
): string[] =>
  isTransformTypesSupported(version)
    ? ["--experimental-transform-types", "--no-warnings=ExperimentalWarning"]
    : [];

/**
 * Ask the OS for an unused TCP port, release it, and return its number.
 *
 * The port is only available, not reserved: another process can claim it
 * before the caller binds. Callers should keep the gap short and still handle
 * `EADDRINUSE`.
 */
export const findAvailablePort = (host = "127.0.0.1") =>
  Effect.callback<number, Error>((resume) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", (error) => resume(Effect.fail(error)));
    server.listen(0, host, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null
          ? address.port
          : undefined;
      server.close((error) => {
        if (error) {
          resume(Effect.fail(error));
        } else if (port !== undefined) {
          resume(Effect.succeed(port));
        } else {
          resume(
            Effect.fail(new Error("Failed to allocate an available port")),
          );
        }
      });
    });
  });
