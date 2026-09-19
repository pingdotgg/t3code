const fs = require("node:fs/promises");
const path = require("node:path");
const {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
  withAndroidManifest,
} = require("expo/config-plugins");
const { catalog, iconName, writeIconPng, writeIosIconProject } = require("./lib/appIconAssets.cjs");

const ids = Object.keys(catalog);
const alternates = ids.filter((id) => id !== "t3-code");

/** Move only the launcher filter to aliases; the real activity remains enabled for all entry paths. */
function configureLauncherAliases(manifest) {
  const application = manifest.application[0];
  const activity = application.activity.find(
    (entry) => entry.$["android:name"] === ".MainActivity",
  );
  if (!activity) throw new Error("withAppIcons: MainActivity is missing.");
  activity["intent-filter"] = (activity["intent-filter"] ?? []).filter(
    (filter) =>
      !filter.category?.some(
        (category) => category.$["android:name"] === "android.intent.category.LAUNCHER",
      ),
  );
  const aliases = application["activity-alias"] ?? [];
  application["activity-alias"] = [
    ...aliases.filter(
      (alias) => !alias["meta-data"]?.some((entry) => entry.$["android:name"] === "t3.appIcon"),
    ),
    ...ids.map((id) => ({
      $: {
        "android:name": `.${iconName(id)}`,
        "android:targetActivity": ".MainActivity",
        "android:enabled": id === "t3-code" ? "true" : "false",
        "android:exported": "true",
        "android:icon":
          id === "t3-code" ? "@mipmap/ic_launcher" : `@mipmap/${iconName(id).toLowerCase()}`,
      },
      "meta-data": [{ $: { "android:name": "t3.appIcon", "android:value": id } }],
      "intent-filter": [
        {
          action: [{ $: { "android:name": "android.intent.action.MAIN" } }],
          category: [{ $: { "android:name": "android.intent.category.LAUNCHER" } }],
        },
      ],
    })),
  ];
  return manifest;
}

function withAppIcons(config) {
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.T3AppIcons = Object.fromEntries(
      ids.map((id) => [id, id === "t3-code" ? "" : iconName(id)]),
    );
    return cfg;
  });
  config = withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const target = IOSConfig.XcodeUtils.getApplicationNativeTarget({
      project,
      projectName: cfg.modRequest.projectName,
    });
    const configurations =
      project.pbxXCConfigurationList()[target.target.buildConfigurationList].buildConfigurations;
    for (const { value } of configurations) {
      const settings = project.pbxXCBuildConfigurationSection()[value].buildSettings;
      settings.ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = `"${alternates.map(iconName).join(" ")}"`;
      settings.ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = "YES";
    }
    for (const id of alternates) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath: `${cfg.modRequest.projectName}/${iconName(id)}.icon`,
        groupName: cfg.modRequest.projectName,
        project,
        isBuildFile: true,
      });
    }
    return cfg;
  });
  config = withDangerousMod(config, [
    "ios",
    async (cfg) => {
      const name = IOSConfig.XcodeUtils.getProjectName(cfg.modRequest.projectRoot);
      for (const id of alternates) {
        const directory = path.join(
          cfg.modRequest.platformProjectRoot,
          name,
          `${iconName(id)}.icon`,
        );
        await writeIosIconProject(cfg.modRequest.projectRoot, id, directory);
        // Remove this plugin's old flattened sets when reusing a generated project.
        await fs.rm(
          path.join(
            cfg.modRequest.platformProjectRoot,
            name,
            "Images.xcassets",
            `${iconName(id)}.appiconset`,
          ),
          { recursive: true, force: true },
        );
      }
      return cfg;
    },
  ]);
  config = withAndroidManifest(config, (cfg) => {
    configureLauncherAliases(cfg.modResults.manifest);
    return cfg;
  });
  return withDangerousMod(config, [
    "android",
    async (cfg) => {
      const res = path.join(cfg.modRequest.platformProjectRoot, "app/src/main/res");
      await fs.mkdir(path.join(res, "drawable-nodpi"), { recursive: true });
      await fs.copyFile(
        path.join(cfg.modRequest.projectRoot, "assets/android-icon-mark.png"),
        path.join(res, "drawable-nodpi/t3_app_icon_monochrome.png"),
      );
      for (const id of alternates) {
        const name = iconName(id).toLowerCase();
        for (const [density, size] of Object.entries({
          mdpi: 48,
          hdpi: 72,
          xhdpi: 96,
          xxhdpi: 144,
          xxxhdpi: 192,
        })) {
          await writeIconPng(
            cfg.modRequest.projectRoot,
            id,
            path.join(res, `mipmap-${density}`, `${name}.png`),
            size,
          );
        }
        await writeIconPng(
          cfg.modRequest.projectRoot,
          id,
          path.join(res, "drawable-nodpi", `${name}_foreground.png`),
          432,
          "foreground",
        );
        await writeIconPng(
          cfg.modRequest.projectRoot,
          id,
          path.join(res, "drawable-nodpi", `${name}_background.png`),
          432,
          "background",
        );
        const directory = path.join(res, "mipmap-anydpi-v26");
        await fs.mkdir(directory, { recursive: true });
        await fs.writeFile(
          path.join(directory, `${name}.xml`),
          `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@drawable/${name}_background"/><foreground android:drawable="@drawable/${name}_foreground"/><monochrome android:drawable="@drawable/t3_app_icon_monochrome"/></adaptive-icon>`,
        );
      }
      return cfg;
    },
  ]);
}
module.exports = Object.assign(withAppIcons, { configureLauncherAliases });
