const path = require("node:path");
const { catalog, writeIconPng } = require("../plugins/lib/appIconAssets.cjs");

const root = path.resolve(__dirname, "..");
async function generate() {
  for (const id of Object.keys(catalog)) {
    await writeIconPng(root, id, path.join(root, "assets/app-icons", `${id}.png`), 192);
  }
  await writeIconPng(root, "t3-code", path.join(root, "assets/app-icons/primary.png"), 1024);
  await writeIconPng(
    root,
    "t3-code",
    path.join(root, "assets/app-icons/primary-foreground.png"),
    432,
    "foreground",
  );
  await writeIconPng(
    root,
    "t3-code",
    path.join(root, "assets/app-icons/primary-background.png"),
    432,
    "background",
  );
}
generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
