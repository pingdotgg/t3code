import * as NodeURL from "node:url";
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

// Release builds render these for the configured signing team; the checked-in file is the dev default.
const APP_INTENTS_EXTENSION_ENTITLEMENTS =
  process.env.T3CODE_APP_INTENTS_ENTITLEMENTS ??
  NodeURL.fileURLToPath(
    new URL(
      "../native/apple-intents/macos/Extension/T3AppIntentsExtension.entitlements",
      import.meta.url,
    ),
  );

export default async function sign(options: SignOptions): Promise<void> {
  const previousOptionsForFile = options.optionsForFile;
  await signApplication({
    ...options,
    batchCodesignCalls: true,
    optionsForFile: (filePath, entitlements) => {
      const normalized = filePath.replaceAll("\\", "/");
      if (
        normalized.endsWith("/T3AppIntentsExtension.appex") ||
        normalized.includes("/T3AppIntentsExtension.appex/")
      ) {
        return {
          entitlements: APP_INTENTS_EXTENSION_ENTITLEMENTS,
          hardenedRuntime: true,
        };
      }
      return previousOptionsForFile ? previousOptionsForFile(filePath, entitlements) : {};
    },
  });
}
