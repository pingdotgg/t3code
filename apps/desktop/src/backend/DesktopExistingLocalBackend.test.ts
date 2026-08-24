import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  collectSeedBaseDirs,
  discoverExistingLocalBackend,
  pairExistingLocalBackend,
  parseLaunchdT3Home,
  parseSystemdT3Home,
} from "./DesktopExistingLocalBackend.ts";

const runtimeFileSystem = (runtimeState: string) =>
  FileSystem.makeNoop({
    readDirectory: () => Effect.succeed([]),
    readFileString: (path) =>
      Effect.succeed(path.endsWith("server-runtime.json") ? runtimeState : ""),
  });

describe("parseSystemdT3Home", () => {
  it("reads a simple Environment assignment", () => {
    assert.equal(
      parseSystemdT3Home("Environment=T3CODE_HOME=/home/pedro/.t3/codebox2\n"),
      "/home/pedro/.t3/codebox2",
    );
  });

  it("reads quoted Environment assignments and drop-in overlays", () => {
    assert.equal(parseSystemdT3Home('Environment="T3CODE_HOME=/data/t3 home"\n'), "/data/t3 home");
    assert.equal(
      parseSystemdT3Home("Environment=T3CODE_HOST=0.0.0.0 T3CODE_HOME=/opt/t3 T3CODE_PORT=4100\n"),
      "/opt/t3",
    );
  });

  it("decodes escaping emitted by the systemd service renderer", () => {
    assert.equal(parseSystemdT3Home("Environment=T3CODE_HOME=/srv/t3%%data\n"), "/srv/t3%data");
    assert.equal(
      parseSystemdT3Home('Environment=T3CODE_HOME="/srv/t3%% data\\\\slot\\"quoted"\n'),
      '/srv/t3% data\\slot"quoted',
    );
  });

  it("matches only complete T3CODE_HOME assignment names", () => {
    assert.equal(
      parseSystemdT3Home("Environment=OLD_T3CODE_HOME=/wrong T3CODE_HOME=/srv/t3\n"),
      "/srv/t3",
    );
    assert.equal(parseSystemdT3Home("Environment=OLD_T3CODE_HOME=/wrong\n"), null);
  });

  it("stops at the end of a quoted assignment in an assignment list", () => {
    assert.equal(
      parseSystemdT3Home('Environment="T3CODE_HOME=/srv/t3" "OTHER=value"\n'),
      "/srv/t3",
    );
  });

  it("uses the last assignment so systemd drop-ins override the base unit", () => {
    assert.equal(
      parseSystemdT3Home(
        "Environment=T3CODE_HOME=/home/tester/.t3\nEnvironment=T3CODE_HOME=/srv/t3\n",
      ),
      "/srv/t3",
    );
  });

  it("returns null when T3CODE_HOME is absent", () => {
    assert.equal(parseSystemdT3Home("Environment=T3CODE_PORT=4100\n"), null);
    assert.equal(parseSystemdT3Home(""), null);
  });
});

describe("parseLaunchdT3Home", () => {
  it("reads and decodes the service home from EnvironmentVariables", () => {
    assert.equal(
      parseLaunchdT3Home(`
        <plist><dict>
          <key>EnvironmentVariables</key>
          <dict>
            <key>T3CODE_HOME</key>
            <string>/Users/tester/T3 &amp; Code</string>
          </dict>
        </dict></plist>
      `),
      "/Users/tester/T3 & Code",
    );
  });

  it("does not confuse keys outside EnvironmentVariables for the service home", () => {
    assert.equal(
      parseLaunchdT3Home(
        "<plist><dict><key>T3CODE_HOME</key><string>/tmp/wrong</string></dict></plist>",
      ),
      null,
    );
  });
});

describe("collectSeedBaseDirs", () => {
  it("prefers the installed service, then ~/.t3, then the desktop home", () => {
    assert.deepEqual(
      collectSeedBaseDirs({
        defaultBaseDir: "/home/pedro/.t3",
        desktopBaseDir: "/home/pedro/.t3/desktop",
        serviceT3Home: "/home/pedro/.t3/codebox2",
      }),
      ["/home/pedro/.t3/codebox2", "/home/pedro/.t3", "/home/pedro/.t3/desktop"],
    );
  });

  it("deduplicates identical paths", () => {
    assert.deepEqual(
      collectSeedBaseDirs({
        defaultBaseDir: "/home/pedro/.t3",
        desktopBaseDir: "/home/pedro/.t3",
        serviceT3Home: "/home/pedro/.t3",
      }),
      ["/home/pedro/.t3"],
    );
  });
});

describe("discoverExistingLocalBackend", () => {
  it.effect("discovers a macOS background service with a custom T3 home first", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const serviceHome = "/Volumes/Work/T3 service";
      const fileSystem = FileSystem.makeNoop({
        readDirectory: () => Effect.succeed([]),
        readFileString: (filePath) => {
          if (filePath.endsWith("com.t3tools.t3code.service.plist")) {
            return Effect.succeed(`
              <plist><dict><key>EnvironmentVariables</key><dict>
                <key>T3CODE_HOME</key><string>${serviceHome}</string>
              </dict></dict></plist>
            `);
          }
          if (filePath === `${serviceHome}/userdata/server-runtime.json`) {
            return Effect.succeed(
              `{"version":1,"pid":${String(process.pid)},"port":41773,"origin":"http://127.0.0.1:41773","startedAt":"2026-08-21T00:00:00.000Z"}`,
            );
          }
          return Effect.succeed("");
        },
      });
      const httpClient = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              environmentId: "service-environment",
              label: "Background service",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "0.0.1",
              capabilities: { repositoryIdentity: true },
            }),
          ),
        ),
      );

      const found = yield* discoverExistingLocalBackend({
        homeDirectory: "/Users/tester",
        desktopBaseDir: "/Users/tester/.t3",
        platform: "darwin",
        path,
        fileSystem,
        httpClient,
      });

      assert.equal(Option.getOrThrow(found).baseDir, serviceHome);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores a malformed persisted origin without probing HTTP", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      let requestCount = 0;
      const httpClient = HttpClient.make(() =>
        Effect.sync(() => {
          requestCount += 1;
          throw new Error("unexpected HTTP request");
        }),
      );
      const found = yield* discoverExistingLocalBackend({
        homeDirectory: "/home/tester",
        desktopBaseDir: "/home/tester/.t3/desktop",
        platform: "linux",
        path,
        fileSystem: runtimeFileSystem(
          `{"version":1,"pid":${String(process.pid)},"port":3773,"origin":"not a URL","startedAt":"2026-08-21T00:00:00.000Z"}`,
        ),
        httpClient,
      });

      assert.isTrue(Option.isNone(found));
      assert.equal(requestCount, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses the persisted backend origin and ignores a development renderer URL", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const requestedUrls: string[] = [];
      const httpClient = HttpClient.make((request) =>
        Effect.sync(() => {
          requestedUrls.push(request.url);
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              {
                environmentId: "existing-test-environment",
                label: "Existing test backend",
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.1",
                capabilities: { repositoryIdentity: true },
              },
              { status: 200 },
            ),
          );
        }),
      );
      const found = yield* discoverExistingLocalBackend({
        homeDirectory: "/home/tester",
        desktopBaseDir: "/home/tester/.t3/desktop",
        platform: "linux",
        path,
        fileSystem: runtimeFileSystem(
          `{"version":1,"pid":${String(process.pid)},"port":41773,"origin":"http://192.0.2.10:41773","devUrl":"http://localhost:5173","desktopAttachToken":"attach-secret","startedAt":"2026-08-21T00:00:00.000Z"}`,
        ),
        httpClient,
      });

      assert.isTrue(Option.isSome(found));
      assert.equal(Option.getOrThrow(found).origin, "http://192.0.2.10:41773/");
      assert.equal(Option.getOrThrow(found).desktopAttachToken, "attach-secret");
      assert.deepEqual(requestedUrls, ["http://192.0.2.10:41773/.well-known/t3/environment"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("pairExistingLocalBackend", () => {
  const backend = {
    baseDir: "/home/tester/.t3/service",
    origin: "http://127.0.0.1:41773/",
    port: 41773,
    pid: 1234,
    environmentId: "existing-environment",
    label: "Existing environment",
    desktopAttachToken: "attach-secret",
  } as const;

  it.effect("exchanges the running server's attachment credential for a bearer session", () =>
    Effect.gen(function* () {
      const requestedUrls: string[] = [];
      const attachment = yield* pairExistingLocalBackend({
        backend,
        httpClient: HttpClient.make((request) =>
          Effect.sync(() => {
            requestedUrls.push(request.url);
            return HttpClientResponse.fromWeb(
              request,
              Response.json({
                access_token: "bearer-secret",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "Bearer",
                expires_in: 3600,
                scope: "orchestration:read",
              }),
            );
          }),
        ),
      });

      assert.equal(attachment.credential, "attach-secret");
      assert.equal(attachment.bearerToken, "bearer-secret");
      assert.deepEqual(requestedUrls, ["http://127.0.0.1:41773/oauth/token"]);
    }),
  );

  it.effect("fails without touching the network when the running server is too old", () =>
    Effect.gen(function* () {
      let requestCount = 0;
      const error = yield* pairExistingLocalBackend({
        backend: { ...backend, desktopAttachToken: null },
        httpClient: HttpClient.make(() =>
          Effect.sync(() => {
            requestCount += 1;
            throw new Error("unexpected request");
          }),
        ),
      }).pipe(Effect.flip);

      assert.equal(error._tag, "ExistingLocalBackendPairingError");
      assert.equal(error.reason, "missing-credential");
      assert.isUndefined(error.cause);
      assert.equal(requestCount, 0);
    }),
  );

  it.effect("preserves a rejected server-side token exchange as a pairing failure", () =>
    Effect.gen(function* () {
      const error = yield* pairExistingLocalBackend({
        backend,
        httpClient: HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ error: "invalid_grant" }, { status: 400 }),
            ),
          ),
        ),
      }).pipe(Effect.flip);

      assert.equal(error._tag, "ExistingLocalBackendPairingError");
      assert.equal(error.reason, "token-exchange-rejected");
      assert.isDefined(error.cause);
      assert.include(error.message, "Could not establish a secure Desktop session");
    }),
  );
});
