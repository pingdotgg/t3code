import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { MuseSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "@t3tools/provider-testing/fakeCli";
import type { MuseSdkHost } from "./sdk.ts";
import { COMPACT_SLASH_COMMAND } from "@t3tools/provider-core/server/snapshotProbe";
import { checkMuseProviderStatus } from "./status.ts";
import { MuseDriver } from "./driver.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

const driverLayer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const settings = Schema.decodeSync(MuseSettings);
const makeHost = (catalog: Record<string, unknown>) => {
  const host: MuseSdkHost = {
    initializeResult: { grantedCapabilities: [] },
    connection: {
      request: vi.fn(async () => catalog),
      command: vi.fn(async () => ({})),
      mintCommandId: () => "test-command",
      onNotification: () => {},
      onServerRequest: () => {},
      onProtocolError: () => {},
      closed: new Promise(() => {}),
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {}),
  };
  return host;
};
const metaCatalog = {
  providerId: "meta",
  models: [
    {
      modelId: "muse-wonder-1.0",
      displayLabel: "muse-wonder-1.0",
      providerId: "meta",
      isDefault: true,
    },
    {
      modelId: "foreign-model",
      displayLabel: "Another provider",
      providerId: "another",
      isDefault: false,
    },
  ],
};

const fakeCli = (source = 'process.stdout.write("muse 1.0.3-R2198.1\\n");') =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-status-test-" });
    return writeFakeCli({ directory, name: "muse", source });
  });

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("does not expose CLI stderr or start an SDK host after a failed version check", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli(
          'process.stderr.write("secret-test-value");process.exit(2);',
        );
        const createHost = vi.fn(async () => makeHost(metaCatalog));
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          createHost,
        );
        expect(snapshot.installed).toBe(true);
        expect(snapshot.status).toBe("error");
        expect(snapshot.message).not.toContain("secret-test-value");
        expect(createHost).not.toHaveBeenCalled();
      }),
    ),
  );

  it.effect("discovers the Meta catalog without treating it as authentication proof", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost(metaCatalog);
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath, customModels: ["muse-custom"] }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.message).toBeUndefined();
        expect(snapshot.skills).toEqual([]);
        expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.version).toBe("1.0.3-R2198.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "muse-wonder-1.0",
          "muse-custom",
        ]);
        expect(snapshot.models.map((model) => model.name)).toEqual([
          "Muse Wonder 1.0",
          "muse-custom",
        ]);
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          descriptor?.type === "select" && descriptor.options.map((option) => option.id),
        ).toEqual(["low", "medium", "high", "xhigh", "max"]);
        expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("publishes normalized machine skills and their availability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const fixture = {
          skills: [
            {
              name: "plugin:ai-ugc:ugc-mode",
              path: "plugin://ai-ugc/skills/ugc-mode/SKILL.md",
              scope: "plugin",
              display_name: "UGC mode",
              description: "  Route work. ",
              activation: "on",
            },
            {
              name: "git",
              path: "bundled://muse-core/skills/git/SKILL.md",
              scope: "bundled",
              description: "Bundled Git workflow",
              activation: "off",
            },
            {
              name: "git",
              path: "$HOME/.agents/skills/git/SKILL.md",
              scope: "user",
              description: "My Git workflow",
              activation: "on",
            },
            {
              name: "off",
              path: "$HOME/.muse/skills/off/SKILL.md",
              scope: "user",
              activation: "off",
            },
          ],
        };
        const binaryPath = yield* fakeCli(
          `process.stdout.write(process.argv.includes("skills") ? ${JSON.stringify(JSON.stringify(fixture))} : "muse 1.4.6\\n");`,
        );
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          { ...process.env, HOME: "/home/muse-test" },
          undefined,
          async () => makeHost(metaCatalog),
        );
        expect(snapshot.status).toBe("ready");
        expect(snapshot.skills).toEqual([
          {
            name: "ai-ugc:ugc-mode",
            path: "plugin://ai-ugc/skills/ugc-mode/SKILL.md",
            scope: "plugin",
            displayName: "UGC mode",
            description: "Route work.",
            enabled: true,
          },
          {
            name: "git",
            path: path.join("/home/muse-test", ".agents/skills/git/SKILL.md"),
            scope: "user",
            description: "My Git workflow",
            enabled: true,
          },
          {
            name: "off",
            path: path.join("/home/muse-test", ".muse/skills/off/SKILL.md"),
            scope: "user",
            enabled: false,
          },
        ]);
      }),
    ),
  );

  it.effect("discovers skills for each workspace and reports failed refreshes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "muse-workspace-test-" });
      const first = path.join(directory, "first");
      const second = path.join(directory, "second");
      const failed = path.join(directory, "failed");
      for (const cwd of [first, second, failed]) yield* fs.makeDirectory(cwd);
      const fixture = {
        skills: [
          {
            name: "local",
            path: ".agents/skills/local/SKILL.md",
            scope: "project",
            activation: "user-invocable-only",
          },
        ],
      };
      // Version probes fail so this fixture never opens a real SDK host.
      const binaryPath = yield* fakeCli(`
        if (!process.argv.includes("--workspace")) process.exit(1);
        const workspace = process.argv[process.argv.indexOf("--workspace") + 1];
        if (workspace === ${JSON.stringify(failed)}) process.exit(1);
        process.stdout.write(${JSON.stringify(JSON.stringify(fixture))});
      `);
      const driver = yield* MuseDriver.create({
        instanceId: ProviderInstanceId.make("muse-test"),
        displayName: undefined,
        environment: [],
        enabled: true,
        config: { ...MuseDriver.defaultConfig(), binaryPath },
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("No HTTP expected")),
        ),
      );
      expect(driver.snapshotForCwd).toBeDefined();
      for (const cwd of [first, second]) {
        const snapshot = yield* driver.snapshotForCwd!(cwd);
        expect(snapshot.slashCommands).toEqual([COMPACT_SLASH_COMMAND]);
        expect(snapshot.slashCommandsPending).toBe(false);
        expect(snapshot.skills).toEqual([
          {
            name: "local",
            path: path.join(cwd, ".agents/skills/local/SKILL.md"),
            scope: "project",
            enabled: true,
            userInvocationOnly: true,
          },
        ]);
      }
      const failure = yield* driver.snapshotForCwd!(failed).pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "ProviderDriverError", driver: "muse" });
    }).pipe(Effect.scoped, Effect.provide(driverLayer)),
  );

  it.effect("keeps an empty discovered catalog empty instead of advertising a fallback model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("warning");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );
});
