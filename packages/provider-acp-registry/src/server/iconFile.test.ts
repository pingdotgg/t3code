import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ACP_REGISTRY_ICON_FILE_MAX_BYTES,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "../settings.ts";
import { buildCheckedAcpRegistrySnapshot, readAcpRegistryIconFile } from "./driver.ts";

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`;
const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

const writeIcon = Effect.fn(function* (name: string, contents: string | Uint8Array) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  const file = path.join(dir, name);
  yield* typeof contents === "string"
    ? fs.writeFileString(file, contents)
    : fs.writeFile(file, contents);
  return file;
});

it.layer(NodeServices.layer)("ACP instance icon file", (it) => {
  it.effect("inlines an SVG so local instances show it in every client", () =>
    Effect.gen(function* () {
      const iconPath = yield* writeIcon("agent.svg", SVG);
      const iconFileUrl = yield* readAcpRegistryIconFile(iconPath);
      assert.strictEqual(
        iconFileUrl,
        `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}`,
      );

      const provider = buildCheckedAcpRegistrySnapshot({
        instanceId: ProviderInstanceId.make("steed"),
        displayName: "Steed",
        accentColor: undefined,
        continuationKey: "acpRegistry:instance:steed",
        iconFileUrl,
        settings: decodeSettings({ source: "local", commandPath: "steed-acp", iconPath }),
        checkedAt: "2026-10-31T00:00:00.000Z",
        inspection: { status: "failed", message: "not checked" },
      });
      assert.strictEqual(provider.iconUrl, iconFileUrl);
      // The snapshot still fits the wire contract with the inline icon.
      assert.strictEqual(decodeServerProvider(provider).iconUrl, iconFileUrl);
    }),
  );

  it.effect("inlines a PNG", () =>
    Effect.gen(function* () {
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const iconFileUrl = yield* readAcpRegistryIconFile(yield* writeIcon("agent.PNG", png));
      assert.strictEqual(iconFileUrl, "data:image/png;base64,iVBORw0KGgo=");
    }),
  );

  it.effect("ignores missing, relative, oversized, and unsupported files", () =>
    Effect.gen(function* () {
      assert.isNull(yield* readAcpRegistryIconFile(""));
      assert.isNull(yield* readAcpRegistryIconFile("/does/not/exist/agent.svg"));
      assert.isNull(yield* readAcpRegistryIconFile("agent.svg"));
      assert.isNull(yield* readAcpRegistryIconFile(yield* writeIcon("agent.jpg", "jpeg")));
      const oversized = `<svg>${" ".repeat(ACP_REGISTRY_ICON_FILE_MAX_BYTES)}</svg>`;
      assert.isNull(yield* readAcpRegistryIconFile(yield* writeIcon("big.svg", oversized)));
    }),
  );
});
