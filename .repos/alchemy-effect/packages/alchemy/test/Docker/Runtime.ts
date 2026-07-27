import * as Effect from "effect/Effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

export const isDockerReady =
  NodeChildProcess.spawnSync("docker", ["info"], { stdio: "ignore" }).status ===
  0;

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
