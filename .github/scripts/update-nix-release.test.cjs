const assert = require("node:assert/strict");
const test = require("node:test");
const { updateNixRelease } = require("./update-nix-release.cjs");

const manifest = {
  stable: { version: "1.0.0", publishedAt: "2026-10-01T00:00:00Z", sha256: "0".repeat(64) },
  nightly: {
    version: "1.0.1-nightly.20261001.1",
    publishedAt: "2026-10-01T00:00:00Z",
    sha256: "1".repeat(64),
  },
};
const release = (nightly = false) => {
  const version = nightly ? "1.0.1-nightly.20261002.2" : "1.0.1";
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: nightly,
    published_at: "2026-10-02T00:00:00Z",
    assets: [{ name: `T3-Code-${version}-x86_64.AppImage`, digest: `sha256:${"a".repeat(64)}` }],
  };
};

for (const nightly of [false, true]) {
  const channel = nightly ? "nightly" : "stable";
  test(`updates ${channel} without changing the other channel`, () => {
    const result = updateNixRelease(manifest, release(nightly));
    assert.equal(result[channel].version, release(nightly).tag_name.slice(1));
    assert.equal(result[channel].sha256, "a".repeat(64));
    assert.equal(result[nightly ? "stable" : "nightly"], manifest[nightly ? "stable" : "nightly"]);
    assert.equal(manifest.stable.version, "1.0.0");
    assert.deepEqual(updateNixRelease(result, release(nightly)), result);
  });
}

test("a rerun of an older release preserves the newer pin", () => {
  assert.equal(
    updateNixRelease(manifest, { ...release(), published_at: "2026-09-01T00:00:00Z" }),
    manifest,
  );
});

for (const override of [
  { draft: true },
  { published_at: null },
  { published_at: "invalid" },
  { tag_name: "v1.0.1-preview.20261002.2" },
  { prerelease: true },
  { assets: [] },
  { assets: [{ ...release().assets[0], digest: "sha256:invalid" }] },
]) {
  test(`rejects invalid release metadata: ${JSON.stringify(override)}`, () => {
    assert.throws(() => updateNixRelease(manifest, { ...release(), ...override }));
  });
}
