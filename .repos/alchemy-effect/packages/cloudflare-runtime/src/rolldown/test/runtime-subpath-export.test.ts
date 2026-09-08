import { RuntimeSubpathExportPlugin } from "../../internal/build-tools/RuntimeSubpathExportPlugin.ts";
import { describe, expect, it } from "vitest";

describe("runtime subpath exports", () => {
  it.each([
    [
      "POSIX",
      "../core/index.ts",
      "/workspace/packages/cloudflare-runtime/src/vite/plugin.ts",
      "@alchemy.run/cloudflare-runtime/core",
    ],
    [
      "Windows",
      "..\\rolldown\\options.ts",
      "D:\\a\\alchemy\\alchemy\\packages\\cloudflare-runtime\\src\\vite\\plugin.ts",
      "@alchemy.run/cloudflare-runtime/rolldown/options",
    ],
  ])(
    "maps %s relative imports to public package exports",
    (_, source, importer, expected) => {
      const resolveId = RuntimeSubpathExportPlugin().resolveId;
      expect(resolveId).toBeTypeOf("function");
      if (typeof resolveId !== "function") {
        return;
      }

      expect(
        resolveId.call({} as never, source, importer, {} as never),
      ).toEqual({
        id: expected,
        external: true,
      });
    },
  );
});
