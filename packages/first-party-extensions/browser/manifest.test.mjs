import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";
import { build } from "esbuild";

import {
  BROWSER_PROFILES,
  BROWSER_SURFACE_REQUIRED_GRANTS,
  BROWSER_RECORDING_REQUIRED_GRANTS,
  BROWSER_CAPTURE_ARTIFACT_ACTIONS,
  API_CALL_TIME_GRANTS,
  GENERIC_API_CATALOGUE,
} from "@t3tools/extension-sdk/catalogue";
import { EXTENSION_GRANT_CAPABILITIES_MAX } from "@t3tools/contracts";
import { satisfiesSemverRange } from "@t3tools/shared/semver";

let manifest;
NodeTest.before(async () => {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-manifest-"));
  const definition = NodePath.join(dir, "definition.mjs");
  try {
    await build({
      entryPoints: [NodeURL.fileURLToPath(new URL("./extension.ts", import.meta.url))],
      outfile: definition,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
    });
    manifest = (await import(NodeURL.pathToFileURL(definition).href)).default.package;
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});

NodeTest.test("the Browser pack declares the profiles API it consumes", () => {
  NodeAssert.ok(manifest.requires.some((requirement) => requirement.id === BROWSER_PROFILES));
});

NodeTest.test(
  "the Browser pack's full capability grant set fits the installation cap",
  (testContext) => {
    const grants = new Set([
      ...BROWSER_SURFACE_REQUIRED_GRANTS,
      ...BROWSER_RECORDING_REQUIRED_GRANTS,
      BROWSER_CAPTURE_ARTIFACT_ACTIONS,
    ]);
    for (const requirement of manifest.requires) {
      for (const api of GENERIC_API_CATALOGUE.filter(
        (api) =>
          api.id === requirement.id && satisfiesSemverRange(api.version, requirement.versionRange),
      )) {
        for (const member of [...(api.methods ?? []), ...(api.streams ?? [])]) {
          for (const grant of member.requiredGrants) grants.add(grant);
        }
      }
      for (const grant of API_CALL_TIME_GRANTS[requirement.id] ?? []) grants.add(grant);
    }
    NodeAssert.ok(grants.size <= EXTENSION_GRANT_CAPABILITIES_MAX);
    testContext.diagnostic(
      `${grants.size} Browser grants / ${EXTENSION_GRANT_CAPABILITIES_MAX} maximum`,
    );
  },
);
