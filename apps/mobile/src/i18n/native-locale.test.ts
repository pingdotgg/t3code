import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { gtFallback } from "gt-react-native";
import { expect, it } from "vite-plus/test";

import ruCatalog from "./translations/ru.json";

it("uses the new Android locale before native storage finishes writing it", () => {
  // Load the real GT store in a subprocess because mobile's Vite config replaces GT.
  const output = NodeChildProcess.execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import { createRequire, registerHooks } from "node:module";
        import { pathToFileURL } from "node:url";

        const require = createRequire(process.cwd() + "/package.json");
        const gtEntry = pathToFileURL(require.resolve("gt-react-native"));
        const androidBridge = "data:text/javascript," + encodeURIComponent(\`
          const preferences = new Map();
          export const pending = [];
          export const Platform = { OS: "android" };
          export const TurboModuleRegistry = {
            getEnforcing: () => ({
              getNativeLocales: () => ["en-US"],
              nativeStoreGet: (key) => preferences.get(key) ?? null,
              nativeStoreSet: (key, value) => {
                pending.push(() => preferences.set(key, value));
              },
            }),
          };
        \`);
        const hooks = registerHooks({
          resolve(specifier, context, nextResolve) {
            return specifier === "react-native"
              ? { url: androidBridge, shortCircuit: true }
              : nextResolve(specifier, context);
          },
        });
        const { initializeGT } = await import(new URL("./setup/initializeGT.js", gtEntry));
        const { NativeConditionStore } = await import(
          new URL("./condition-store/NativeConditionStore.js", gtEntry)
        );
        const { pending } = await import(androidBridge);
        hooks.deregister();

        initializeGT({ defaultLocale: "en", locales: ["en", "zh"] });
        new NativeConditionStore({ locale: "en" });
        for (const apply of pending.splice(0)) apply();
        console.log(new NativeConditionStore({ locale: "zh" }).getLocale());
      `,
    ],
    { cwd: NodeURL.fileURLToPath(new URL("../../", import.meta.url)), encoding: "utf8" },
  );
  expect(output.trim()).toBe("zh");
});

it("formats Russian force-stop shared-process alert with plural instruction for 21 threads", () => {
  const format = (count: number) =>
    gtFallback(ruCatalog["72e41eb83e88cefa"], { count, $locale: "ru" });
  expect(format(0)).toBe(
    "Он используется другими работающими тредами. Остановите их, чтобы освободить его.",
  );
  expect(format(1)).toBe("Он используется 1 работающим тредом. Остановите его, чтобы освободить.");
  expect(format(2)).toBe(
    "Он используется 2 работающими тредами. Остановите их, чтобы освободить его.",
  );
  expect(format(21)).toBe(
    "Он используется 21 работающим тредом. Остановите их, чтобы освободить его.",
  );
});
