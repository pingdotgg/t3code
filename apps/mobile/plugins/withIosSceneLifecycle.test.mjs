import { describe, expect, it } from "vitest";
import withIosSceneLifecycle from "./withIosSceneLifecycle.cjs";

const appDelegate = `class AppDelegate: ExpoAppDelegate {
  var window: UIWindow?
  func application() {
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
  }
}`;

async function transform(contents) {
  const config = withIosSceneLifecycle({ name: "Test", slug: "test" });
  const result = await config.mods.ios.appDelegate({
    ...config,
    modRequest: { platform: "ios", modName: "appDelegate", introspect: false },
    modResults: { language: "swift", contents },
  });
  return result.modResults.contents;
}

describe("iOS scene lifecycle generation", () => {
  it("creates the window in the scene before starting React Native and retains launch options", async () => {
    const result = await transform(appDelegate);
    const [startup, scene] = result.split("class SceneDelegate:");
    expect(startup).not.toContain("UIWindow(frame:");
    expect(startup).not.toContain("startReactNative(");
    expect(startup).toContain("sceneLaunchOptions = launchOptions");
    expect(scene.indexOf("UIWindow(windowScene: windowScene)")).toBeLessThan(
      scene.indexOf("startReactNative("),
    );
    expect(scene).toContain("launchOptions: appDelegate.sceneLaunchOptions)");
    expect(scene).toContain("appDelegate.sceneLaunchOptions = nil");
  });

  it("does not duplicate startup or scene code on subsequent prebuilds", async () => {
    const generated = await transform(appDelegate);
    expect(await transform(generated)).toBe(generated);
  });

  it("updates the previously generated scene delegate", async () => {
    const generated = await transform(appDelegate);
    const oldScene = generated
      .slice(generated.indexOf("class SceneDelegate:"))
      .replace("launchOptions: appDelegate.sceneLaunchOptions)", "launchOptions: nil)")
      .replace("      appDelegate.sceneLaunchOptions = nil\n", "");
    expect(await transform(`${appDelegate}\n\n${oldScene}`)).toBe(generated);
  });

  it("fails visibly when the Expo startup template changes", async () => {
    await expect(transform("class AppDelegate: ExpoAppDelegate {}")).rejects.toThrow(
      "Could not move React Native startup",
    );
  });
});
