import { AndroidConfig, XML, type ExportedConfig } from "expo/config-plugins";
import { describe, expect, it } from "vite-plus/test";

import withAndroidTabletOrientation from "./withAndroidTabletOrientation.cjs";

const MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:name=".MainApplication">
    <activity android:name=".MainActivity" android:configChanges="keyboard|keyboardHidden|orientation|screenSize|screenLayout|uiMode|smallestScreenSize" android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>`;

// Trimmed from the MainActivity.kt that `expo prebuild` generates for this app.
const MAIN_ACTIVITY = `package com.t3tools.t3code

import android.os.Build
import android.os.Bundle

import com.facebook.react.ReactActivity

class MainActivity : ReactActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    // setTheme(R.style.AppTheme);
    super.onCreate(null)
  }

  override fun getMainComponentName(): String = "main"
}
`;

function modRequest(modName: string) {
  return {
    platform: "android" as const,
    modName,
    projectRoot: "/project",
    platformProjectRoot: "/project/android",
    introspect: false,
  };
}

// Registers Expo's built-in orientation plugin after this one, as prebuild does
// for every app plugin. Same-type mods run last-registered-first, so the
// manifest mod sees the lock that `orientation: "portrait"` writes.
function prebuildConfig(): ExportedConfig {
  const config = withAndroidTabletOrientation({
    name: "T3 Code",
    slug: "t3code",
    orientation: "portrait",
  });
  return AndroidConfig.Orientation.withOrientation(config);
}

async function runManifestMod(config: ExportedConfig) {
  const result = await config.mods!.android!.manifest!({
    ...config,
    modResults: (await XML.parseXMLAsync(MANIFEST)) as AndroidConfig.Manifest.AndroidManifest,
    modRequest: modRequest("manifest"),
    modRawConfig: config,
  });
  return AndroidConfig.Manifest.getMainActivityOrThrow(result.modResults);
}

async function runMainActivityMod(config: ExportedConfig, contents: string) {
  const result = await config.mods!.android!.mainActivity!({
    ...config,
    modResults: { contents, language: "kt", path: "/project/MainActivity.kt" },
    modRequest: modRequest("mainActivity"),
    modRawConfig: config,
  });
  return result.modResults.contents;
}

function count(haystack: string, needle: string) {
  return haystack.split(needle).length - 1;
}

describe("withAndroidTabletOrientation", () => {
  it("leaves MainActivity without a manifest orientation lock", async () => {
    const mainActivity = await runManifestMod(prebuildConfig());

    expect(mainActivity.$["android:screenOrientation"]).toBeUndefined();
    // Rotation and fold/unfold must keep reaching onConfigurationChanged
    // instead of recreating the activity.
    expect(mainActivity.$["android:configChanges"]?.split("|")).toEqual(
      expect.arrayContaining(["orientation", "screenSize", "smallestScreenSize"]),
    );
  });

  it("requests the orientation before super.onCreate", async () => {
    const contents = await runMainActivityMod(prebuildConfig(), MAIN_ACTIVITY);

    const onCreate = contents.slice(contents.indexOf("override fun onCreate"));
    expect(onCreate.indexOf("applyTabletOrientation()")).toBeLessThan(
      onCreate.indexOf("super.onCreate(null)"),
    );
    expect(contents).toContain("    applyTabletOrientation()\n    super.onCreate(null)");
    expect(count(contents, "import android.content.pm.ActivityInfo")).toBe(1);
    expect(count(contents, "import android.content.res.Configuration")).toBe(1);
    expect(count(contents, "override fun onConfigurationChanged")).toBe(1);
    expect(count(contents, "private fun applyTabletOrientation")).toBe(1);
  });

  it("leaves an already patched MainActivity unchanged", async () => {
    const once = await runMainActivityMod(prebuildConfig(), MAIN_ACTIVITY);
    const twice = await runMainActivityMod(prebuildConfig(), once);

    expect(twice).toBe(once);
  });

  it("fails loudly when the template no longer calls super.onCreate(null)", async () => {
    await expect(
      runMainActivityMod(
        prebuildConfig(),
        MAIN_ACTIVITY.replace("super.onCreate(null)", "super.onCreate(savedInstanceState)"),
      ),
    ).rejects.toThrow("could not find the super.onCreate call");
  });
});
