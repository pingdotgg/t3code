import { $ } from "bun";
import * as net from "net";

const isLocal = !!process.env.LOCAL;

if (isLocal) {
  await $`rm -rf .alchemy`.quiet();

  // Start localstack in detached mode (quiet - no stdout/stderr)
  await $`pkill localstack || true`.quiet();
  await $`localstack start -d`.quiet();

  // Wait for localstack port 4566 to be open before proceeding
  while (true) {
    // INSERT_YOUR_CODE
    // Try to connect with node to 127.0.0.1:$1 until successful.
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect({ port: 4566, host: "127.0.0.1" }, () => {
          socket.end();
          resolve(true);
        });
        socket.on("error", () => {
          reject(new Error("Failed to connect to localstack"));
        });
      });
      break;
    } catch {}
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

let exitCode = 1;

try {
  // Run tests with inherited stdout/stderr, passing through all args
  const args = process.argv.slice(2);
  const proc = Bun.spawn(["bun", "vitest", "run", ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
    cwd: process.cwd(),
  });

  // Wait for the process to complete
  exitCode = await proc.exited;
} finally {
  if (isLocal) {
    // Stop localstack as cleanup
    await $`localstack stop`.quiet();
  }
}

process.exit(exitCode);
