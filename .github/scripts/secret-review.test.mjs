import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeTest from "node:test";

import { protectedPaths, touchesSecrets } from "./secret-review.mjs";

const rules = protectedPaths(
  NodeFS.readFileSync(new URL("../CODEOWNERS", import.meta.url), "utf8"),
);

NodeTest.test("matches credential paths even if the file has been renamed away", () => {
  for (const filename of [
    "apps/server/src/auth/ServerSecretStore.ts",
    "apps/server/src/serverSettings.ts",
    "apps/server/src/connections/OAuthBroker.ts",
    "packages/secret-provider-proton/src/server/driver.ts",
    ".github/workflows/secret-review.yml",
  ]) {
    NodeAssert.ok(touchesSecrets([{ filename }], rules), filename);
  }
  NodeAssert.ok(touchesSecrets([{ filename: "new.ts", previous_filename: "Vault.ts" }], rules));
  NodeAssert.equal(
    touchesSecrets([{ filename: "apps/web/src/components/Sidebar.tsx" }], rules),
    false,
  );
});
