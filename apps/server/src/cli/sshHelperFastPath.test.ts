// @effect-diagnostics nodeBuiltinImport:off - the helpers are a plain Node filesystem and socket boundary.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { matchSshHelperFastPath, pickPort, runtimePort, waitReady } from "./sshHelperFastPath.ts";

const makeTempDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "lathe-ssh-helper-test-"));

const writeFile = (contents: string) => {
  const file = NodePath.join(makeTempDir(), "runtime.json");
  NodeFS.writeFileSync(file, contents);
  return file;
};

const servers: Array<NodeNet.Server> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

const listen = <S extends NodeNet.Server>(server: S) =>
  new Promise<number>((resolve) => {
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });

const closedPort = async () => {
  const server = NodeNet.createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
};

describe("runtimePort", () => {
  it("prints the pid and port of a live loopback server", () => {
    const file = writeFile(
      JSON.stringify({ pid: process.pid, port: 4773, origin: "http://127.0.0.1:4773" }),
    );
    expect(runtimePort(file)).toBe(`${process.pid} 4773`);
  });

  it("fails on a file that is not JSON", () => {
    expect(runtimePort(writeFile("not json"))).toBeUndefined();
  });

  it("fails on a missing file", () => {
    expect(runtimePort(NodePath.join(makeTempDir(), "absent.json"))).toBeUndefined();
  });

  it("fails when the origin is not loopback http", () => {
    const file = writeFile(
      JSON.stringify({ pid: process.pid, port: 4773, origin: "https://example.com:4773" }),
    );
    expect(runtimePort(file)).toBeUndefined();
  });
});

describe("waitReady", () => {
  it("succeeds once the loopback server answers 2xx", async () => {
    const port = await listen(
      NodeHttp.createServer((_request, response) => {
        response.writeHead(200);
        response.end("ok");
      }),
    );
    expect(await waitReady(port, 2_000, 500)).toBe("ready");
  });

  it("reports refused when nothing listens before the deadline", async () => {
    expect(await waitReady(await closedPort(), 150, 50)).toBe("refused");
  });

  it("reports not ready when a listener never answers 2xx", async () => {
    const port = await listen(
      NodeHttp.createServer((_request, response) => {
        response.writeHead(503);
        response.end();
      }),
    );
    expect(await waitReady(port, 150, 50)).toBe("not-ready");
  });
});

describe("pickPort", () => {
  it("prefers the port recorded in the port file", async () => {
    const preferred = await closedPort();
    const file = writeFile(`${preferred}\n`);
    expect(await pickPort(file, 1, 1)).toBe(preferred);
  });

  it("fails when every port in the window is taken", async () => {
    const taken = await listen(NodeNet.createServer());
    expect(await pickPort(NodePath.join(makeTempDir(), "absent"), taken, 1)).toBeUndefined();
  });
});

describe("matchSshHelperFastPath", () => {
  it("accepts the exact shapes the launch script sends", () => {
    expect(matchSshHelperFastPath(["runtime-port", "/tmp/runtime.json"])).toBeDefined();
    expect(matchSshHelperFastPath(["wait-ready", "4773", "900000", "1000"])).toBeDefined();
    expect(matchSshHelperFastPath(["pick-port", "/tmp/port", "4773", "100"])).toBeDefined();
  });

  // Anything else goes to the full CLI so its help and error output stay byte-identical.
  it("leaves every other shape to the full CLI", () => {
    for (const args of [
      [],
      ["runtime-port"],
      ["runtime-port", "/tmp/runtime.json", "extra"],
      ["runtime-port", "--help"],
      ["runtime-port", ""],
      ["wait-ready", "abc", "1", "1"],
      ["wait-ready", "4773", "-1", "1"],
      ["wait-ready", "4773", "1.5", "1"],
      ["wait-ready", "04773", "1", "1"],
      ["wait-ready", "4773", "1"],
      ["pick-port", "--", "4773", "100"],
      ["pick-port", "-p", "4773", "100"],
      ["unknown", "x"],
      ["--help"],
    ]) {
      expect(matchSshHelperFastPath(args), JSON.stringify(args)).toBeUndefined();
    }
  });
});
