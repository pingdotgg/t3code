// @effect-diagnostics nodeBuiltinImport:off -- Verifies the published SDK against the server's canonical schemas.
import * as NodeFSP from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { generateExtensionHostApi } from "../../scripts/extensionHostApi.ts";

it("keeps the standalone SDK service types in sync with the server", async () => {
  const generated = await NodeFSP.readFile(
    new URL("../../../../packages/extension-sdk/src/hostApi.generated.ts", import.meta.url),
    "utf8",
  );
  expect(generated).toBe(await generateExtensionHostApi());
});
