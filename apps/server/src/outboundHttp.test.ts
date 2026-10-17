// @effect-diagnostics nodeBuiltinImport:off - the test runs a real TLS h2 server to see which protocol fetch negotiates.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp2 from "node:http2";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";

import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import * as Undici from "undici";
import { afterAll, afterEach, beforeAll, describe, expect } from "vite-plus/test";

import {
  builtinFetchUsesHttp2,
  ignoreMacosTypeOfServiceEinval,
  installHttp1FetchDispatcher,
} from "./outboundHttp.ts";

// Test-only self-signed P-256 certificate for 127.0.0.1, valid until 2126; not a
// secret. Node cannot mint X.509 certificates without a library, and a local
// server only offers h2 over ALPN, which needs TLS.
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
let origin = "";
const defaultCaCertificates = NodeTls.getCACertificates("default");
const defaultDispatcher = Undici.getGlobalDispatcher();

beforeAll(async () => {
  NodeTls.setDefaultCACertificates([...defaultCaCertificates, TEST_CERT]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `https://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`;
});

afterEach(() => {
  Undici.setGlobalDispatcher(defaultDispatcher);
});

afterAll(async () => {
  NodeTls.setDefaultCACertificates(defaultCaCertificates);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const versionViaGlobalDispatcher = async () => (await Undici.request(origin)).body.text();

const versionViaBuiltinFetch = () =>
  HttpClient.get(origin).pipe(
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

  // Only a runtime that bundles undici 8 (Node 26+) offers h2 through the
  // built-in fetch, so only there can this prove fetch reads the new dispatcher.
  it.effect.runIf(builtinFetchUsesHttp2(process.versions.undici))(
    "moves the built-in fetch off HTTP/2",
    () =>
      Effect.gen(function* () {
        expect(yield* versionViaBuiltinFetch()).toBe("2.0");
        installHttp1FetchDispatcher();
        expect(yield* versionViaBuiltinFetch()).toBe("1.1");
      }),
  );
});

describe("ignoreMacosTypeOfServiceEinval", () => {
  const errnoError = (code: string) =>
    Object.assign(new Error(`setTypeOfService ${code}`), { code, syscall: "setTypeOfService" });
  const failingPrototype = (error: Error) => ({
    setTypeOfService(this: NodeNet.Socket, _typeOfService: number): NodeNet.Socket {
      throw error;
    },
  });

  it("returns the socket when macOS rejects the type of service with EINVAL", () => {
    const prototype = failingPrototype(errnoError("EINVAL"));
    ignoreMacosTypeOfServiceEinval("darwin", prototype);

    const socket = new NodeNet.Socket();
    expect(prototype.setTypeOfService.call(socket, 0)).toBe(socket);
  });

  it("rethrows every other error", () => {
    const permissionDenied = errnoError("EPERM");
    const prototype = failingPrototype(permissionDenied);
    ignoreMacosTypeOfServiceEinval("darwin", prototype);

    expect(() => prototype.setTypeOfService.call(new NodeNet.Socket(), 0)).toThrow(
      permissionDenied,
    );
  });

  it("changes nothing off macOS or on a runtime without setTypeOfService", () => {
    const prototype = failingPrototype(errnoError("EINVAL"));
    const original = prototype.setTypeOfService;
    ignoreMacosTypeOfServiceEinval("linux", prototype);
    ignoreMacosTypeOfServiceEinval("win32", prototype);
    expect(prototype.setTypeOfService).toBe(original);

    const withoutTypeOfService = {};
    ignoreMacosTypeOfServiceEinval("darwin", withoutTypeOfService);
    expect(withoutTypeOfService).not.toHaveProperty("setTypeOfService");
  });

  // Node 24.15 added setTypeOfService, and the undici 7 it bundles calls it on
  // every HTTP/1.1 request; undici 8 skips the call by default. A stub that
  // always throws EINVAL makes the macOS failure deterministic on any platform.
  // An escaped EINVAL leaves the request hanging, so a short timeout fails fast.
  it.effect.runIf(
    typeof (NodeNet.Socket.prototype as { setTypeOfService?: unknown }).setTypeOfService ===
      "function" && process.versions.undici?.startsWith("7.") === true,
  )(
    "keeps built-in fetch working when setTypeOfService throws EINVAL",
    () => {
      const socketPrototype = NodeNet.Socket.prototype as NodeNet.Socket & {
        setTypeOfService?: unknown;
      };
      const original = socketPrototype.setTypeOfService;
      let calls = 0;
      socketPrototype.setTypeOfService = () => {
        calls++;
        throw errnoError("EINVAL");
      };
      const uncaught: Array<unknown> = [];
      const recordUncaught = (error: unknown) => uncaught.push(error);
      process.on("uncaughtExceptionMonitor", recordUncaught);
      return Effect.gen(function* () {
        ignoreMacosTypeOfServiceEinval("darwin");
        expect(yield* versionViaBuiltinFetch()).toBe("1.1");
        expect(calls).toBeGreaterThan(0);
        expect(uncaught).toEqual([]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            process.off("uncaughtExceptionMonitor", recordUncaught);
            socketPrototype.setTypeOfService = original;
          }),
        ),
      );
    },
    10_000,
  );

  // The reset has to come from another process, as it does from the Adobe,
  // Unity and workerd listeners in the reports. A listener in this process
  // accepts on the client's event loop, so the request is written first.
  it.effect.runIf(HostProcess.Platform.defaultValue() === "darwin")(
    "keeps requests to a listener that resets connections from crashing the process",
    () => {
      const listener = NodeChildProcess.spawn(
        process.execPath,
        [
          "-e",
          'const server = require("node:net").createServer((socket) => socket.resetAndDestroy()); server.listen(0, "127.0.0.1", () => console.log(server.address().port));',
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      const socketPrototype = NodeNet.Socket.prototype as NodeNet.Socket & {
        setTypeOfService?: unknown;
      };
      const original = socketPrototype.setTypeOfService;
      // Vitest catches what would exit the server, so record it to assert on.
      const uncaught: Array<unknown> = [];
      const recordUncaught = (error: unknown) => uncaught.push(error);
      process.on("uncaughtExceptionMonitor", recordUncaught);
      return Effect.gen(function* () {
        const port = yield* Effect.promise(
          () =>
            new Promise<string>((resolve, reject) => {
              const fail = (reason: string) => {
                clearTimeout(startup);
                reject(new Error(`resetting listener ${reason} before printing its port`));
              };
              // @effect-diagnostics-next-line globalTimers:off -- Bounds listener startup, which takes milliseconds when it works.
              const startup = setTimeout(() => fail("took over 5 s"), 5_000);
              listener.once("error", (error) =>
                fail(`failed to start (${"code" in error ? String(error.code) : error.name})`),
              );
              listener.once("exit", (code, signal) =>
                fail(`exited (code ${code}, signal ${signal})`),
              );
              listener.stdout.once("data", (chunk) => {
                clearTimeout(startup);
                resolve(String(chunk).trim());
              });
            }),
        );
        ignoreMacosTypeOfServiceEinval();
        for (let attempt = 0; attempt < 20; attempt++) {
          const error = yield* HttpClient.get(`http://127.0.0.1:${port}/`).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.flip,
          );
          expect(error.reason._tag).toBe("TransportError");
        }
        expect(uncaught).toEqual([]);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            process.off("uncaughtExceptionMonitor", recordUncaught);
            socketPrototype.setTypeOfService = original;
            listener.kill();
          }),
        ),
      );
    },
  );
});
