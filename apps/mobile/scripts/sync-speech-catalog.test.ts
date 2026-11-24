// @effect-diagnostics nodeBuiltinImport:off - compares the checked-in Swift catalog byte for byte.
import * as NodeFS from "node:fs";
import { expect, it } from "vite-plus/test";

import { renderIosSpeechCatalog, swiftCatalogPath } from "./sync-speech-catalog.mts";

it("pins the on-device catalog to the desktop artifacts", () => {
  const checkedIn = NodeFS.readFileSync(new URL(swiftCatalogPath, import.meta.url), "utf8");
  expect(checkedIn).toBe(renderIosSpeechCatalog());
});
