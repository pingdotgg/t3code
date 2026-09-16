// @effect-diagnostics nodeBuiltinImport:off - exercises the real release script in an isolated filesystem.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const releaseScriptPath = NodePath.join(repoRoot, "packaging/aur/scripts/release.sh");
const emptySha256 = "0".repeat(64);
const appImageSha256 = "a".repeat(64);
const legacyAppImageSha256 = "b".repeat(64);

function writeExecutable(filePath: string, contents: string) {
  NodeFS.writeFileSync(filePath, contents, { mode: 0o755 });
}

function runRelease(assets: ReadonlyArray<{ readonly name: string; readonly digest: string }>) {
  const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "publish-aur-"));
  const scriptDir = NodePath.join(fixtureRoot, "packaging/aur/scripts");
  const packageDir = NodePath.join(fixtureRoot, "packaging/aur/t3code-bin");
  const binDir = NodePath.join(fixtureRoot, "bin");

  try {
    NodeFS.mkdirSync(scriptDir, { recursive: true });
    NodeFS.mkdirSync(packageDir, { recursive: true });
    NodeFS.mkdirSync(binDir);
    NodeFS.copyFileSync(releaseScriptPath, NodePath.join(scriptDir, "release.sh"));
    NodeFS.chmodSync(NodePath.join(scriptDir, "release.sh"), 0o755);
    NodeFS.writeFileSync(
      NodePath.join(packageDir, "PKGBUILD"),
      `pkgver=0.0.33
pkgrel=1
_appimage_asset="T3-Code-\${pkgver}-x86_64.AppImage"
sha256sums=(
  '${emptySha256}' # AppImage
  '${emptySha256}' # upstream license
)
`,
    );

    writeExecutable(
      NodePath.join(binDir, "gh"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *'/releases/tags/'* ]]; then
  printf '%s\n' "$TEST_RELEASE_JSON"
elif [[ "$*" == *'/contents/LICENSE'* ]]; then
  printf 'license\n'
else
  printf 'Unexpected gh arguments: %s\n' "$*" >&2
  exit 1
fi
`,
    );
    writeExecutable(
      NodePath.join(binDir, "makepkg"),
      `#!/usr/bin/env bash
if [[ " $* " == *' --printsrcinfo '* ]]; then
  printf 'pkgbase = t3code-bin\n'
elif [[ " $* " == *' --packagelist '* ]]; then
  printf '%s/fake.pkg.tar.zst\n' "$PWD"
fi
`,
    );
    writeExecutable(NodePath.join(binDir, "namcap"), "#!/usr/bin/env bash\nexit 0\n");
    writeExecutable(NodePath.join(binDir, "id"), "#!/usr/bin/env bash\nprintf '1000\\n'\n");

    const result = NodeChildProcess.spawnSync(NodePath.join(scriptDir, "release.sh"), {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        AUR_SSH_PRIVATE_KEY: "",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        RELEASE_TAG: "v1.2.3",
        TEST_RELEASE_JSON: JSON.stringify({ assets }),
      },
    });
    const pkgbuild = NodeFS.readFileSync(NodePath.join(packageDir, "PKGBUILD"), "utf8");

    return { result, pkgbuild };
  } finally {
    NodeFS.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}

it("publishes an AUR package from a legacy versioned AppImage asset", () => {
  const { result, pkgbuild } = runRelease([
    {
      name: "T3-Code-1.2.3-x86_64.AppImage",
      digest: `sha256:${appImageSha256}`,
    },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.include(pkgbuild, "_appimage_asset='T3-Code-1.2.3-x86_64.AppImage'");
  assert.include(pkgbuild, `'${appImageSha256}' # AppImage`);
});

it("prefers the stable AppImage asset when both filenames are present", () => {
  const { result, pkgbuild } = runRelease([
    {
      name: "T3-Code-1.2.3-x86_64.AppImage",
      digest: `sha256:${legacyAppImageSha256}`,
    },
    {
      name: "T3-Code-x86_64.AppImage",
      digest: `sha256:${appImageSha256}`,
    },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.include(pkgbuild, "_appimage_asset='T3-Code-x86_64.AppImage'");
  assert.include(pkgbuild, `'${appImageSha256}' # AppImage`);
});

it("uses the legacy asset when the stable asset has no valid digest", () => {
  const { result, pkgbuild } = runRelease([
    {
      name: "T3-Code-x86_64.AppImage",
      digest: "sha256:invalid",
    },
    {
      name: "T3-Code-1.2.3-x86_64.AppImage",
      digest: `sha256:${legacyAppImageSha256}`,
    },
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.include(pkgbuild, "_appimage_asset='T3-Code-1.2.3-x86_64.AppImage'");
  assert.include(pkgbuild, `'${legacyAppImageSha256}' # AppImage`);
});

it("rejects a release without a supported AppImage asset", () => {
  const { result } = runRelease([]);

  assert.equal(result.status, 1);
  assert.include(
    result.stderr,
    "Release v1.2.3 has no supported AppImage asset with a SHA-256 digest.\n" +
      "Expected T3-Code-x86_64.AppImage or T3-Code-1.2.3-x86_64.AppImage.",
  );
});

it("rejects supported AppImage filenames without a valid digest", () => {
  const { result } = runRelease([
    {
      name: "T3-Code-x86_64.AppImage",
      digest: "sha256:invalid",
    },
    {
      name: "T3-Code-1.2.3-x86_64.AppImage",
      digest: "",
    },
  ]);

  assert.equal(result.status, 1);
  assert.include(result.stderr, "has no supported AppImage asset with a SHA-256 digest");
});
