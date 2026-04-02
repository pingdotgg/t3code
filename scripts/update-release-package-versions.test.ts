import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  releasePackageFiles,
  updateReleasePackageVersions,
} from "./update-release-package-versions";
import { writeKeybindingsJsonSchemas } from "./lib/keybindings-schema";
import { writeServerSettingsJsonSchemas } from "./lib/server-settings-schema";

describe("updateReleasePackageVersions", () => {
  it("updates package versions and writes latest plus versioned config schemas", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "t3-release-version-bump-"));

    try {
      for (const relativePath of releasePackageFiles) {
        const filePath = resolve(rootDir, relativePath);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(
          filePath,
          `${JSON.stringify({ name: relativePath, version: "0.0.0" }, null, 2)}\n`,
        );
      }

      const result = updateReleasePackageVersions("1.2.3", { rootDir });
      expect(result.changed).toBe(true);

      for (const relativePath of releasePackageFiles) {
        const packageJson = JSON.parse(readFileSync(resolve(rootDir, relativePath), "utf8")) as {
          version?: string;
        };
        expect(packageJson.version).toBe("1.2.3");
      }

      expect(
        JSON.parse(
          readFileSync(resolve(rootDir, "apps/marketing/public/schemas/settings.json"), "utf8"),
        ),
      ).toMatchObject({ title: "T3 Code Server Settings" });

      expect(
        JSON.parse(
          readFileSync(
            resolve(rootDir, "apps/marketing/public/schemas/settings/1.2.3.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ title: "T3 Code Server Settings" });

      expect(
        JSON.parse(
          readFileSync(resolve(rootDir, "apps/marketing/public/schemas/keybindings.json"), "utf8"),
        ),
      ).toMatchObject({ title: "T3 Code Keybindings" });

      expect(
        JSON.parse(
          readFileSync(
            resolve(rootDir, "apps/marketing/public/schemas/keybindings/1.2.3.json"),
            "utf8",
          ),
        ),
      ).toMatchObject({ title: "T3 Code Keybindings" });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("skips versioned schema snapshots when the latest schemas are unchanged", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "t3-release-version-bump-"));

    try {
      for (const relativePath of releasePackageFiles) {
        const filePath = resolve(rootDir, relativePath);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(
          filePath,
          `${JSON.stringify({ name: relativePath, version: "1.2.3" }, null, 2)}\n`,
        );
      }

      writeServerSettingsJsonSchemas({ rootDir });
      writeKeybindingsJsonSchemas({ rootDir });

      const result = updateReleasePackageVersions("1.2.3", { rootDir });
      expect(result.changed).toBe(false);

      expect(
        existsSync(resolve(rootDir, "apps/marketing/public/schemas/settings/1.2.3.json")),
      ).toBe(false);
      expect(
        existsSync(resolve(rootDir, "apps/marketing/public/schemas/keybindings/1.2.3.json")),
      ).toBe(false);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
