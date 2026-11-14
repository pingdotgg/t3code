// @effect-diagnostics nodeBuiltinImport:off - Exercises AppImage replacement on a real temporary filesystem.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, vi } from "vite-plus/test";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFS>();
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    renameSync: vi.fn(actual.renameSync),
    realpathSync: vi.fn(actual.realpathSync),
    rmSync: vi.fn(actual.rmSync),
  };
});

import { installAppImageUpdate } from "./AppImageInstall.ts";

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("installAppImageUpdate", () => {
  const oldAppImage = "#!/bin/sh\n# old build\nexit 0\n";
  const newAppImage = `#!/bin/sh\n# new build\nexit 0\n#${"x".repeat(4096)}\n`;
  const sha512 = (content: string) =>
    NodeCrypto.createHash("sha512").update(content).digest("base64");
  const directories: Array<string> = [];

  function fixture(appImageName = "T3-Code.AppImage") {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-appimage-install-"));
    directories.push(root);
    const applications = NodePath.join(root, "Applications");
    const pending = NodePath.join(root, "cache", "pending");
    NodeFS.mkdirSync(applications);
    NodeFS.mkdirSync(pending, { recursive: true });
    const appImageFile = NodePath.join(applications, appImageName);
    const installerPath = NodePath.join(pending, "T3-Code-1.2.3-x86_64.AppImage");
    NodeFS.writeFileSync(appImageFile, oldAppImage, { mode: 0o755 });
    NodeFS.writeFileSync(installerPath, newAppImage, { mode: 0o644 });
    return { root, applications, appImageFile, installerPath };
  }

  function assertUntouched(input: ReturnType<typeof fixture>, cached = newAppImage) {
    assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), oldAppImage);
    assert.equal(NodeFS.readFileSync(input.installerPath, "utf8"), cached);
    assert.deepEqual(NodeFS.readdirSync(input.applications), [
      NodePath.basename(input.appImageFile),
    ]);
  }

  afterEach(() => {
    vi.mocked(NodeFS.copyFileSync).mockReset();
    vi.mocked(NodeFS.renameSync).mockReset();
    vi.mocked(NodeFS.realpathSync).mockReset();
    vi.mocked(NodeFS.rmSync).mockReset();
    for (const directory of directories.splice(0)) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { installed: "T3-Code.AppImage", destination: "T3-Code.AppImage", releaseSize: undefined },
    {
      installed: "T3-Code-1.2.2-x86_64.AppImage",
      destination: "T3-Code-1.2.3-x86_64.AppImage",
      releaseSize: Buffer.byteLength(newAppImage),
    },
  ])("replaces $installed with a verified executable at $destination", (names) => {
    const input = fixture(names.installed);
    const copy = vi.mocked(NodeFS.copyFileSync).getMockImplementation()!;
    vi.mocked(NodeFS.copyFileSync).mockImplementationOnce((from, to, mode) => {
      assert.equal(NodeFS.readFileSync(input.appImageFile, "utf8"), oldAppImage);
      const stageDirectory = NodePath.dirname(String(to));
      assert.equal(NodePath.dirname(stageDirectory), input.applications);
      assert.equal(NodeFS.statSync(stageDirectory).mode & 0o777, 0o700);
      copy(from, to, mode);
    });

    const destination = installAppImageUpdate({
      ...input,
      sha512: sha512(newAppImage),
      size: names.releaseSize,
    });

    assert.equal(destination, NodePath.join(input.applications, names.destination));
    assert.equal(NodeFS.readFileSync(destination, "utf8"), newAppImage);
    assert.equal(NodeFS.statSync(destination).mode & 0o777, 0o755);
    assert.deepEqual(NodeFS.readdirSync(input.applications), [names.destination]);
    assert.isFalse(NodeFS.existsSync(input.installerPath));
  });

  it("keeps the installed app and cached download when the update cannot be verified or committed", () => {
    const cases: Array<{
      source: string;
      stage?: string;
      digest: string;
      size?: number;
      rename?: boolean;
    }> = [
      { source: "", digest: sha512("") },
      { source: newAppImage, stage: "short", digest: sha512("short") },
      { source: newAppImage, digest: sha512(newAppImage), size: newAppImage.length + 1 },
      {
        source: newAppImage,
        stage: newAppImage.replace("new", "bad"),
        digest: sha512(newAppImage),
      },
      { source: newAppImage, digest: sha512(newAppImage), rename: true },
    ];
    for (const { source, stage, digest, size, rename } of cases) {
      const input = fixture();
      NodeFS.writeFileSync(input.installerPath, source);
      if (stage !== undefined) {
        vi.mocked(NodeFS.copyFileSync).mockImplementationOnce((_from, to) => {
          NodeFS.writeFileSync(to, stage);
        });
      }
      if (rename) {
        vi.mocked(NodeFS.renameSync).mockImplementationOnce(() => {
          throw new Error("cannot commit update");
        });
      }

      assert.throws(() => installAppImageUpdate({ ...input, sha512: digest, size }));

      assertUntouched(input, source);
    }
  });

  it.each(["symlink", "mount alias"] as const)(
    "keeps the committed destination when the cache reaches it through a %s",
    (aliasKind) => {
      const input = fixture("T3-Code-1.2.2-x86_64.AppImage");
      const cacheDirectory = NodePath.join(input.root, "alias");
      NodeFS.symlinkSync(input.applications, cacheDirectory);
      const installerPath = NodePath.join(cacheDirectory, NodePath.basename(input.installerPath));
      NodeFS.renameSync(input.installerPath, installerPath);
      if (aliasKind === "mount alias") {
        // Bind mounts share directory entries without realpath resolving their aliases.
        vi.mocked(NodeFS.realpathSync).mockImplementation(((path: NodeFS.PathLike) =>
          NodePath.resolve(String(path))) as typeof NodeFS.realpathSync);
      }

      const destination = installAppImageUpdate({
        ...input,
        installerPath,
        sha512: sha512(newAppImage),
      });

      assert.equal(
        destination,
        NodePath.join(input.applications, NodePath.basename(installerPath)),
      );
      assert.equal(NodeFS.readFileSync(installerPath, "utf8"), newAppImage);
      assert.deepEqual(NodeFS.readdirSync(input.applications), [NodePath.basename(installerPath)]);
    },
  );

  it("still succeeds when removing the cached download fails after commit", () => {
    const input = fixture();
    const remove = vi.mocked(NodeFS.rmSync).getMockImplementation()!;
    vi.mocked(NodeFS.rmSync).mockImplementation((path, options) => {
      if (path === input.installerPath) throw new Error("cache cleanup failed");
      remove(path, options);
    });

    const destination = installAppImageUpdate({ ...input, sha512: sha512(newAppImage) });

    assert.equal(NodeFS.readFileSync(destination, "utf8"), newAppImage);
    assert.deepEqual(NodeFS.readdirSync(input.applications), [NodePath.basename(destination)]);
  });
});
