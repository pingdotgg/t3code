// @effect-diagnostics nodeBuiltinImport:off - native-source fixtures exercise Expo's installed fingerprint runtime.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

type Source =
  | { type: "file" | "dir"; filePath: string; reasons: string[] }
  | { type: "contents"; id: string; contents: string; reasons: string[] };
type HashSources = (
  sources: Source[],
  projectRoot: string,
  options: Record<string, unknown>,
) => Promise<{ hash: string; sources: (Source & { hash: string | null })[] }>;

describe("Expo fingerprint pnpm paths", () => {
  let directory: string;
  let hashSources: HashSources;
  let normalizeAutolinkingConfig: (
    config: unknown,
    options: { stripPaths: boolean; roots: string[] },
  ) => unknown;
  let stripAutolinkingPaths: boolean;
  let fixtureNumber = 0;

  beforeAll(async () => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-fingerprint-"));
    const mobileRequire = NodeModule.createRequire(new URL("../package.json", import.meta.url));
    const expoRequire = NodeModule.createRequire(mobileRequire.resolve("expo/package.json"));
    const installedRoot = NodePath.dirname(expoRequire.resolve("@expo/fingerprint/package.json"));
    const installedRequire = NodeModule.createRequire(NodePath.join(installedRoot, "package.json"));
    hashSources = installedRequire("./build/hash/Hash.js").createFingerprintFromSourcesAsync;
    normalizeAutolinkingConfig = installedRequire(
      "./build/sourcer/AutolinkingConfig.js",
    ).normalizeAutolinkingConfig;
    const normalizeOptions: (
      root: string,
      options: { silent: boolean },
    ) => Promise<{ sourceSkips: number }> =
      installedRequire("./build/Options.js").normalizeOptionsAsync;
    const sourceSkips: { AutolinkingConfigPaths: number } = installedRequire(
      "./build/sourcer/SourceSkips.js",
    ).SourceSkips;
    const options = await normalizeOptions(
      NodePath.dirname(mobileRequire.resolve("./package.json")),
      {
        silent: true,
      },
    );
    stripAutolinkingPaths = Boolean(options.sourceSkips & sourceSkips.AutolinkingConfigPaths);
  });

  afterAll(() => {
    if (directory) NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  function fixture(
    layout: "global" | "project" | "local-store",
    depth = "checkout",
    version = "1.0.0",
  ) {
    const root = NodePath.join(directory, `fixture-${fixtureNumber++}`);
    const checkout = NodePath.join(root, depth);
    const projectRoot = NodePath.join(checkout, "apps/mobile");
    NodeFS.mkdirSync(projectRoot, { recursive: true });
    const sources: Source[] = [];
    const nativeFiles: string[] = [];
    const packageJsonFiles: string[] = [];
    const modules = [];
    const relativePath = (file: string) =>
      NodePath.relative(projectRoot, file).split(NodePath.sep).join("/");
    for (const name of ["@native/alpha", "native-zeta"]) {
      const packageRoot =
        layout === "project"
          ? NodePath.join(
              checkout,
              "node_modules/.pnpm",
              `${name.replace("/", "+")}@${version}_peers`,
              "node_modules",
              name,
            )
          : NodePath.join(
              layout === "global" ? root : checkout,
              layout === "global" ? "Library/pnpm/store/v11/links" : ".pnpm-store/v11/links",
              name.startsWith("@") ? name : `@/${name}`,
              version,
              name.startsWith("@") ? "ffff" : "aaaa",
              "node_modules",
              name,
            );
      const write = (relative: string, contents: string) => {
        const file = NodePath.join(packageRoot, relative);
        NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
        NodeFS.writeFileSync(file, contents);
        return file;
      };
      packageJsonFiles.push(write("package.json", JSON.stringify({ name, version })));
      nativeFiles.push(write("ios/Nested/Module.swift", "let nativeValue = 1\n"));
      write("ios/Module.podspec", "Pod::Spec.new {}\n");
      write("android/build.gradle", "android {}\n");
      sources.push(
        {
          type: "dir",
          filePath: relativePath(NodePath.join(packageRoot, "ios")),
          reasons: ["expoAutolinkingIos"],
        },
        {
          type: "file",
          filePath: relativePath(NodePath.join(packageRoot, "android/build.gradle")),
          reasons: ["expoAutolinkingAndroid"],
        },
        {
          type: "contents",
          id: relativePath(NodePath.join(packageRoot, "plugin.js")),
          contents: "export default () => {};",
          reasons: ["expoConfigPlugins"],
        },
      );
      modules.push({
        packageName: name,
        packageVersion: version,
        pods: [{ podName: name, podspecDir: relativePath(NodePath.join(packageRoot, "ios")) }],
        projects: [{ name, sourceDir: NodePath.join(packageRoot, "android") }],
        flags: { usesSwift: true },
      });
    }
    const autolinkingConfig = normalizeAutolinkingConfig(
      { modules },
      { stripPaths: stripAutolinkingPaths, roots: [projectRoot] },
    );
    sources.push({
      type: "contents",
      id: "expoAutolinkingConfig:ios",
      contents: JSON.stringify(autolinkingConfig),
      reasons: ["expoAutolinkingIos"],
    });
    sources.sort((left, right) => {
      const leftPath = left.type === "contents" ? left.id : left.filePath;
      const rightPath = right.type === "contents" ? right.id : right.filePath;
      return leftPath.localeCompare(rightPath);
    });
    const hash = () =>
      hashSources(sources, projectRoot, {
        hashAlgorithm: "sha1",
        concurrentIoLimit: 2,
        ignorePathMatchObjects: [],
        ignoreDirMatchObjects: [],
        enableReactImportsPatcher: false,
        debug: true,
      });
    const [nativeFile] = nativeFiles;
    const [packageJsonFile] = packageJsonFiles;
    if (!nativeFile || !packageJsonFile) throw new Error("Missing native fixture package");
    return { sources, projectRoot, nativeFile, packageJsonFile, hash, autolinkingConfig };
  }

  it("hashes identical native sources equally at different checkout depths", async () => {
    const main = fixture("global");
    const worktree = fixture("global", "nested/worktrees/branch");
    expect((await main.hash()).hash).toBe((await worktree.hash()).hash);
  });

  it("hashes global, project virtual-store and local-store layouts equally", async () => {
    const global = fixture("global");
    const project = fixture("project", "nested/worktrees/branch");
    const local = fixture("local-store");
    const expected = (await global.hash()).hash;
    expect((await project.hash()).hash).toBe(expected);
    expect((await local.hash()).hash).toBe(expected);
  });

  it("detects native content changes below nested directories", async () => {
    const project = fixture("global");
    const before = (await project.hash()).hash;
    NodeFS.writeFileSync(project.nativeFile, "let nativeValue = 2\n");
    expect((await project.hash()).hash).not.toBe(before);
  });

  it("detects dependency version changes with identical native contents", async () => {
    const project = fixture("global");
    const before = (await project.hash()).hash;
    NodeFS.writeFileSync(
      project.packageJsonFile,
      JSON.stringify({ name: "@native/alpha", version: "2.0.0" }),
    );
    expect((await project.hash()).hash).not.toBe(before);
  });

  it("detects package identity changes without changing physical paths", async () => {
    const project = fixture("project");
    const before = (await project.hash()).hash;
    NodeFS.writeFileSync(
      project.packageJsonFile,
      JSON.stringify({ name: "@native/renamed", version: "1.0.0" }),
    );
    expect((await project.hash()).hash).not.toBe(before);
  });

  it("detects native file renames", async () => {
    const project = fixture("project");
    const before = (await project.hash()).hash;
    const file = project.nativeFile;
    NodeFS.renameSync(file, NodePath.join(NodePath.dirname(file), "Renamed.swift"));
    expect((await project.hash()).hash).not.toBe(before);
  });

  it("uses Expo's existing path stripping for embedded autolinking JSON paths", async () => {
    const global = fixture("global");
    const project = fixture("project");
    expect(global.autolinkingConfig).toEqual(project.autolinkingConfig);
    expect(JSON.stringify(global.autolinkingConfig)).not.toMatch(/pnpm|podspecDir|sourceDir/);
    const before = (await global.hash()).hash;
    const configSource = global.sources.find(
      (source) => source.type === "contents" && source.id === "expoAutolinkingConfig:ios",
    );
    if (!configSource || configSource.type !== "contents")
      throw new Error("Missing autolinking config");
    configSource.contents = configSource.contents.replace('"usesSwift":true', '"usesSwift":false');
    expect((await global.hash()).hash).not.toBe(before);
  });

  it("keeps the physical source paths and reads their contents", async () => {
    const project = fixture("global");
    const before = structuredClone(project.sources);
    const result = await project.hash();
    expect(project.sources).toEqual(before);
    expect(
      result.sources
        .filter((source) => source.type !== "contents")
        .map((source) => source.filePath)
        .sort(),
    ).toEqual(
      before
        .filter((source) => source.type !== "contents")
        .map((source) => source.filePath)
        .sort(),
    );
    expect(result.sources.every((source) => source.hash !== null)).toBe(true);
  });

  it("preserves paths of native modules outside pnpm stores", async () => {
    const project = fixture("project");
    const file = NodePath.join(project.projectRoot, "modules/local/Module.swift");
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, "let nativeValue = 1\n");
    project.sources.push({
      type: "file",
      filePath: "modules/local/Module.swift",
      reasons: ["expoAutolinkingIos"],
    });
    const before = (await project.hash()).hash;
    NodeFS.renameSync(file, NodePath.join(NodePath.dirname(file), "Renamed.swift"));
    project.sources[project.sources.length - 1] = {
      type: "file",
      filePath: "modules/local/Renamed.swift",
      reasons: ["expoAutolinkingIos"],
    };
    expect((await project.hash()).hash).not.toBe(before);
  });
});
