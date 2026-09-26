const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { catalog, iconName, writeIosIconProject } = require("../plugins/lib/appIconAssets.cjs");

// Settings previews are actual Icon Composer renders. Run on macOS after changing the source or palette.
async function exportPreviews() {
  const root = path.resolve(__dirname, "..");
  const developer = execFileSync("xcode-select", ["-p"], { encoding: "utf8" }).trim();
  const tool =
    process.env.ICON_COMPOSER_TOOL ??
    path.resolve(developer, "../Applications/Icon Composer.app/Contents/Executables/ictool");
  const version = JSON.parse(execFileSync(tool, ["--version"], { encoding: "utf8" }));
  // Composer 1 renders iOS 26 by default; Composer 2 also supports newer design generations.
  const generation =
    parseInt(version["short-bundle-version"], 10) >= 2 ? ["--design-generation", "26"] : [];
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "t3-icon-composer-"));
  try {
    for (const id of Object.keys(catalog)) {
      const source = path.join(temporary, `${iconName(id)}.icon`);
      await writeIosIconProject(root, id, source);
      execFileSync(
        tool,
        [
          source,
          "--export-image",
          "--output-file",
          path.join(root, "assets/app-icons", `${id}.ios.png`),
          "--platform",
          "iOS",
          "--rendition",
          "Default",
          "--width",
          "192",
          "--height",
          "192",
          "--scale",
          "1",
          ...generation,
        ],
        { stdio: "inherit" },
      );
    }
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
exportPreviews().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
