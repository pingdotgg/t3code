import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

const swarmLocalNodeState = (): string | undefined => {
  const result = NodeChildProcess.spawnSync(
    "docker",
    ["info", "--format", "{{.Swarm.LocalNodeState}}"],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  return result.status === 0 ? String(result.stdout).trim() : undefined;
};

/**
 * Idempotently provision the local single-node swarm the `Docker.Service`
 * tests deploy to. A single-node manager on the local engine is harmless —
 * regular (non-swarm) docker usage is unaffected — and stays active across
 * runs so repeated invocations are a no-op. Deactivate manually with
 * `docker swarm leave --force`.
 *
 * Concurrent test files race the init; the loser's "already part of a swarm"
 * error is folded into success by re-checking the node state.
 */
export const ensureDockerSwarm: Effect.Effect<void, Error> = Effect.suspend(
  () => {
    if (swarmLocalNodeState() === "active") return Effect.void;
    const init = NodeChildProcess.spawnSync(
      "docker",
      // 127.0.0.1 keeps init deterministic on hosts with several network
      // interfaces (init otherwise refuses to pick an advertise address).
      ["swarm", "init", "--advertise-addr", "127.0.0.1"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    if (init.status === 0 || swarmLocalNodeState() === "active") {
      return Effect.void;
    }
    return Effect.fail(
      new Error(`docker swarm init failed: ${String(init.stderr).trim()}`),
    );
  },
);

export const findAvailablePort = () =>
  Effect.callback<number, Error>((resume) => {
    const server = NodeNet.createServer();
    server.unref();
    server.on("error", (error) => resume(Effect.fail(error)));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : undefined;
      server.close((error) => {
        if (error) {
          resume(Effect.fail(error));
        } else if (port) {
          resume(Effect.succeed(port));
        } else {
          resume(Effect.fail(new Error("Failed to allocate a free host port")));
        }
      });
    });
  });
