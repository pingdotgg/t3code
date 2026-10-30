import { describe, expect, it } from "vite-plus/test";
import {
  formatNativeAppMention,
  parseNativeAppMention,
  collectNativeAppMentions,
  projectNativeAppMentions,
} from "./nativeAppMentions.ts";
import { projectComposerContextForProvider } from "./composerContextReferences.ts";

describe("native application mentions", () => {
  it.each([
    { name: "Helium", bundleId: "net.imput.helium", launchPath: "/Applications/Helium.app" },
    {
      name: "Calculator",
      bundleId: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
      launchPath: "shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
    },
    {
      name: "Helium Browser",
      bundleId: "helium.desktop",
      launchPath: "/usr/share/applications/helium.desktop",
    },
  ])("round-trips $name with its host identity", (app) => {
    const text = formatNativeAppMention(app, "desktop");
    const mentions = collectNativeAppMentions(`Use ${text} please`);
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({ app, environmentId: "desktop" });
    expect(parseNativeAppMention(mentions[0]!.href)?.app).toEqual(app);
    const projected = projectComposerContextForProvider({ text, records: [] });
    expect(projected).toContain(`bundle_id: ${app.bundleId}`);
    expect(projected).toContain("environment: desktop");
    expect(projected).not.toContain("t3-app://");
  });
  it("keeps malformed and unrelated links unchanged", () => {
    expect(parseNativeAppMention("https://example.com")).toBeNull();
    expect(parseNativeAppMention("t3-app://v1?name=Helium")).toBeNull();
    expect(projectNativeAppMentions("[bad](t3-app://v1?name=)")).toBe("[bad](t3-app://v1?name=)");
  });
  it("preserves paths containing spaces and Markdown punctuation", () => {
    const app = { name: "Example", launchPath: "C:\\Apps\\Example (Dev)\\app.exe" };
    expect(collectNativeAppMentions(formatNativeAppMention(app, "host"))[0]?.app).toEqual(app);
  });
});
