import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { MuseSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import type { MuseSdkHost } from "../museSdk.ts";
import { checkMuseProviderStatus, makePendingMuseProvider } from "./MuseProvider.ts";

const settings = Schema.decodeSync(MuseSettings);
const makeHost = (catalog: Record<string, unknown>) => {
  const host: MuseSdkHost = {
    initializeResult: {
      experimentalApi: false,
      grantedCapabilities: [],
      museHome: "/fake/muse",
      platformFamily: "unix",
      platformOs: "linux",
      schema: { fingerprint: "test", version: 1 },
      serverInfo: { name: "muse", version: "1.0.3" },
      userAgent: "test",
    },
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
      modelId: "muse-discovered",
      displayLabel: "Muse Discovered",
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

describe("Muse provider defaults", () => {
  it.effect("keeps the provider opt-in without inventing models before discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* makePendingMuseProvider(settings({}));
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.auth.status).toBe("unknown");
      expect(snapshot.models).toEqual([]);
    }),
  );
});

it.layer(NodeServices.layer)("Muse status", (it) => {
  it.effect("does not start a host when disabled", () =>
    Effect.gen(function* () {
      const createHost = vi.fn(async () => makeHost(metaCatalog));
      const snapshot = yield* checkMuseProviderStatus(settings({}), {}, undefined, createHost);
      expect(snapshot.status).toBe("disabled");
      expect(createHost).not.toHaveBeenCalled();
    }),
  );

  it.effect("gives host-local install and login guidance for a missing binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkMuseProviderStatus(
        settings({ enabled: true, binaryPath: "/definitely-missing/muse" }),
      );
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("muse login");
      expect(snapshot.message).toContain("this T3 server host");
    }),
  );

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
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.version).toBe("1.0.3-R2198.1");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "muse-discovered",
          "muse-custom",
        ]);
        const descriptor = snapshot.models[0]?.capabilities?.optionDescriptors?.[0];
        expect(
          descriptor?.type === "select" && descriptor.options.map((option) => option.id),
        ).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "ultra"]);
        expect(host.connection.request).toHaveBeenCalledWith("model/list", {});
        expect(host.connection.command).not.toHaveBeenCalled();
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
  );

  it.effect("closes the host after malformed metadata and reports unavailable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* fakeCli();
        const host = makeHost({ providerId: "meta", models: [{ modelId: 1 }] });
        const snapshot = yield* checkMuseProviderStatus(
          settings({ enabled: true, binaryPath }),
          undefined,
          undefined,
          async () => host,
        );
        expect(snapshot.status).toBe("error");
        expect(snapshot.auth.status).toBe("unknown");
        expect(snapshot.models).toEqual([]);
        expect(host.close).toHaveBeenCalledOnce();
      }),
    ),
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
