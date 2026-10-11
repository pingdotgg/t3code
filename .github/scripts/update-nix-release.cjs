const fs = require("node:fs");

function updateNixRelease(manifest, release) {
  const tag = release.tag_name;
  const channel = /^v\d+\.\d+\.\d+$/.test(tag)
    ? "stable"
    : /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+$/.test(tag)
      ? "nightly"
      : undefined;
  if (!channel || release.draft || !release.published_at) {
    throw new Error(`Not a published stable or nightly release: ${tag}`);
  }
  if (release.prerelease !== (channel === "nightly")) {
    throw new Error(`Release ${tag} has the wrong prerelease flag.`);
  }

  const version = tag.slice(1);
  const name = `T3-Code-${version}-x86_64.AppImage`;
  const digest = release.assets.find((asset) => asset.name === name)?.digest;
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? "")) {
    throw new Error(`Release ${tag} is missing ${name} or its SHA-256 digest.`);
  }
  const publishedAt = release.published_at;
  if (!Number.isFinite(Date.parse(publishedAt))) {
    throw new Error(`Release ${tag} has an invalid publication date.`);
  }
  if (Date.parse(manifest[channel].publishedAt) > Date.parse(publishedAt)) {
    return manifest;
  }
  return {
    ...manifest,
    [channel]: { version, publishedAt, sha256: digest.slice(7) },
  };
}

if (require.main === module) {
  const [, , releasePath, manifestPath = "packaging/nix/releases.json"] = process.argv;
  if (!releasePath) throw new Error("Usage: update-nix-release.cjs <release.json> [manifest.json]");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(updateNixRelease(manifest, release), null, 2)}\n`,
  );
}

module.exports = { updateNixRelease };
