import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

// Conn fork guard: an upstream merge must not silently drop the fork's
// vendored-package patches or the screens that rely on them. See FORK.md,
// "Vendored dependency patches".
const mobileRoot = NodePath.join(import.meta.dirname, "../..");
const read = (path: string) => NodeFS.readFileSync(NodePath.join(mobileRoot, path), "utf8");

describe("Conn react-native-screens patch", () => {
  it("installs the patched tarball built by scripts/build-conn-vendored-tarball.ts", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["react-native-screens"]).toMatch(
      /^file:deps\/react-native-screens-.+-conn\.tgz$/,
    );
  });

  it("ships the search field accessory in the installed package", () => {
    const require = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
    const packageDir = NodePath.dirname(require.resolve("react-native-screens/package.json"));
    const coordinator = NodeFS.readFileSync(
      NodePath.join(packageDir, "ios/header/RNSHeaderCoordinator.mm"),
      "utf8",
    );
    const spec = NodeFS.readFileSync(
      NodePath.join(packageDir, "src/fabric/header/HeaderItemIOSNativeComponent.ts"),
      "utf8",
    );
    expect(coordinator).toContain("applySearchFieldAccessoryForItem");
    expect(spec).toContain("searchFieldAccessory");
  });

  it("keeps the home filter inside the bottom search field", () => {
    // Upstream moved the iOS thread list into the workspace; the phone bar owns its search.
    expect(read("src/features/home/HomeHeader.tsx")).toContain("<WorkspacePhoneBar filterMenu=");
    expect(read("src/features/layout/workspace/WorkspacePhoneBar.tsx")).toContain(
      "filterInsideSearch: true",
    );
    expect(read("src/native/V5StackHeader.ios.tsx")).toContain("searchFieldAccessory:");
  });
});

describe("Conn react-native-enriched-markdown patch", () => {
  it("installs the patched tarball built by scripts/build-conn-vendored-tarball.ts", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(manifest.dependencies["react-native-enriched-markdown"]).toMatch(
      /^file:deps\/react-native-enriched-markdown-.+-conn\.tgz$/,
    );
  });

  it("sizes list markers per list in the installed package", () => {
    const require = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));
    const packageDir = NodePath.dirname(
      require.resolve("react-native-enriched-markdown/package.json"),
    );
    const renderer = NodeFS.readFileSync(
      NodePath.join(packageDir, "ios/renderer/ListRenderer.m"),
      "utf8",
    );
    expect(renderer).toContain("context.listMarkerWidth");
  });
});

describe("Conn symbols", () => {
  it("ships a generated symbol for every SF name in the icon set", () => {
    const names = Object.keys(
      (
        JSON.parse(read("../../assets/conn/superheroicons/manifest.json")) as {
          sf: Record<string, string>;
        }
      ).sf,
    );
    const generated = read("modules/conn-symbols/ios/ConnSymbolNames.swift");
    for (const name of names) {
      expect(generated).toContain(`"${name}",`);
      expect(
        NodeFS.existsSync(
          NodePath.join(
            mobileRoot,
            `modules/conn-symbols/ios/ConnSymbols.xcassets/${name}.symbolset`,
          ),
        ),
      ).toBe(true);
    }
  });

  it("sends every iOS icon through expo-symbols", () => {
    expect(read("src/components/ui/AppSymbol.tsx")).not.toContain("@tabler/icons-react-native");
  });
});
