const assert = require("node:assert/strict");
const test = require("node:test");
const { updateNixRelease } = require("./update-nix-release.cjs");

const release = {
  tag_name: "v1.0.1",
  draft: false,
  prerelease: false,
  assets: [{ name: "T3-Code-1.0.1-x86_64.AppImage", digest: `sha256:${"a".repeat(64)}` }],
};

test("pins the stable AppImage version and hash", () => {
  assert.deepEqual(updateNixRelease(release), { version: "1.0.1", sha256: "a".repeat(64) });
});

for (const override of [
  { draft: true },
  { prerelease: true },
  { tag_name: "v1.0.1-rc.1" },
  { assets: [] },
  { assets: [{ ...release.assets[0], digest: "sha256:invalid" }] },
]) {
  test(`rejects invalid release metadata: ${JSON.stringify(override)}`, () => {
    assert.throws(() => updateNixRelease({ ...release, ...override }));
  });
}
