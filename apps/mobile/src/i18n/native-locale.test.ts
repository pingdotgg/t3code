import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

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
