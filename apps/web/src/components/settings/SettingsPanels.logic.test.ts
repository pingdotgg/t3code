import {
  DEFAULT_SERVER_SETTINGS,
  DEFAULT_UNIFIED_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { getBackgroundActivityPresetSettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { MAX_COMPRESSIBLE_SOURCE_BYTES } from "../../lib/imageCompression";
import {
  backgroundActivitySharedPolicySettings,
  buildProviderInstanceUpdatePatch,
  formatDiagnosticsDescription,
  hasChangedBackgroundActivitySettings,
  isProjectGroupingEnabled,
  prepareWallpaperImage,
  projectGroupingModeFromToggle,
  resolveBackgroundActivityProfileOption,
} from "./SettingsPanels.logic";

describe("background activity settings restore", () => {
  it("detects legacy interval values even when the structured setting is at its default", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
      }),
    ).toBe(true);
    expect(
      hasChangedBackgroundActivitySettings({
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
        automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe(true);
    expect(hasChangedBackgroundActivitySettings(DEFAULT_UNIFIED_SETTINGS)).toBe(false);
  });

  it("detects a legacy profile override so restoring defaults clears it", () => {
    expect(
      hasChangedBackgroundActivitySettings({
        ...DEFAULT_UNIFIED_SETTINGS,
        backgroundActivityProfile: "performance",
      }),
    ).toBe(true);
  });

  it("shows the effective legacy preset and marks custom legacy intervals as advanced", () => {
    const performance = getBackgroundActivityPresetSettings("performance");
    expect(
      resolveBackgroundActivityProfileOption({
        ...DEFAULT_UNIFIED_SETTINGS,
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: "performance",
        automaticGitFetchInterval: performance.automaticGitFetchInterval,
        providerHealthRefreshInterval: performance.providerHealthRefreshInterval,
      }),
    ).toBe("performance");

    expect(
      resolveBackgroundActivityProfileOption({
        ...DEFAULT_UNIFIED_SETTINGS,
        backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
        backgroundActivityProfile: "performance",
        automaticGitFetchInterval: Duration.seconds(45),
        providerHealthRefreshInterval: Duration.minutes(7),
      }),
    ).toBe("advanced");
  });

  it("preserves advanced overrides when the shared policy changes", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          backgroundActivity: {
            schemaVersion: 1,
            profile: "custom",
            baseProfile: "balanced",
            overrides: {
              automaticGitFetchInterval,
              pauseWhenOnBattery: true,
            },
          },
        },
        "performance",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "performance",
      overrides: {
        automaticGitFetchInterval,
        pauseWhenOnBattery: true,
      },
    });
  });

  it("materializes legacy advanced overrides before changing the shared policy", () => {
    const automaticGitFetchInterval = Duration.seconds(42);
    expect(
      backgroundActivitySharedPolicySettings(
        {
          ...DEFAULT_UNIFIED_SETTINGS,
          automaticGitFetchInterval,
        },
        "battery-saver",
      ),
    ).toEqual({
      schemaVersion: 1,
      profile: "custom",
      baseProfile: "battery-saver",
      overrides: {
        automaticGitFetchInterval,
      },
    });
  });
});

describe("project grouping toggle", () => {
  it("enables repository grouping and disables into separate projects", () => {
    expect(isProjectGroupingEnabled("repository")).toBe(true);
    expect(isProjectGroupingEnabled("repository_path")).toBe(true);
    expect(isProjectGroupingEnabled("separate")).toBe(false);
    expect(projectGroupingModeFromToggle(true)).toBe("repository");
    expect(projectGroupingModeFromToggle(false)).toBe("separate");
  });

  it("restores repository path grouping when the toggle is cycled", () => {
    expect(projectGroupingModeFromToggle(false, "repository_path")).toBe("separate");
    expect(projectGroupingModeFromToggle(true, "repository_path")).toBe("repository_path");
  });
});

describe("formatDiagnosticsDescription", () => {
  it("collapses trace and metric URLs that share the same OTEL base path", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:4318/v1/metrics",
      }),
    ).toBe("Local trace file. Exporting OTEL to http://localhost:4318/v1/{traces,metrics}.");
  });

  it("keeps separate trace and metric URLs when their base paths differ", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: true,
        otlpTracesUrl: "http://localhost:4318/v1/traces",
        otlpMetricsEnabled: true,
        otlpMetricsUrl: "http://localhost:9000/v1/metrics",
      }),
    ).toBe(
      "Local trace file. Exporting OTEL traces to http://localhost:4318/v1/traces and metrics to http://localhost:9000/v1/metrics.",
    );
  });

  it("omits OTEL text when no exporter is enabled", () => {
    expect(
      formatDiagnosticsDescription({
        localTracingEnabled: true,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
      }),
    ).toBe("Local trace file.");
  });
});

describe("buildProviderInstanceUpdatePatch", () => {
  it("promotes an edited default provider into providerInstances and resets the legacy provider", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        binaryPath: "/opt/t3/codex",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {
          ...DEFAULT_SERVER_SETTINGS.providers,
          codex: {
            ...DEFAULT_SERVER_SETTINGS.providers.codex,
            binaryPath: "/legacy/codex",
          },
        },
      },
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: true,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers?.codex).toEqual(DEFAULT_SERVER_SETTINGS.providers.codex);
  });

  it("updates custom instances without touching legacy provider settings", () => {
    const instanceId = ProviderInstanceId.make("codex_personal");
    const nextInstance = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: {
        homePath: "/Users/example/.codex-personal",
      },
    } satisfies ProviderInstanceConfig;

    const patch = buildProviderInstanceUpdatePatch({
      settings: DEFAULT_SERVER_SETTINGS,
      instanceId,
      instance: nextInstance,
      driver: ProviderDriverKind.make("codex"),
      isDefault: false,
    });

    expect(patch.providerInstances?.[instanceId]).toEqual(nextInstance);
    expect(patch.providers).toBeUndefined();
  });
});

describe("prepareWallpaperImage", () => {
  /**
   * Stands in for the browser, settling `decode()` the way a real one would for
   * the fixture at hand. Returns the sources it was asked about. Note there is
   * no `createImageBitmap` here: jsdom has none, so probing through it instead
   * would fail every one of these.
   */
  function stubImageDecoder(
    decodes: (source: string) => boolean,
    size: { width: number; height: number } = { width: 4, height: 4 },
  ): string[] {
    const probed: string[] = [];
    vi.stubGlobal(
      "Image",
      class {
        src = "";
        naturalWidth = size.width;
        naturalHeight = size.height;
        decode() {
          probed.push(this.src);
          return decodes(this.src)
            ? Promise.resolve()
            : Promise.reject(new Error("The image cannot be decoded."));
        }
      },
    );
    return probed;
  }

  /** A PNG signature and IHDR chunk — enough of a file to state its size. */
  function pngHeader(width: number, height: number) {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8, 13);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  }

  /** An ftyp box and a meta box holding one ispe — an AVIF's stated extent. */
  function avifHeader(width: number, height: number) {
    const bytes = new Uint8Array(48);
    const view = new DataView(bytes.buffer);
    const write = (offset: number, type: string, size: number) => {
      view.setUint32(offset, size);
      for (let index = 0; index < 4; index += 1) {
        bytes[offset + 4 + index] = type.charCodeAt(index);
      }
    };
    write(0, "ftyp", 16);
    bytes.set(
      [..."avifavif"].map((character) => character.charCodeAt(0)),
      8,
    );
    // meta is a full box, so four bytes of version and flags precede its children.
    write(16, "meta", 32);
    write(28, "ispe", 20);
    view.setUint32(40, width);
    view.setUint32(44, height);
    return bytes;
  }

  function base64Of(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes));
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a file past the source ceiling before reading it", async () => {
    const file = new File([new Uint8Array(8)], "huge.png", { type: "image/png" });
    Object.defineProperty(file, "size", { value: MAX_COMPRESSIBLE_SOURCE_BYTES + 1 });
    const read = vi.spyOn(file, "arrayBuffer");
    const probed = stubImageDecoder(() => true);

    expect(await prepareWallpaperImage(file)).toEqual({ ok: false, reason: "too-large" });
    // Reading it into a base64 string is the part that could take the tab down.
    expect(read).not.toHaveBeenCalled();
    expect(probed).toEqual([]);
  });

  it("rejects an under-budget file the browser cannot paint as an image", async () => {
    stubImageDecoder(() => false);

    expect(
      await prepareWallpaperImage(new File(["plain text"], "notes.png", { type: "image/png" })),
    ).toEqual({ ok: false, reason: "unreadable" });
  });

  it("stores an under-budget image verbatim once it decodes", async () => {
    const header = pngHeader(1920, 1080);
    const probed = stubImageDecoder(() => true);

    const result = await prepareWallpaperImage(
      new File([header], "shot.png", { type: "image/png" }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.dataUrl).toBe(`data:image/png;base64,${base64Of(header)}`);
    expect(probed).toEqual([`data:image/png;base64,${base64Of(header)}`]);
  });

  it("accepts a format beyond PNG once its header states a size it can hold", async () => {
    stubImageDecoder(() => true);

    const result = await prepareWallpaperImage(
      new File([avifHeader(4032, 3024)], "photo.avif", { type: "image/avif" }),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses a raster whose format it cannot measure, without decoding it", async () => {
    const probed = stubImageDecoder(() => true);

    // A container this cannot read could declare any size at all, and finding out
    // means decoding it — which is the cost the ceiling exists to refuse.
    expect(
      await prepareWallpaperImage(
        new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "exotic.img", {
          type: "image/exotic",
        }),
      ),
    ).toEqual({ ok: false, reason: "unreadable" });
    expect(probed).toEqual([]);
  });

  it("accepts an SVG, which a background paints and a bitmap decoder would refuse", async () => {
    stubImageDecoder((source) => source.startsWith("data:image/svg+xml;"));

    const result = await prepareWallpaperImage(
      new File(['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4" />'], "art.svg", {
        type: "image/svg+xml",
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
  });

  it("rejects a raster that decodes larger than its header claims", async () => {
    // The backstop: a header understating its image gets past the pre-decode
    // ceiling, and the size the browser reports still has to clear it.
    stubImageDecoder(() => true, { width: 16_384, height: 16_384 });

    expect(
      await prepareWallpaperImage(new File([pngHeader(8, 8)], "liar.png", { type: "image/png" })),
    ).toEqual({ ok: false, reason: "too-large" });
  });

  it("accepts a large-viewBox SVG, whose vector holds no raster to bound", async () => {
    stubImageDecoder((source) => source.startsWith("data:image/svg+xml;"), {
      width: 100_000,
      height: 100_000,
    });

    const result = await prepareWallpaperImage(
      new File(
        ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100000 100000" />'],
        "big.svg",
        {
          type: "image/svg+xml",
        },
      ),
    );

    expect(result.ok).toBe(true);
  });

  it("refuses an enormous raster from its header, without decoding it", async () => {
    const probed = stubImageDecoder(() => true);

    expect(
      await prepareWallpaperImage(
        new File([pngHeader(16_384, 16_384)], "uniform.png", { type: "image/png" }),
      ),
    ).toEqual({ ok: false, reason: "too-large" });
    // The decode is what would materialize the ~1 GB bitmap, so refusing after it
    // would be refusing too late.
    expect(probed).toEqual([]);
  });

  it("refuses an SVG that embeds an enormous raster", async () => {
    stubImageDecoder(() => true);
    const embedded = base64Of(pngHeader(16_384, 16_384));

    expect(
      await prepareWallpaperImage(
        new File(
          [
            `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8">` +
              `<image xlink:href="data:image/png;base64,${embedded}" width="8" height="8"/></svg>`,
          ],
          "wrapper.svg",
          { type: "image/svg+xml" },
        ),
      ),
    ).toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses an SVG that embeds an enormous raster without base64", async () => {
    // Percent-encoding is the other way a data URI carries bytes, and it hides
    // the raster from anything that only looks for `;base64,`.
    const embedded = [...pngHeader(16_384, 16_384)]
      .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
      .join("");
    stubImageDecoder(() => true);

    expect(
      await prepareWallpaperImage(
        new File(
          [
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">` +
              `<image href="data:image/png,${embedded}" width="8" height="8"/></svg>`,
          ],
          "encoded.svg",
          { type: "image/svg+xml" },
        ),
      ),
    ).toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses an SVG whose nested SVG embeds an enormous raster", async () => {
    const inner =
      `<svg xmlns="http://www.w3.org/2000/svg">` +
      `<image href="data:image/png;base64,${base64Of(pngHeader(16_384, 16_384))}"/></svg>`;
    stubImageDecoder(() => true);

    expect(
      await prepareWallpaperImage(
        new File(
          [
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">` +
              `<image href="data:image/svg+xml;base64,${btoa(inner)}"/></svg>`,
          ],
          "nested.svg",
          { type: "image/svg+xml" },
        ),
      ),
    ).toEqual({ ok: false, reason: "too-large" });
  });

  it("refuses an SVG embedding a raster it cannot measure", async () => {
    stubImageDecoder(() => true);

    expect(
      await prepareWallpaperImage(
        new File(
          [
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">` +
              `<image href="data:image/exotic;base64,${base64Of(new Uint8Array([1, 2, 3, 4]))}"/></svg>`,
          ],
          "opaque.svg",
          { type: "image/svg+xml" },
        ),
      ),
    ).toEqual({ ok: false, reason: "unreadable" });
  });

  it("keeps an SVG that embeds a raster small enough to hold", async () => {
    stubImageDecoder(() => true);
    const embedded = base64Of(pngHeader(64, 64));

    const result = await prepareWallpaperImage(
      new File(
        [
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
            `<image href="data:image/png;base64,${embedded}" width="64" height="64"/></svg>`,
        ],
        "logo.svg",
        { type: "image/svg+xml" },
      ),
    );

    expect(result.ok).toBe(true);
  });
});
