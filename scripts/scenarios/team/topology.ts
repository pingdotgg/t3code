// @effect-diagnostics-next-line nodeBuiltinImport:off -- lightweight HTTP + WebSocket upgrade reverse proxy per E2E member origin
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EnvironmentHttpApi, ProjectId, type TeamRole } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { Cookies, FetchHttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

import { TEAM_APP_DIR, TEAM_SCENARIOS_HOME } from "../../e2e.team.config.ts";
import { run, ScenarioError } from "../shell.ts";
import { prepareHome, SCENARIO_MACHINE_ENV, start } from "../start-app.ts";
import { environmentId, makeState, runPromise } from "../t3.ts";

export interface TeamMemberSpec {
  readonly pseudo: string;
  readonly role: TeamRole;
}

export interface RecordedBrowserNotification {
  readonly title: string;
  readonly body: string;
  readonly tag: string;
}

export interface TeamProjectOptions {
  readonly gitOriginUrl?: string;
}

export interface TeamMemberHandle {
  readonly pseudo: string;
  readonly role: TeamRole;
  readonly origin: string;
  readonly localServerOrigin: string;
  readonly localEnvironmentId: string;
  readonly home: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly open: (targetPath?: string) => Promise<void>;
  readonly project: (
    title: string,
    files?: Readonly<Record<string, string | Uint8Array>>,
    options?: TeamProjectOptions,
  ) => Promise<string>;
  readonly notifications: () => Promise<ReadonlyArray<RecordedBrowserNotification>>;
  readonly clearNotifications: () => Promise<void>;
  readonly setWindowFocused: (focused: boolean) => Promise<void>;
  readonly pairWithRemoteServer: (input: {
    readonly host: string;
    readonly pairingToken: string;
  }) => Promise<void>;
}

export interface TeamServerHandle {
  readonly origin: string;
  readonly home: string;
  readonly pairingToken: string;
  readonly environmentId: string;
  readonly project: (
    title: string,
    files?: Readonly<Record<string, string | Uint8Array>>,
    options?: TeamProjectOptions,
  ) => Promise<string>;
}

export interface TeamTopology extends AsyncDisposable {
  readonly teamServer: TeamServerHandle;
  readonly extraRemoteEnvironments: ReadonlyArray<TeamServerHandle>;
  readonly members: Readonly<Record<string, TeamMemberHandle>>;
  readonly member: (pseudo: string) => TeamMemberHandle;
}

const PROXY_TO_LOCAL_PREFIXES = ["/api/", "/ws", "/oauth/", "/.well-known/"] as const;

function shouldProxyToLocalServer(urlPath: string | undefined): boolean {
  if (!urlPath) return false;
  return PROXY_TO_LOCAL_PREFIXES.some((prefix) => urlPath.startsWith(prefix));
}

interface ProxyServerHandle {
  readonly close: () => Promise<void>;
}

function startMemberOriginProxy(input: {
  readonly proxyPort: number;
  readonly localServerPort: number;
  readonly vitePort: number;
}): Promise<ProxyServerHandle> {
  return new Promise((resolve, reject) => {
    const activeSockets = new Set<NodeNet.Socket>();
    const trackSocket = (socket: NodeNet.Socket) => {
      activeSockets.add(socket);
      socket.once("close", () => activeSockets.delete(socket));
    };

    const server = NodeHttp.createServer((req, res) => {
      const targetPort = shouldProxyToLocalServer(req.url) ? input.localServerPort : input.vitePort;
      const headers: NodeHttp.OutgoingHttpHeaders = {
        ...req.headers,
        host: `127.0.0.1:${targetPort}`,
      };
      const proxyReq = NodeHttp.request(
        {
          hostname: "127.0.0.1",
          port: targetPort,
          method: req.method,
          path: req.url,
          headers,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
          proxyRes.pipe(res);
        },
      );
      proxyReq.on("error", (error) => {
        if (!res.headersSent) {
          res.writeHead(502, { "content-type": "text/plain" });
        }
        res.end(`Proxy error: ${error.message}`);
      });
      req.pipe(proxyReq);
    });

    server.on("upgrade", (req, socket, head) => {
      if (socket instanceof NodeNet.Socket) trackSocket(socket);
      const targetPort = shouldProxyToLocalServer(req.url) ? input.localServerPort : input.vitePort;
      const upstream = NodeNet.connect(targetPort, "127.0.0.1", () => {
        const rawHeaderLines: Array<string> = [];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const name = req.rawHeaders[i]!;
          const value = req.rawHeaders[i + 1] ?? "";
          if (name.toLowerCase() === "host") {
            rawHeaderLines.push(`Host: 127.0.0.1:${targetPort}`);
          } else {
            rawHeaderLines.push(`${name}: ${value}`);
          }
        }
        const requestHead = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}\r\n${rawHeaderLines.join("\r\n")}\r\n\r\n`;
        upstream.write(requestHead);
        if (head.length > 0) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
      trackSocket(upstream);
      upstream.on("error", () => {
        socket.destroy();
      });
      socket.on("error", () => {
        upstream.destroy();
      });
    });

    server.on("error", reject);
    server.listen(input.proxyPort, "127.0.0.1", () =>
      resolve({
        close: () =>
          new Promise<void>((done) => {
            for (const socket of activeSockets) socket.destroy();
            activeSockets.clear();
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      }),
    );
  });
}

const randomUuid = SecureRandom.SecureRandom.pipe(
  Effect.flatMap((random) => random.uuidV4()),
  Effect.provide(NodeCrypto.layer),
);

const reservePort = NetService.NetService.pipe(
  Effect.flatMap((net) => net.reserveLoopbackPort()),
  Effect.provide(NetService.layer),
);

const SettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeSettingsJson = Schema.decodeEffect(SettingsJson);
const encodeSettingsJson = Schema.encodeEffect(SettingsJson);

export interface StartedServerHandle {
  readonly origin: string;
  readonly pairingToken: string;
  readonly stop: () => Promise<void>;
}

export function startT3ServerProcess(input: {
  readonly home: string;
  readonly port: number;
  readonly devUrl: string;
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly devAuthToken: string;
  readonly environmentLabel: string;
  readonly extraArgs?: ReadonlyArray<string>;
  readonly settingsPatch?: Readonly<Record<string, unknown>>;
}): Promise<StartedServerHandle> {
  const ready = Promise.withResolvers<{ readonly pairingToken: string }>();
  const runServer = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const node = yield* HostProcess.ExecutablePath;
    const hostEnvironment = yield* HostProcess.Environment;
    yield* prepareHome(input.home);
    if (input.settingsPatch !== undefined) {
      const settingsPath = path.join(input.home, "userdata/settings.json");
      const currentRaw = yield* fs.readFileString(settingsPath);
      const current = yield* decodeSettingsJson(currentRaw);
      const nextRaw = yield* encodeSettingsJson({
        ...current,
        ...input.settingsPatch,
      });
      yield* fs.writeFileString(settingsPath, nextRaw);
    }
    const tokenDeferred = yield* Deferred.make<string>();
    const recentStdout: Array<string> = [];
    const server = yield* start({
      cwd: TEAM_APP_DIR,
      command: node,
      args: [
        "apps/server/src/bin.ts",
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(input.port),
        "--base-dir",
        input.home,
        "--dev-url",
        input.devUrl,
        ...(input.extraArgs ?? []),
      ],
      env: {
        PATH: `${path.join(input.home, "bin")}:${hostEnvironment.PATH ?? ""}`,
        HOME: hostEnvironment.HOME,
        T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
        T3CODE_DEV_ALLOWED_ORIGINS: input.allowedOrigins.join(","),
        T3CODE_DEV_AUTH_TOKEN: input.devAuthToken,
        ...SCENARIO_MACHINE_ENV,
        T3CODE_ENVIRONMENT_LABEL: input.environmentLabel,
      },
      onLine: (line) => {
        recentStdout.push(line);
        if (recentStdout.length > 50) recentStdout.shift();
        const value = /^Token:\s*(\S+)/.exec(line)?.[1];
        return value === undefined
          ? Effect.void
          : Deferred.succeed(tokenDeferred, value).pipe(Effect.asVoid);
      },
    });
    const exited = server.exitCode.pipe(
      Effect.flatMap(
        (code) =>
          new ScenarioError({
            message: `Server "${input.environmentLabel}" exited early with code ${code}.\nRecent output:\n${recentStdout.join("\n")}`,
          }),
      ),
    );
    const pairingToken = yield* Effect.raceFirst(Deferred.await(tokenDeferred), exited);
    ready.resolve({ pairingToken });
    return yield* Effect.never;
  });

  const fiber = Effect.runFork(
    runServer.pipe(Effect.scoped, Effect.provide([NodeServices.layer, NetService.layer])),
  );
  fiber.addObserver((exit) => {
    ready.reject(
      Exit.isFailure(exit)
        ? Cause.squash(exit.cause)
        : new Error(`Server "${input.environmentLabel}" stopped unexpectedly.`),
    );
  });

  return ready.promise.then(({ pairingToken }) => ({
    origin: `http://127.0.0.1:${input.port}`,
    pairingToken,
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
  }));
}

const sameSiteMap = { lax: "Lax", strict: "Strict", none: "None" } as const;

const signInOrigin = Effect.fn("teamTopology.signInOrigin")(function* (input: {
  readonly baseUrl: string;
  readonly credential: string;
}) {
  const client = yield* HttpApiClient.make(EnvironmentHttpApi, { baseUrl: input.baseUrl });
  const response = yield* client.auth
    .browserSession({ payload: { credential: input.credential }, responseMode: "response-only" })
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.retry({
        schedule: Schedule.spaced("250 millis"),
        while: (error) => {
          if (!HttpClientError.isHttpClientError(error)) return false;
          const status = error.response?.status;
          return (
            error.reason._tag === "TransportError" ||
            status === 502 ||
            status === 503 ||
            status === 504
          );
        },
      }),
      Effect.timeout("15 seconds"),
    );
  const cookies = Cookies.mergeIntoArray(
    [],
    input.baseUrl,
    response.cookies,
    yield* Clock.currentTimeMillis,
  );
  type PlaywrightCookieInput = Parameters<BrowserContext["addCookies"]>[0][number];
  return cookies.map(({ name, value, options = {} }): PlaywrightCookieInput => ({
    name,
    value,
    url: input.baseUrl,
    ...(options.expires && { expires: Math.floor(options.expires.getTime() / 1000) }),
    ...(options.httpOnly !== undefined && { httpOnly: options.httpOnly }),
    ...(options.secure !== undefined && { secure: options.secure }),
    ...(options.sameSite && { sameSite: sameSiteMap[options.sameSite] }),
  }));
}, Effect.provide(FetchHttpClient.layer));

export async function startTeamTopology(input: {
  readonly viteUrl: string;
  readonly members: ReadonlyArray<TeamMemberSpec>;
  readonly extraRemoteEnvironments?: number;
  readonly teamServerSettingsPatch?: Readonly<Record<string, unknown>>;
}): Promise<TeamTopology> {
  const stack = new AsyncDisposableStack();
  try {
    const viteParsed = new URL(input.viteUrl);
    const vitePort = Number(viteParsed.port);
    if (!Number.isInteger(vitePort) || vitePort <= 0) {
      throw new Error(`Invalid shared Vite URL: ${input.viteUrl}`);
    }

    const runId = await Effect.runPromise(randomUuid);
    const runDir = `${TEAM_SCENARIOS_HOME}/run-${runId}`;
    stack.defer(async () => {
      await runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(runDir, { recursive: true, force: true });
        }),
      );
    });

    const teamServerPort = await Effect.runPromise(reservePort);
    const memberAllocations = await Promise.all(
      input.members.map(async (spec) => {
        const localServerPort = await Effect.runPromise(reservePort);
        const proxyPort = await Effect.runPromise(reservePort);
        const rawToken = (await Effect.runPromise(randomUuid)).replaceAll("-", "");
        return {
          spec,
          localServerPort,
          proxyPort,
          origin: `http://127.0.0.1:${proxyPort}`,
          home: `${runDir}/member-${spec.pseudo}`,
          devAuthToken: `${rawToken}${rawToken}`,
        };
      }),
    );

    const allMemberOrigins = memberAllocations.map((allocation) => allocation.origin);
    const teamHome = `${runDir}/team-server`;
    const teamRawToken = (await Effect.runPromise(randomUuid)).replaceAll("-", "");
    const startedTeamServer = await startT3ServerProcess({
      home: teamHome,
      port: teamServerPort,
      devUrl: allMemberOrigins[0] ?? input.viteUrl,
      allowedOrigins: allMemberOrigins,
      devAuthToken: `${teamRawToken}${teamRawToken}`,
      environmentLabel: "Team Server",
      ...(input.teamServerSettingsPatch === undefined
        ? {}
        : { settingsPatch: input.teamServerSettingsPatch }),
    });
    stack.defer(() => startedTeamServer.stop());
    const teamEnvId = await runPromise(environmentId(startedTeamServer.origin));
    const teamStateApi = makeState(teamHome);

    const createProjectWithOrigin = async (inputProject: {
      readonly stateApi: ReturnType<typeof makeState>;
      readonly serverHome: string;
      readonly serverOrigin: string;
      readonly devAuthToken: string;
      readonly title: string;
      readonly files?: Readonly<Record<string, string | Uint8Array>>;
      readonly options?: TeamProjectOptions;
    }): Promise<string> => {
      if (!inputProject.options?.gitOriginUrl) {
        return inputProject.stateApi.state.project(inputProject.title, inputProject.files ?? {});
      }
      const originUrl = inputProject.options.gitOriginUrl;
      return runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const id1 = yield* randomUuid;
          const id2 = yield* randomUuid;
          yield* fs.makeDirectory(path.join(inputProject.serverHome, "workspaces"), {
            recursive: true,
          });
          const parent = yield* fs.makeTempDirectory({
            directory: path.join(inputProject.serverHome, "workspaces"),
            prefix: "w-",
          });
          const workspace = path.join(parent, inputProject.title);
          for (const [file, content] of Object.entries({
            "README.md": "",
            ...inputProject.files,
          })) {
            yield* fs.makeDirectory(path.dirname(path.join(workspace, file)), { recursive: true });
            yield* typeof content === "string"
              ? fs.writeFileString(path.join(workspace, file), content)
              : fs.writeFile(path.join(workspace, file), content);
          }
          const git = (args: ReadonlyArray<string>) => run("git", args, { cwd: workspace });
          const author = ["-c", "user.name=Scenario", "-c", "user.email=scenario@example.invalid"];
          yield* git(["init", "--quiet", "--initial-branch=main"]);
          yield* git(["remote", "add", "origin", originUrl]);
          yield* git(["add", "--all"]);
          yield* git([...author, "commit", "--quiet", "--message", "Initial commit"]);
          const client = yield* HttpApiClient.make(EnvironmentHttpApi, {
            baseUrl: inputProject.serverOrigin,
          });
          yield* client.projects.mutate({
            headers: { authorization: `Bearer ${inputProject.devAuthToken}` },
            payload: {
              type: "project.create",
              commandId: CommandId.make(id1),
              projectId: ProjectId.make(id2),
              title: inputProject.title,
              workspaceRoot: workspace,
            },
          });
          return workspace;
        }).pipe(Effect.provide(FetchHttpClient.layer)),
      );
    };

    const extraRemoteEnvironments: Array<TeamServerHandle> = [];
    const extraCount = input.extraRemoteEnvironments ?? 0;
    for (let i = 0; i < extraCount; i += 1) {
      const extraPort = await Effect.runPromise(reservePort);
      const extraHome = `${runDir}/remote-env-${i + 1}`;
      const extraRawToken = (await Effect.runPromise(randomUuid)).replaceAll("-", "");
      const extraDevAuthToken = `${extraRawToken}${extraRawToken}`;
      const startedExtra = await startT3ServerProcess({
        home: extraHome,
        port: extraPort,
        devUrl: allMemberOrigins[0] ?? input.viteUrl,
        allowedOrigins: allMemberOrigins,
        devAuthToken: extraDevAuthToken,
        environmentLabel: `Remote Env ${i + 1}`,
        settingsPatch: {
          linkedEnvironmentsEnabled: true,
          ...input.teamServerSettingsPatch,
        },
      });
      stack.defer(() => startedExtra.stop());
      const extraEnvId = await runPromise(environmentId(startedExtra.origin));
      const extraStateApi = makeState(extraHome);
      extraRemoteEnvironments.push({
        origin: startedExtra.origin,
        home: extraHome,
        pairingToken: startedExtra.pairingToken,
        environmentId: extraEnvId,
        project: (title, files = {}, options) =>
          createProjectWithOrigin({
            stateApi: extraStateApi,
            serverHome: extraHome,
            serverOrigin: startedExtra.origin,
            devAuthToken: extraDevAuthToken,
            title,
            files,
            ...(options ? { options } : {}),
          }),
      });
    }

    const browser: Browser = await chromium.launch({ headless: true });
    stack.defer(() => browser.close());

    const memberHandles: Record<string, TeamMemberHandle> = {};

    for (const allocation of memberAllocations) {
      const localServer = await startT3ServerProcess({
        home: allocation.home,
        port: allocation.localServerPort,
        devUrl: allocation.origin,
        allowedOrigins: [allocation.origin],
        devAuthToken: allocation.devAuthToken,
        environmentLabel: `Local (${allocation.spec.pseudo})`,
        ...(input.teamServerSettingsPatch === undefined
          ? {}
          : { settingsPatch: input.teamServerSettingsPatch }),
      });
      stack.defer(() => localServer.stop());
      const localEnvId = await runPromise(environmentId(localServer.origin));
      const localStateApi = makeState(allocation.home);

      const proxy = await startMemberOriginProxy({
        proxyPort: allocation.proxyPort,
        localServerPort: allocation.localServerPort,
        vitePort,
      });
      stack.defer(() => proxy.close());

      const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      stack.defer(() => context.close());

      await context.addInitScript(() => {
        const recorded: Array<{
          readonly title: string;
          readonly body: string;
          readonly tag: string;
        }> = [];
        Object.defineProperty(globalThis, "__t3RecordedNotifications", {
          value: recorded,
          configurable: true,
        });
        Object.defineProperty(globalThis, "__t3WindowFocusedOverride", {
          value: null,
          configurable: true,
          writable: true,
        });
        const originalHasFocus = Document.prototype.hasFocus;
        Document.prototype.hasFocus = function hasFocus() {
          const override = (
            globalThis as unknown as { readonly __t3WindowFocusedOverride?: boolean | null }
          ).__t3WindowFocusedOverride;
          if (typeof override === "boolean") return override;
          return originalHasFocus.call(this);
        };
        class MockNotification extends EventTarget {
          static permission = "granted";
          static requestPermission = async () => "granted";
          readonly title: string;
          readonly body: string;
          readonly tag: string;
          constructor(title: string, options?: { readonly body?: string; readonly tag?: string }) {
            super();
            this.title = title;
            this.body = options?.body ?? "";
            this.tag = options?.tag ?? "";
            recorded.push({ title: this.title, body: this.body, tag: this.tag });
          }
          close() {}
        }
        Object.defineProperty(globalThis, "Notification", {
          value: MockNotification,
          configurable: true,
          writable: true,
        });
      });

      const cookies = await runPromise(
        signInOrigin({
          baseUrl: allocation.origin,
          credential: allocation.devAuthToken,
        }),
      );
      await context.addCookies(cookies);
      const page = await context.newPage();

      memberHandles[allocation.spec.pseudo] = {
        pseudo: allocation.spec.pseudo,
        role: allocation.spec.role,
        origin: allocation.origin,
        localServerOrigin: localServer.origin,
        localEnvironmentId: localEnvId,
        home: allocation.home,
        context,
        page,
        open: async (targetPath = "/") => {
          await page.goto(`${allocation.origin}${targetPath}`, { waitUntil: "domcontentloaded" });
        },
        project: (title, files = {}, options) =>
          createProjectWithOrigin({
            stateApi: localStateApi,
            serverHome: allocation.home,
            serverOrigin: localServer.origin,
            devAuthToken: allocation.devAuthToken,
            title,
            files,
            ...(options ? { options } : {}),
          }),
        notifications: async () =>
          page.evaluate(() => {
            const globalRecord = globalThis as unknown as {
              readonly __t3RecordedNotifications?: ReadonlyArray<RecordedBrowserNotification>;
            };
            return [...(globalRecord.__t3RecordedNotifications ?? [])];
          }),
        clearNotifications: async () => {
          await page.evaluate(() => {
            const globalRecord = globalThis as unknown as {
              readonly __t3RecordedNotifications?: Array<RecordedBrowserNotification>;
            };
            if (globalRecord.__t3RecordedNotifications) {
              globalRecord.__t3RecordedNotifications.length = 0;
            }
          });
        },
        setWindowFocused: async (focused: boolean) => {
          if (focused) {
            await page.bringToFront();
          }
          await page.evaluate((nextFocused) => {
            (
              globalThis as unknown as { __t3WindowFocusedOverride: boolean | null }
            ).__t3WindowFocusedOverride = nextFocused;
          }, focused);
        },
        pairWithRemoteServer: async ({ host, pairingToken }) => {
          await page.goto(`${allocation.origin}/settings/connections`, {
            waitUntil: "domcontentloaded",
          });
          await page.getByRole("button", { name: "Add environment" }).first().click();
          const dialog = page.getByRole("dialog", { name: "Add Environment" });
          await dialog.getByLabel("Host").fill(host);
          await dialog.getByLabel("Pairing code").fill(pairingToken);
          await dialog.getByRole("button", { name: "Add environment" }).click();
          await dialog.waitFor({ state: "detached", timeout: 20_000 });
        },
      };
    }

    return {
      teamServer: {
        origin: startedTeamServer.origin,
        home: teamHome,
        pairingToken: startedTeamServer.pairingToken,
        environmentId: teamEnvId,
        project: (title, files = {}, options) =>
          createProjectWithOrigin({
            stateApi: teamStateApi,
            serverHome: teamHome,
            serverOrigin: startedTeamServer.origin,
            devAuthToken: `${teamRawToken}${teamRawToken}`,
            title,
            files,
            ...(options ? { options } : {}),
          }),
      },
      extraRemoteEnvironments,
      members: memberHandles,
      member: (pseudo) => {
        const handle = memberHandles[pseudo];
        if (!handle) {
          throw new Error(`Unknown topology member: ${pseudo}`);
        }
        return handle;
      },
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
