import { access } from "node:fs/promises";
import net from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const defaultTcpHosts = ["127.0.0.1", "localhost", "::1"];

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function tcpPortIsReady({ host, port, connectTimeoutMs = 500 }) {
  return new Promise((resolveReady) => {
    const socket = net.createConnection({ host, port });

    const finish = (ready) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveReady(ready);
    };

    socket.once("connect", () => {
      finish(true);
    });
    socket.once("timeout", () => {
      finish(false);
    });
    socket.once("error", () => {
      finish(false);
    });
    socket.setTimeout(connectTimeoutMs);
  });
}

async function resolvePendingResources({ baseDir, files, tcpPort, tcpHosts, connectTimeoutMs }) {
  const pendingFiles = [];

  for (const relativeFilePath of files) {
    const ready = await fileExists(resolve(baseDir, relativeFilePath));
    if (!ready) {
      pendingFiles.push(relativeFilePath);
    }
  }

  let tcpReady = false;
  for (const host of tcpHosts) {
    tcpReady = await tcpPortIsReady({
      host,
      port: tcpPort,
      connectTimeoutMs,
    });
    if (tcpReady) {
      break;
    }
  }

  return {
    pendingFiles,
    tcpReady,
  };
}

export async function waitForResources({
  baseDir,
  files = [],
  intervalMs = 100,
  timeoutMs = 120_000,
  tcpHost,
  tcpPort,
  connectTimeoutMs = 500,
}) {
  const startedAt = Date.now();
  const tcpHosts = tcpHost ? [tcpHost] : defaultTcpHosts;

  while (true) {
    const { pendingFiles, tcpReady } = await resolvePendingResources({
      baseDir,
      files,
      tcpPort,
      tcpHosts,
      connectTimeoutMs,
    });

    if (pendingFiles.length === 0 && tcpReady) {
      return;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      const pendingResources = [];
      if (!tcpReady) {
        pendingResources.push(tcpHost ? `tcp:${tcpHost}:${tcpPort}` : `tcp:${tcpPort}`);
      }
      for (const filePath of pendingFiles) {
        pendingResources.push(`file:${filePath}`);
      }

      throw new Error(
        `Timed out waiting for desktop dev resources after ${timeoutMs}ms: ${pendingResources.join(", ")}`,
      );
    }

    await delay(intervalMs);
  }
}
