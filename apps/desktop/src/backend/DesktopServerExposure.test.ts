import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

const encoder = new TextEncoder();

const emptyNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {};
const lanNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  en0: [
    {
      address: "192.168.1.20",
      family: "IPv4",
      internal: false,
    },
  ],
};

const tailnetNetworkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces = {
  tailscale0: [
    {
      address: "100.90.1.2",
      family: "IPv4",
      internal: false,
    },
  ],
};

function layerMockSpawner(
  statusJson: string | ((command: ChildProcess.Command) => string | null) = "{}",
  onSpawn?: () => void,
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        onSpawn?.();
        const output = typeof statusJson === "string" ? statusJson : statusJson(command);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(output === null ? 1 : 0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(output ?? "")),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
}

function layerEnvironmentFor(baseDir: string, env: Record<string, string | undefined> = {}) {
  return DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/src",
    homeDirectory: baseDir,
    platform: "darwin",
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: true,
    resourcesPath: "/missing/resources",
    runningUnderArm64Translation: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir, ...env })),
    ),
  );
}

function layer(input: {
  readonly baseDir: string;
  readonly networkInterfaces?: DesktopNetworkInterfaces.NetworkInterfaces;
  readonly env?: Record<string, string | undefined>;
  readonly spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly desktopSettingsLayer?: Layer.Layer<DesktopAppSettings.DesktopAppSettings>;
}) {
  const env = { T3CODE_HOME: input.baseDir, ...input.env };
  const layerEnvironment = layerEnvironmentFor(input.baseDir, env);
  const layerNetwork = Layer.succeed(DesktopNetworkInterfaces.DesktopNetworkInterfaces, {
    read: Effect.succeed(input.networkInterfaces ?? emptyNetworkInterfaces),
  });

  return DesktopServerExposure.layer.pipe(
    Layer.provideMerge(input.desktopSettingsLayer ?? DesktopAppSettings.layer),
    Layer.provideMerge(NodeFileSystem.layer),
    Layer.provideMerge(NodeHttpClient.layerUndici),
    Layer.provideMerge(input.spawnerLayer ?? layerMockSpawner()),
    Layer.provideMerge(layerNetwork),
    Layer.provideMerge(DesktopConfig.layerTest(env)),
    Layer.provideMerge(layerEnvironment),
  );
}

const withHarness = <A, E, R>(
  networkInterfaces: DesktopNetworkInterfaces.NetworkInterfaces,
  effect: Effect.Effect<
    A,
    E,
    | R
    | DesktopEnvironment.DesktopEnvironment
    | FileSystem.FileSystem
    | DesktopServerExposure.DesktopServerExposure
    | DesktopAppSettings.DesktopAppSettings
  >,
  env: Record<string, string | undefined> = {},
  spawnerLayer?: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>,
  desktopSettingsLayer?: Layer.Layer<DesktopAppSettings.DesktopAppSettings>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-server-exposure-test-",
    });
    return yield* effect.pipe(
      Effect.provide(
        layer({
          baseDir,
          networkInterfaces,
          env,
          ...(spawnerLayer ? { spawnerLayer } : {}),
          ...(desktopSettingsLayer ? { desktopSettingsLayer } : {}),
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("DesktopServerExposure", () => {
  it.effect("uses cached Tailscale identity to exclude another VPN's pairing address", () => {
    let statusReads = 0;
    return withHarness(
      {
        ...lanNetworkInterfaces,
        pvpnksintrf1: [{ address: "100.85.0.1", family: "IPv4", internal: false }],
        vpn0: [{ address: "100.74.126.34", family: "IPv4", internal: false }],
      },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/", "http://100.74.126.34:4173/"],
        );
        assert.deepEqual(yield* serverExposure.getAdvertisedEndpoints, endpoints);
        assert.equal(statusReads, 1);
      }),
      {},
      layerMockSpawner(`{"Self":{"TailscaleIPs":["100.74.126.34"]}}`, () => {
        statusReads += 1;
      }),
    );
  });

  it.effect("falls back to local-only without losing the requested network preference", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.setServerExposureMode("network-accessible");

        const state = yield* serverExposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "local-only");
        assert.equal(state.endpointUrl, null);
        assert.equal((yield* settings.get).serverExposureMode, "network-accessible");

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "127.0.0.1");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");
      }),
    ),
  );

  it.effect("persists network-accessible mode and updates backend binding state", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const change = yield* serverExposure.setMode("network-accessible");
        assert.equal(change.requiresRelaunch, true);
        assert.deepEqual(change.state, {
          mode: "network-accessible",
          endpointUrl: "http://192.168.1.20:4173",
          advertisedHost: "192.168.1.20",
          tailscaleServeEnabled: false,
          tailscaleServePort: 443,
        });

        const backendConfig = yield* serverExposure.backendConfig;
        assert.equal(backendConfig.bindHost, "0.0.0.0");
        assert.equal(backendConfig.httpBaseUrl.href, "http://127.0.0.1:4173/");

        const persisted = yield* settings.get;
        assert.equal(persisted.serverExposureMode, "network-accessible");
      }),
    ),
  );

  it.effect("advertises the Wi-Fi or Ethernet address ahead of bridges and tunnels", () =>
    withHarness(
      {
        bridge0: [{ address: "192.168.2.1", family: "IPv4", internal: false }],
        utun4: [{ address: "10.8.0.2", family: "IPv4", internal: false }],
        en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
      },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const change = yield* serverExposure.setMode("network-accessible");
        assert.equal(change.state.advertisedHost, "192.168.1.20");
      }),
    ),
  );

  it.effect("persists tailscale serve preferences atomically and reports no-op updates", () =>
    withHarness(
      emptyNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;

        yield* settings.load;
        yield* serverExposure.configureFromSettings({ port: 4173 });

        const changed = yield* serverExposure.setTailscaleServeEnabled({
          enabled: true,
          port: 8443,
        });
        assert.equal(changed.requiresRelaunch, true);
        assert.equal(changed.state.tailscaleServeEnabled, true);
        assert.equal(changed.state.tailscaleServePort, 8443);

        const unchanged = yield* serverExposure.setTailscaleServeEnabled({
          enabled: true,
          port: 8443,
        });
        assert.equal(unchanged.requiresRelaunch, false);

        const persisted = yield* settings.get;
        assert.equal(persisted.tailscaleServeEnabled, true);
        assert.equal(persisted.tailscaleServePort, 8443);
      }),
    ),
  );

  it.effect("keeps a Tailscale Serve change made while a mode change is saving", () =>
    Effect.gen(function* () {
      const modeWriteStarted = yield* Deferred.make<void>();
      const releaseModeWrite = yield* Deferred.make<void>();
      const settingsLayer = Layer.effect(
        DesktopAppSettings.DesktopAppSettings,
        Effect.gen(function* () {
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          return DesktopAppSettings.DesktopAppSettings.of({
            ...settings,
            setServerExposureMode: (mode) =>
              Deferred.succeed(modeWriteStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseModeWrite)),
                Effect.andThen(settings.setServerExposureMode(mode)),
              ),
          });
        }),
      ).pipe(Layer.provide(DesktopAppSettings.layerTest()));

      return yield* withHarness(
        lanNetworkInterfaces,
        Effect.gen(function* () {
          const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
          yield* serverExposure.configureFromSettings({ port: 4173 });

          const modeChange = yield* serverExposure
            .setMode("network-accessible")
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(modeWriteStarted);
          const tailscaleChange = yield* serverExposure
            .setTailscaleServeEnabled({ enabled: true, port: 8443 })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.succeed(releaseModeWrite, undefined);
          yield* Fiber.join(modeChange);
          yield* Fiber.join(tailscaleChange);

          const state = yield* serverExposure.getState;
          assert.equal(state.mode, "network-accessible");
          assert.equal(state.tailscaleServeEnabled, true);
          assert.equal(state.tailscaleServePort, 8443);
        }),
        {},
        undefined,
        settingsLayer,
      );
    }),
  );

  it.effect("keeps LAN and Tailscale endpoints distinct when Tailscale is enumerated first", () =>
    withHarness(
      { ...tailnetNetworkInterfaces, ...lanNetworkInterfaces },
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        yield* serverExposure.setMode("network-accessible");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/", "http://100.90.1.2:4173/"],
        );
      }),
    ),
  );

  describe("WSL primary", () => {
    const hostInterfaces = {
      ...lanNetworkInterfaces,
      tailscale0: [{ address: "100.90.1.2", family: "IPv4" as const, internal: false }],
    };
    const tailscaleStatus = `{"Self":{"DNSName":"win-host.tail1234.ts.net.","TailscaleIPs":["100.90.1.2"]}}`;

    interface DistroProbe {
      /** `hostname -I` output; null makes the probe fail. */
      readonly hostnameOutput: string | null;
      readonly windowsStatus?: string;
      /** `tailscale ip -4` output; null makes it fail (not installed). */
      readonly tailscaleOutput: string | null;
      /** When set, only `wsl.exe -d <distro>` answers; other distros fail. */
      readonly distro?: string;
    }

    const wslSpawner = (probe: DistroProbe) =>
      layerMockSpawner((command) => {
        if (command._tag !== "StandardCommand" || command.command !== "wsl.exe") {
          return probe.windowsStatus ?? tailscaleStatus;
        }
        if (probe.distro !== undefined && command.args[1] !== probe.distro) return null;
        return command.args.at(-1) === "hostname -I" ? probe.hostnameOutput : probe.tailscaleOutput;
      });

    const advertisedUrls = (
      probe: DistroProbe,
      wslPrimary: { readonly distro: string | null } | null = { distro: null },
      env: Record<string, string | undefined> = {},
    ) =>
      withHarness(
        hostInterfaces,
        Effect.gen(function* () {
          const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* settings.setServerExposureMode("network-accessible");
          yield* serverExposure.setWslPrimary(wslPrimary);
          yield* serverExposure.configureFromSettings({ port: 4173 });
          return (yield* serverExposure.getAdvertisedEndpoints).map(
            (endpoint) => endpoint.httpBaseUrl,
          );
        }),
        env,
        wslSpawner(probe),
      );

    const windowsUrls = [
      "http://127.0.0.1:4173/",
      "http://192.168.1.20:4173/",
      "http://100.90.1.2:4173/",
      "https://win-host.tail1234.ts.net/",
    ];

    it.effect("NAT: drops Windows addresses and adds the distro's Tailscale IP", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* advertisedUrls({
            hostnameOutput: "172.20.1.5 100.64.0.9\n",
            tailscaleOutput: "100.64.0.9\n",
          }),
          [
            "http://127.0.0.1:4173/",
            "https://win-host.tail1234.ts.net/",
            "http://100.64.0.9:4173/",
          ],
        );
      }),
    );

    it.effect(
      "NAT: a 100.64/10 address the distro's Tailscale doesn't report is not advertised",
      () =>
        Effect.gen(function* () {
          for (const tailscaleOutput of ["", null]) {
            assert.deepEqual(
              yield* advertisedUrls({ hostnameOutput: "172.20.1.5 100.64.0.9\n", tailscaleOutput }),
              ["http://127.0.0.1:4173/", "https://win-host.tail1234.ts.net/"],
            );
          }
        }),
    );

    it.effect("mirrored: keeps the Windows addresses the distro shares", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* advertisedUrls({
            hostnameOutput: "192.168.1.20 100.90.1.2\n",
            tailscaleOutput: null,
          }),
          windowsUrls,
        );
      }),
    );

    it.effect("preserves an explicit LAN hostname in mirrored mode", () =>
      Effect.gen(function* () {
        const urls = yield* advertisedUrls(
          { hostnameOutput: "192.168.1.20 100.90.1.2", tailscaleOutput: null },
          { distro: "Ubuntu" },
          { T3CODE_DESKTOP_LAN_HOST: "desktop.lan" },
        );
        assert.include(urls, "http://desktop.lan:4173/");
      }),
    );

    it.effect("keeps a direct Tailscale endpoint alongside a custom URL on another port", () =>
      Effect.gen(function* () {
        const urls = yield* advertisedUrls(
          { hostnameOutput: "172.20.1.5 100.64.0.9", tailscaleOutput: "100.64.0.9" },
          { distro: "Ubuntu" },
          { T3CODE_DESKTOP_HTTPS_ENDPOINTS: "https://100.64.0.9:8443" },
        );
        assert.include(urls, "https://100.64.0.9:8443/");
        assert.include(urls, "http://100.64.0.9:4173/");
      }),
    );

    it.effect("NAT: clears the Windows pairing fallback when only loopback remains", () =>
      withHarness(
        hostInterfaces,
        Effect.gen(function* () {
          const exposure = yield* DesktopServerExposure.DesktopServerExposure;
          const settings = yield* DesktopAppSettings.DesktopAppSettings;
          yield* settings.setServerExposureMode("network-accessible");
          yield* exposure.configureFromSettings({ port: 4173 });
          yield* exposure.setWslPrimary({ distro: "Ubuntu" });
          assert.deepEqual(
            (yield* exposure.getAdvertisedEndpoints).map((endpoint) => endpoint.httpBaseUrl),
            ["http://127.0.0.1:4173/"],
          );
          const state = yield* exposure.getState;
          assert.isNull(state.endpointUrl);
          assert.isNull(state.advertisedHost);
        }),
        {},
        wslSpawner({ hostnameOutput: "172.20.1.5", tailscaleOutput: null, windowsStatus: "{}" }),
      ),
    );

    it.effect("keeps the Windows addresses when the distro can't be probed", () =>
      Effect.gen(function* () {
        for (const hostnameOutput of [null, ""]) {
          assert.deepEqual(
            yield* advertisedUrls({ hostnameOutput, tailscaleOutput: null }),
            windowsUrls,
          );
        }
      }),
    );

    it.effect("keeps the Windows addresses when the Windows primary is running", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* advertisedUrls(
            { hostnameOutput: "172.20.1.5 100.64.0.9\n", tailscaleOutput: "100.64.0.9\n" },
            null,
          ),
          windowsUrls,
        );
      }),
    );

    it.effect("probes the distro the backend runs in, not the current default", () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* advertisedUrls(
            {
              hostnameOutput: "172.20.1.5 100.64.0.9\n",
              tailscaleOutput: "100.64.0.9\n",
              distro: "Pinned",
            },
            { distro: "Pinned" },
          ),
          [
            "http://127.0.0.1:4173/",
            "https://win-host.tail1234.ts.net/",
            "http://100.64.0.9:4173/",
          ],
        );
      }),
    );
  });

  it.effect("keeps Tailscale-only hosts network-accessible", () =>
    withHarness(
      tailnetNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        const settings = yield* DesktopAppSettings.DesktopAppSettings;
        yield* settings.setServerExposureMode("network-accessible");

        const state = yield* serverExposure.configureFromSettings({ port: 4173 });
        assert.equal(state.mode, "network-accessible");
        assert.equal(state.advertisedHost, null);
        assert.equal(state.endpointUrl, null);
        assert.equal((yield* serverExposure.backendConfig).bindHost, "0.0.0.0");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => [endpoint.reachability, endpoint.httpBaseUrl]),
          [
            ["loopback", "http://127.0.0.1:4173/"],
            ["private-network", "http://100.90.1.2:4173/"],
          ],
        );
      }),
    ),
  );

  it.effect(
    "refreshes Tailscale status when addresses change and caches unchanged addresses",
    () => {
      const networkInterfaces: Record<
        string,
        readonly DesktopNetworkInterfaces.DesktopNetworkInterfaceInfo[] | undefined
      > = { ...lanNetworkInterfaces };
      let statusJson = "{}";
      let statusReads = 0;

      return withHarness(
        networkInterfaces,
        Effect.gen(function* () {
          const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
          yield* serverExposure.configureFromSettings({ port: 4173 });
          yield* serverExposure.setMode("network-accessible");

          const initial = yield* serverExposure.getAdvertisedEndpoints;
          assert.deepEqual(
            initial.map((endpoint) => endpoint.httpBaseUrl),
            ["http://127.0.0.1:4173/", "http://192.168.1.20:4173/"],
          );
          assert.equal(statusReads, 1);

          for (const [address, dnsName] of [
            ["100.90.1.2", "desktop.tail.ts.net"],
            ["100.90.1.3", "desktop.other-tail.ts.net"],
          ] as const) {
            networkInterfaces.vpn0 = [{ address, family: "IPv4", internal: false }];
            statusJson = JSON.stringify({
              Self: { DNSName: `${dnsName}.`, TailscaleIPs: [address] },
            });
            const previousReads = statusReads;

            const endpoints = yield* serverExposure.getAdvertisedEndpoints;
            assert.deepEqual(
              endpoints.map((endpoint) => endpoint.httpBaseUrl),
              [
                "http://127.0.0.1:4173/",
                "http://192.168.1.20:4173/",
                `http://${address}:4173/`,
                `https://${dnsName}/`,
              ],
            );
            assert.equal(statusReads, previousReads + 1);
            assert.deepEqual(yield* serverExposure.getAdvertisedEndpoints, endpoints);
            assert.equal(statusReads, previousReads + 1);
          }
        }),
        {},
        layerMockSpawner(
          () => statusJson,
          () => {
            statusReads += 1;
          },
        ),
      );
    },
  );

  it.effect("preserves explicit Tailscale exposure overrides", () =>
    withHarness(
      lanNetworkInterfaces,
      Effect.gen(function* () {
        const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
        yield* serverExposure.configureFromSettings({ port: 4173 });
        const change = yield* serverExposure.setMode("network-accessible");

        assert.equal(change.state.advertisedHost, "100.90.1.2");
        assert.equal(change.state.endpointUrl, "http://100.90.1.2:4173");

        const endpoints = yield* serverExposure.getAdvertisedEndpoints;
        assert.deepEqual(
          endpoints.map((endpoint) => endpoint.httpBaseUrl),
          ["http://127.0.0.1:4173/", "http://100.90.1.2:4173/", "https://public.example.test/"],
        );
      }),
      {
        T3CODE_DESKTOP_LAN_HOST: "100.90.1.2",
        T3CODE_DESKTOP_HTTPS_ENDPOINTS: "https://public.example.test",
      },
    ),
  );
});
