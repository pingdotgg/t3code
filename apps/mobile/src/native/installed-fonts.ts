import { requireOptionalNativeModule } from "expo";
import { Platform } from "react-native";
import type { InstalledMobileFont } from "../lib/mobileFonts";

const nativeControls = requireOptionalNativeModule<{
  pickInstalledFont?: (selectedName: string | null) => Promise<InstalledMobileFont | null>;
  resolveInstalledFonts?: (names: readonly string[]) => Promise<InstalledMobileFont[]>;
}>("T3NativeControls");

export const canPickInstalledFont =
  Platform.OS === "ios" && typeof nativeControls?.pickInstalledFont === "function";

// CoreText can show a system dialog for missing fonts, including on foreground refresh.
const missingFontNames = new Set<string>();
const pendingResolutions = new Map<string, Promise<InstalledMobileFont | undefined>>();

export async function pickInstalledFont(selectedName: string | null) {
  if (!canPickInstalledFont || !nativeControls?.pickInstalledFont)
    throw new Error("Installed font selection requires an updated iOS app.");
  const font = await nativeControls.pickInstalledFont(selectedName);
  if (font) {
    missingFontNames.delete(font.name);
    pendingResolutions.delete(font.name);
  }
  return font;
}

export async function resolveInstalledFonts(names: readonly string[]) {
  if (!names.length || !nativeControls?.resolveInstalledFonts) return [];
  const requestedNames = [...new Set(names)].filter(
    (name) => !missingFontNames.has(name) && !pendingResolutions.has(name),
  );
  if (requestedNames.length) {
    const request = nativeControls.resolveInstalledFonts(requestedNames);
    for (const name of requestedNames) {
      const resolution = request
        .then((fonts) => {
          const font = fonts.find((candidate) => candidate.name === name);
          if (!font && pendingResolutions.get(name) === resolution) missingFontNames.add(name);
          return font;
        })
        .finally(() => {
          if (pendingResolutions.get(name) === resolution) pendingResolutions.delete(name);
        });
      pendingResolutions.set(name, resolution);
    }
  }
  const resolved = await Promise.all(
    [...new Set(names)].map((name) => pendingResolutions.get(name)),
  );
  return resolved.filter((font) => font !== undefined);
}
