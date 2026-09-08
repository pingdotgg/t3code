import { describe, expect, it } from "@effect/vitest";
import * as NodeFs from "node:fs";
import * as NodeNet from "node:net";
import {
  closeLoopbackUnixSockets,
  CONTAINER_LOOPBACK_ALIAS,
  CONTAINER_LOOPBACK_MOUNT,
  ensureLoopbackUnixSockets,
  loopbackPortsFromEnv,
  loopbackPortsFromEnvValue,
  loopbackSocketDir,
  mergeSidecarLoopbackHostConfig,
  sidecarLoopbackBinds,
  sidecarLoopbackExtraHost,
  usesUnixSocketLoopback,
} from "../DockerLoopback.ts";

describe("DockerLoopback", () => {
  it("keeps the alias localhost-looking (Prisma's http/https gate)", () => {
    expect(CONTAINER_LOOPBACK_ALIAS).toContain("localhost");
  });

  it("extracts ports from URL, DSN, and prisma+postgres shapes", () => {
    expect(
      loopbackPortsFromEnvValue("postgres://postgres@127.0.0.1:5432/db"),
    ).toEqual([5432]);
    expect(
      loopbackPortsFromEnvValue(
        "prisma+postgres://localhost:51216/?api_key=test",
      ),
    ).toEqual([51216]);
    expect(
      loopbackPortsFromEnvValue("http://host.docker.localhost:42117/hello"),
    ).toEqual([42117]);
    expect(
      loopbackPortsFromEnvValue("host=127.0.0.1 port=5432 sslmode=disable"),
    ).toEqual([5432]);
  });

  it("does not extract ports from Neon or PlanetScale URLs", () => {
    expect(
      loopbackPortsFromEnvValue(
        "postgres://neondb_owner:secret@ep-cool-name.us-east-1.aws.neon.tech/neondb?sslmode=require",
      ),
    ).toEqual([]);
    expect(
      loopbackPortsFromEnvValue(
        "postgresql://user:secret@xxxx.pg.psdb.cloud:6432/postgres?sslmode=verify-full",
      ),
    ).toEqual([]);
  });

  it("unions ports across a container env map", () => {
    expect(
      loopbackPortsFromEnv({
        DATABASE_URL: "postgres://postgres@127.0.0.1:5432/db",
        PPG_URL: "prisma+postgres://localhost:51216/?api_key=test",
        NEON_URL:
          "postgres://x@ep-cool-name.us-east-1.aws.neon.tech/neondb?sslmode=require",
      }).sort((a, b) => a - b),
    ).toEqual([5432, 51216]);
  });

  it("maps ExtraHosts to 127.0.0.1 on Linux and host-gateway elsewhere", () => {
    const extra = sidecarLoopbackExtraHost();
    if (usesUnixSocketLoopback()) {
      expect(extra).toBe(`${CONTAINER_LOOPBACK_ALIAS}:127.0.0.1`);
      expect(sidecarLoopbackBinds([5432])).toEqual([
        `${loopbackSocketDir()}:${CONTAINER_LOOPBACK_MOUNT}`,
      ]);
    } else {
      expect(extra).toBe(`${CONTAINER_LOOPBACK_ALIAS}:host-gateway`);
      expect(sidecarLoopbackBinds([5432])).toEqual([]);
    }
  });

  it("merges sidecar HostConfig without duplicating ExtraHosts", () => {
    const extra = sidecarLoopbackExtraHost();
    const once = mergeSidecarLoopbackHostConfig(
      { ExtraHosts: ["host.docker.internal:host-gateway"] },
      [5432],
    );
    expect(once.ExtraHosts).toContain(extra);
    expect(once.ExtraHosts).toContain("host.docker.internal:host-gateway");
    const twice = mergeSidecarLoopbackHostConfig(once, [5432]);
    expect(twice.ExtraHosts.filter((h) => h === extra)).toHaveLength(1);
  });

  it.skipIf(!usesUnixSocketLoopback())(
    "unix-socket forwards to a 127.0.0.1 listener without binding the bridge",
    async () => {
      const server = NodeNet.createServer((socket) => {
        socket.write("pong");
        socket.end();
      });
      const port = await new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("expected tcp address"));
            return;
          }
          resolve(address.port);
        });
      });
      try {
        ensureLoopbackUnixSockets([port]);
        const sock = `${loopbackSocketDir()}/${port}.sock`;
        expect(NodeFs.existsSync(sock)).toBe(true);
        const data = await new Promise<string>((resolve, reject) => {
          const client = NodeNet.connect(sock);
          client.setEncoding("utf8");
          let body = "";
          client.on("data", (chunk) => {
            body += chunk;
          });
          client.on("end", () => resolve(body));
          client.on("error", reject);
        });
        expect(data).toBe("pong");
      } finally {
        closeLoopbackUnixSockets();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
});
