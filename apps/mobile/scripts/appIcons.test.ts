import { describe, expect, it } from "vite-plus/test";
import type { AndroidConfig } from "expo/config-plugins";
import { configureLauncherAliases } from "../plugins/withAppIcons.cjs";
import { writeIconPng, writeIosIconProject } from "../plugins/lib/appIconAssets.cjs";
import catalog from "../assets/app-icons/catalog.json";
import sharp from "sharp";
import * as NodeURL from "node:url";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

describe("bundled app icons", () => {
  it("keeps the real activity and deep links enabled with exactly one default launcher", () => {
    const deepLink = {
      action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
      category: [{ $: { "android:name": "android.intent.category.BROWSABLE" } }],
      data: [{ $: { "android:scheme": "t3code" } }],
    };
    const activity = {
      $: { "android:name": ".MainActivity", "android:exported": "true" },
      "intent-filter": [
        {
          action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
          category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }],
        },
        deepLink,
      ],
    };
    const manifest = configureLauncherAliases({ application: [{ activity: [activity] }] });
    const application = manifest.application[0];
    expect(application.activity[0].$).toEqual({
      "android:name": ".MainActivity",
      "android:exported": "true",
    });
    expect(application.activity[0]["intent-filter"]).toEqual([deepLink]);
    const aliases: AndroidConfig.Manifest.ManifestActivityAlias[] = application["activity-alias"];
    expect(aliases).toHaveLength(6);
    expect(aliases.filter((alias) => alias.$?.["android:enabled"] === "true")).toHaveLength(1);
    expect(aliases.map((alias) => alias["meta-data"]?.[0]?.$["android:value"])).toEqual(
      Object.keys(catalog),
    );
    expect(aliases.every((alias) => alias.$?.["android:targetActivity"] === ".MainActivity")).toBe(
      true,
    );
    configureLauncherAliases(manifest);
    expect(application["activity-alias"]).toHaveLength(6);
  });

  it("exports opaque launcher images and transparent Android foregrounds from the approved artwork", async () => {
    const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-app-icons-"));
    try {
      for (const id of Object.keys(catalog)) {
        const completePath = NodePath.join(directory, `${id}.png`);
        const foregroundPath = NodePath.join(directory, `${id}-foreground.png`);
        await writeIconPng(root, id, completePath, 1024);
        await writeIconPng(root, id, foregroundPath, 432, "foreground");
        expect((await sharp(completePath).metadata()).hasAlpha).toBe(false);
        const foreground = await sharp(foregroundPath).stats();
        expect(foreground.isOpaque).toBe(false);
        expect(foreground.channels[3]?.max).toBeGreaterThan(0);
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });

  it("preserves the production Icon Composer layers and effects in every iOS variant", async () => {
    const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
    const source = NodePath.resolve(root, "../../assets/prod/app-icon.icon");
    const original = JSON.parse(await NodeFSP.readFile(NodePath.join(source, "icon.json"), "utf8"));
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-composer-icons-"));
    try {
      for (const id of Object.keys(catalog)) {
        const destination = NodePath.join(directory, `${id}.icon`);
        await writeIosIconProject(root, id, destination);
        const document = JSON.parse(
          await NodeFSP.readFile(NodePath.join(destination, "icon.json"), "utf8"),
        );
        expect({ ...document, fill: original.fill }).toEqual(original);
        if (id === "t3-code") expect(document).toEqual(original);
        else expect(document.fill).not.toEqual(original.fill);
        for (const asset of await NodeFSP.readdir(NodePath.join(source, "Assets"))) {
          expect(await NodeFSP.readFile(NodePath.join(destination, "Assets", asset))).toEqual(
            await NodeFSP.readFile(NodePath.join(source, "Assets", asset)),
          );
        }
      }
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
});
