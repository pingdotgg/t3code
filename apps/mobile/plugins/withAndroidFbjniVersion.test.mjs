import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { describe, expect, it } from "vitest";
import withAndroidFbjniVersion from "./withAndroidFbjniVersion.cjs";

const buildGradle = `buildscript {
  repositories {
    google()
    mavenCentral()
  }
}

allprojects {
  repositories {
    google()
    mavenCentral()
  }
}
`;

async function transform(contents, language = "groovy") {
  const config = withAndroidFbjniVersion({ name: "Test", slug: "test" });
  const result = await config.mods.android.projectBuildGradle({
    ...config,
    modRequest: { platform: "android", modName: "projectBuildGradle", introspect: false },
    modResults: { language, contents },
  });
  return result.modResults.contents;
}

describe("Android fbjni version generation", () => {
  it("forces the React Native fbjni version and stays idempotent", async () => {
    const generated = await transform(buildGradle);

    expect(generated).toContain(
      "resolutionStrategy.force 'com.facebook.fbjni:fbjni:0.7.0'",
    );
    expect(await transform(generated)).toBe(generated);
  });


  it("keeps the forced native library aligned with the installed React Native runtime", async () => {
    const require = NodeModule.createRequire(import.meta.url);
    const reactNativeRoot = NodePath.dirname(require.resolve("react-native/package.json"));
    const versions = NodeFS.readFileSync(
      NodePath.join(reactNativeRoot, "gradle/libs.versions.toml"),
      "utf8",
    );
    const reactNativeFbjni = versions.match(/^fbjni\s*=\s*"([^"]+)"/m)?.[1];
    expect(reactNativeFbjni).toBeDefined();

    const generated = await transform(buildGradle);
    const forcedFbjni = generated.match(
      /resolutionStrategy\.force 'com\.facebook\.fbjni:fbjni:([^']+)'/,
    )?.[1];
    expect(forcedFbjni).toBe(reactNativeFbjni);
  });

  it("fails visibly if Expo switches the project build file away from Groovy", async () => {
    await expect(transform(buildGradle, "kotlin")).rejects.toThrow(
      "project build.gradle must use Groovy",
    );
  });
});
