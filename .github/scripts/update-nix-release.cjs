const fs = require("node:fs");

function updateNixRelease(release) {
  const tag = release.tag_name;
  if (!/^v\d+\.\d+\.\d+$/.test(tag) || release.draft || release.prerelease) {
    throw new Error(`Not a published stable release: ${tag}`);
  }

  const version = tag.slice(1);
  const name = `T3-Code-${version}-x86_64.AppImage`;
  const digest = release.assets.find((asset) => asset.name === name)?.digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
    throw new Error(`Release ${tag} is missing ${name} or its SHA-256 digest.`);
  }
  return { version, sha256: digest.slice(7) };
}

if (require.main === module) {
  const [, , releasePath, manifestPath = "packaging/nix/release.json"] = process.argv;
  if (!releasePath) throw new Error("Usage: update-nix-release.cjs <release.json> [manifest.json]");
  const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
  fs.writeFileSync(manifestPath, `${JSON.stringify(updateNixRelease(release), null, 2)}\n`);
}

module.exports = { updateNixRelease };
