// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the Node filesystem build boundary.

import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { generateThirdPartyLicenseManifest } from "./third-party-licenses.js";

const tempDirectories: string[] = [];

async function writeJson(path: string, value: unknown): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

async function createFixture(): Promise<{
  readonly appManifest: string;
  readonly configFile: string;
  readonly dependencyRoot: string;
  readonly root: string;
}> {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3code-licenses-"));
  tempDirectories.push(root);
  const appManifest = NodePath.join(root, "package.json");
  const dependencyRoot = NodePath.join(root, "node_modules", "demo-dependency");
  const configFile = NodePath.join(root, "third-party-licenses.config.json");

  await writeJson(appManifest, {
    name: "fixture-app",
    dependencies: { "demo-dependency": "1.2.3" },
  });
  await writeJson(NodePath.join(dependencyRoot, "package.json"), {
    name: "demo-dependency",
    version: "1.2.3",
    license: "MIT",
    main: "index.js",
    repository: "example/demo-dependency",
  });
  await NodeFSP.writeFile(NodePath.join(dependencyRoot, "index.js"), "export {};\n", "utf8");
  await NodeFSP.writeFile(
    NodePath.join(dependencyRoot, "LICENSE"),
    "Demo MIT license text\n",
    "utf8",
  );
  await NodeFSP.writeFile(NodePath.join(root, "asset-notice.txt"), "Asset notice text\n", "utf8");
  await writeJson(configFile, {
    customNotices: [
      {
        name: "demo-asset",
        license: "CC-BY-4.0",
        noticeFile: "asset-notice.txt",
        bundles: ["assets", "web"],
      },
    ],
    packageOverrides: [],
  });
  return { appManifest, configFile, dependencyRoot, root };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { force: true, recursive: true })),
  );
});

describe("third-party license generation", () => {
  it("collects production packages and custom asset notices", async () => {
    const fixture = await createFixture();
    const manifest = await generateThirdPartyLicenseManifest({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "web", path: fixture.appManifest }],
    });

    expect(manifest).toEqual({
      schemaVersion: 1,
      entries: [
        {
          bundles: ["assets", "web"],
          kind: "custom",
          license: "CC-BY-4.0",
          name: "demo-asset",
          noticeText: "Asset notice text",
          sourceUrl: null,
          version: null,
        },
        {
          bundles: ["web"],
          kind: "package",
          license: "MIT",
          name: "demo-dependency",
          noticeText: "Demo MIT license text",
          sourceUrl: "https://github.com/example/demo-dependency",
          version: "1.2.3",
        },
      ],
    });
  });

  it("fails when a production package has no distributable notice text", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));

    await expect(
      generateThirdPartyLicenseManifest({
        configFile: fixture.configFile,
        packageManifests: [{ bundle: "web", path: fixture.appManifest }],
      }),
    ).rejects.toThrow("does not include a license or notice file");
  });

  it("collects notices nested inside a published package", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));
    await NodeFSP.mkdir(NodePath.join(fixture.dependencyRoot, "dist", "third-party"), {
      recursive: true,
    });
    await NodeFSP.writeFile(
      NodePath.join(fixture.dependencyRoot, "dist", "third-party", "NOTICE.txt"),
      "Nested notice\n",
      "utf8",
    );

    const manifest = await generateThirdPartyLicenseManifest({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "web", path: fixture.appManifest }],
    });

    expect(manifest.entries.find((entry) => entry.name === "demo-dependency")?.noticeText).toBe(
      "Nested notice",
    );
  });

  it("uses package overrides for notices published outside the npm archive", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));
    await NodeFSP.writeFile(NodePath.join(fixture.root, "override.txt"), "Override text\n", "utf8");
    await writeJson(fixture.configFile, {
      customNotices: [],
      packageOverrides: [
        {
          name: "demo-dependency",
          noticeFile: "override.txt",
        },
      ],
    });

    const manifest = await generateThirdPartyLicenseManifest({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "web", path: fixture.appManifest }],
    });

    expect(manifest.entries[0]?.noticeText).toBe("Override text");
  });

  it("applies repository overrides across monorepo packages", async () => {
    const fixture = await createFixture();
    await NodeFSP.rm(NodePath.join(fixture.dependencyRoot, "LICENSE"));
    await NodeFSP.writeFile(
      NodePath.join(fixture.root, "override.txt"),
      "Repository text\n",
      "utf8",
    );
    await writeJson(fixture.configFile, {
      customNotices: [],
      packageOverrides: [
        {
          repositoryUrl: "https://github.com/example/demo-dependency",
          noticeFile: "override.txt",
        },
      ],
    });

    const manifest = await generateThirdPartyLicenseManifest({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "web", path: fixture.appManifest }],
    });

    expect(manifest.entries[0]?.noticeText).toBe("Repository text");
  });

  it("reuses a repository license for packages from the same monorepo", async () => {
    const fixture = await createFixture();
    const siblingRoot = NodePath.join(fixture.root, "node_modules", "demo-sibling");
    await writeJson(fixture.appManifest, {
      name: "fixture-app",
      dependencies: { "demo-dependency": "1.2.3", "demo-sibling": "2.0.0" },
    });
    await writeJson(NodePath.join(siblingRoot, "package.json"), {
      name: "demo-sibling",
      version: "2.0.0",
      license: "MIT",
      main: "index.js",
      repository: "example/demo-dependency",
    });
    await NodeFSP.writeFile(NodePath.join(siblingRoot, "index.js"), "export {};\n", "utf8");

    const manifest = await generateThirdPartyLicenseManifest({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "web", path: fixture.appManifest }],
    });

    expect(manifest.entries.find((entry) => entry.name === "demo-sibling")?.noticeText).toBe(
      "Demo MIT license text",
    );
  });

  it("omits custom notices for other bundles", async () => {
    const fixture = await createFixture();
    await writeJson(fixture.configFile, {
      customNotices: [
        {
          name: "web-only-asset",
          license: "MIT",
          noticeFile: "asset-notice.txt",
          bundles: ["assets", "web"],
        },
      ],
      packageOverrides: [],
    });

    const manifest = await generateThirdPartyLicenseManifest({
      configFile: fixture.configFile,
      packageManifests: [{ bundle: "mobile", path: fixture.appManifest }],
    });

    expect(manifest.entries.some((entry) => entry.name === "web-only-asset")).toBe(false);
  });

  it("fails when a custom notice file is empty", async () => {
    const fixture = await createFixture();
    await NodeFSP.writeFile(NodePath.join(fixture.root, "asset-notice.txt"), "\n", "utf8");

    await expect(
      generateThirdPartyLicenseManifest({
        configFile: fixture.configFile,
        packageManifests: [{ bundle: "web", path: fixture.appManifest }],
      }),
    ).rejects.toThrow('Custom third-party notice "demo-asset" is empty');
  });
});
// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the Node filesystem build boundary.
