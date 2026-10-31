// @effect-diagnostics nodeBuiltinImport:off - the tests run real servers to see how fetch connects.
import * as NodeHttp from "node:http";
import * as NodeHttp2 from "node:http2";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Undici from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vite-plus/test";

import {
  builtinFetchUsesHttp2,
  configureOutboundFetch,
  ignoreMacosTypeOfServiceEinval,
  installHttp1FetchDispatcher,
} from "./outboundHttp.ts";

// Non-secret, self-signed 127.0.0.1 certificate, valid until 2126; ALPN h2 requires TLS.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3EwCztQysKTvzdcR
g0LWq+axzUd4tHi9PyMdqh7PlGShRANCAARfQpoLgv/tOsHWCLriDza7Ruaey2b7
mR/nS6mLu6W7+agkEqDm0mE3F/ngpPjL4Jj0IGadeMcKNKFRSBgiLdfn
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBsDCCAVagAwIBAgIUWbn2Wt5kTxii1UU57NJMt/wTaUgwCgYIKoZIzj0EAwIw
JDEiMCAGA1UEAwwZdDNjb2RlIG91dGJvdW5kIGh0dHAgdGVzdDAgFw0yNjEwMTEy
MjQyMzZaGA8yMTI2MDkxNzIyNDIzNlowJDEiMCAGA1UEAwwZdDNjb2RlIG91dGJv
dW5kIGh0dHAgdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABF9CmguC/+06
wdYIuuIPNrtG5p7LZvuZH+dLqYu7pbv5qCQSoObSYTcX+eCk+MvgmPQgZp14xwo0
oVFIGCIt1+ejZDBiMB0GA1UdDgQWBBSsekAc30Q/zdIE/tvVDQKJL5oiCDAfBgNV
HSMEGDAWgBSsekAc30Q/zdIE/tvVDQKJL5oiCDAPBgNVHRMBAf8EBTADAQH/MA8G
A1UdEQQIMAaHBH8AAAEwCgYIKoZIzj0EAwIDSAAwRQIgebUrkyP56242EJB7nCV7
A+Ke/q0rNPya3fjQa9O5B+kCIQC1SfmdNaFcNJ4JINlus4FfrRnfKiADS2MIJR9f
99BN0A==
-----END CERTIFICATE-----
`;

const server = NodeHttp2.createSecureServer(
  { allowHTTP1: true, key: TEST_KEY, cert: TEST_CERT },
  (request, response) => response.end(request.httpVersion),
);
const target = NodeHttp.createServer((_request, response) => response.end("direct"));
const ipv6Target = NodeHttp.createServer((_request, response) => response.end("direct"));
const proxy = NodeHttp.createServer((_request, response) => response.end("proxied"));
// Records each CONNECT authority it is asked for, then refuses the tunnel.
const tunnelledAuthorities: Array<string> = [];
proxy.on("connect", (request, clientSocket: NodeNet.Socket) => {
  tunnelledAuthorities.push(request.url ?? "");
  clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
});
let origin = "";
let targetOrigin = "";
let proxyOrigin = "";
let ipv6TargetOrigin = "";
const defaultCaCertificates = NodeTls.getCACertificates("default");
const defaultDispatcher = Undici.getGlobalDispatcher();
const defaultAttemptTimeout = NodeNet.getDefaultAutoSelectFamilyAttemptTimeout();

beforeAll(async () => {
  NodeTls.setDefaultCACertificates([...defaultCaCertificates, TEST_CERT]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`;
  targetOrigin = await listenOnLoopback(target);
  proxyOrigin = await listenOnLoopback(proxy);
  ipv6TargetOrigin = await listenOnLoopback(ipv6Target, "::1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  Undici.setGlobalDispatcher(defaultDispatcher);
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(defaultAttemptTimeout);
});

afterAll(async () => {
  NodeTls.setDefaultCACertificates(defaultCaCertificates);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const httpServer of [target, proxy, ipv6Target]) {
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

async function listenOnLoopback(httpServer: NodeHttp.Server, host = "127.0.0.1") {
  await new Promise<void>((resolve) => httpServer.listen(0, host, resolve));
  return `http://${host.includes(":") ? `[${host}]` : host}:${(httpServer.address() as NodeNet.AddressInfo).port}/`;
}

const clearProxyEnvironment = () => {
  for (const name of [
    "HTTPS_PROXY",
    "https_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "NO_PROXY",
    "no_proxy",
    "NODE_USE_ENV_PROXY",
  ]) {
    vi.stubEnv(name, undefined);
  }
};

// Proxy variables in the developer's shell would otherwise reach every dispatcher test.
beforeEach(() => clearProxyEnvironment());

const versionViaGlobalDispatcher = async () => (await Undici.request(origin)).body.text();

const textViaBuiltinFetch = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) => response.text),
    Effect.provide(FetchHttpClient.layer),
  );

describe("installHttp1FetchDispatcher", () => {
  it("makes the global dispatcher negotiate HTTP/1.1 and keeps the env proxy agent", async () => {
    Undici.setGlobalDispatcher(new Undici.Agent());
    expect(await versionViaGlobalDispatcher()).toBe("2.0");

    installHttp1FetchDispatcher();
    expect(await versionViaGlobalDispatcher()).toBe("1.1");

    Undici.setGlobalDispatcher(new Undici.EnvHttpProxyAgent());
    installHttp1FetchDispatcher();
    expect(Undici.getGlobalDispatcher()).toBeInstanceOf(Undici.EnvHttpProxyAgent);
  });

  // Only bundled undici 8 (Node 26+) offers fetch h2 and can prove dispatcher replacement.
  it.effect.runIf(builtinFetchUsesHttp2(process.versions.undici))(
    "moves the built-in fetch off HTTP/2",
    () =>
      Effect.gen(function* () {
        expect(yield* textViaBuiltinFetch(origin)).toBe("2.0");
        installHttp1FetchDispatcher();
        expect(yield* textViaBuiltinFetch(origin)).toBe("1.1");
      }),
  );
});

describe("configureOutboundFetch", () => {
  it.effect("sends an HTTPS request to HTTPS_PROXY as a CONNECT", () =>
    Effect.gen(function* () {
      vi.stubEnv("HTTPS_PROXY", proxyOrigin);
      tunnelledAuthorities.length = 0;
      configureOutboundFetch();
      yield* Effect.exit(textViaBuiltinFetch("https://t3-proxy-test.invalid/"));
      expect(tunnelledAuthorities).toEqual(["t3-proxy-test.invalid:443"]);
    }),
  );

  it.effect("preserves lowercase no_proxy precedence", () =>
    Effect.gen(function* () {
      vi.stubEnv("HTTPS_PROXY", proxyOrigin);
      vi.stubEnv("NO_PROXY", "other.invalid");
      vi.stubEnv("no_proxy", "t3-proxy-test.invalid");
      tunnelledAuthorities.length = 0;
      configureOutboundFetch();
      yield* Effect.exit(textViaBuiltinFetch("https://t3-proxy-test.invalid/"));
      expect(tunnelledAuthorities).toEqual([]);
    }),
  );

  it.effect("reaches loopback directly even when NO_PROXY does not list it", () =>
    Effect.gen(function* () {
      vi.stubEnv("HTTP_PROXY", proxyOrigin);
      configureOutboundFetch();
      expect(yield* textViaBuiltinFetch(targetOrigin)).toBe("direct");
      expect(yield* textViaBuiltinFetch(ipv6TargetOrigin)).toBe("direct");
    }),
  );
});

const runNode = Effect.fnUntraced(function* (args: Array<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(ChildProcess.make(process.execPath, args));
  return yield* Effect.all(
    {
      stdout: child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      stderr: child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      exitCode: child.exitCode.pipe(Effect.map(Number)),
    },
    { concurrency: "unbounded" },
  );
}, Effect.scoped);

describe("ignoreMacosTypeOfServiceEinval", () => {
  const errnoError = (code: string) =>
    Object.assign(new Error(`setTypeOfService ${code}`), { code, syscall: "setTypeOfService" });

  it("swallows only an Error with code EINVAL on macOS", () => {
    let error: unknown = errnoError("EINVAL");
    const prototype = {
      setTypeOfService(this: NodeNet.Socket, _typeOfService: number): NodeNet.Socket {
        throw error;
      },
    };
    ignoreMacosTypeOfServiceEinval("darwin", prototype);

    const socket = new NodeNet.Socket();
    expect(prototype.setTypeOfService.call(socket, 0)).toBe(socket);

    error = errnoError("EPERM");
    expect(() => prototype.setTypeOfService.call(socket, 0)).toThrow(error);

    error = { code: "EINVAL" };
    expect(() => prototype.setTypeOfService.call(socket, 0)).toThrow();
  });

  // Bundled undici 7 calls this API from a socket callback. Keep the real fetch
  // in a child so an escaped EINVAL exits that process instead of breaking Vitest.
  it.effect.runIf(
    typeof (NodeNet.Socket.prototype as { setTypeOfService?: unknown }).setTypeOfService ===
      "function" && process.versions.undici?.startsWith("7.") === true,
  )("keeps built-in fetch working when setTypeOfService throws EINVAL", () =>
    Effect.gen(function* () {
      const child = yield* runNode([
        "--input-type=module",
        "--eval",
        `
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import { ignoreMacosTypeOfServiceEinval } from ${JSON.stringify(new URL("./outboundHttp.ts", import.meta.url).href)};

NodeTls.setDefaultCACertificates([${JSON.stringify(TEST_CERT)}]);
let calls = 0;
NodeNet.Socket.prototype.setTypeOfService = () => {
  calls++;
  throw Object.assign(new Error("setTypeOfService EINVAL"), { code: "EINVAL" });
};
ignoreMacosTypeOfServiceEinval("darwin");
console.log(await (await fetch(${JSON.stringify(origin)})).text());
if (calls === 0) throw new Error("fetch did not call setTypeOfService");
`,
      ]);
      expect(child.exitCode, child.stderr).toBe(0);
      expect(child.stdout.trim()).toBe("1.1");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
