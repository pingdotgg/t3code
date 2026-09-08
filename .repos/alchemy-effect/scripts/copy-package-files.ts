import { copyFile, readdir } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const packagesDirectory = path.join(root, "packages");
const thirdPartyPackages: Array<string> = [
  "alchemy",
  "frontend-frameworks",
  "cloudflare-runtime",
  "node-utils",
];
const readmePackages: Array<string> = ["alchemy"];

const packageNames = await readdir(packagesDirectory, {
  withFileTypes: true,
}).then((entries) =>
  entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
);

const requestedPackage = process.argv[2];
const targets = requestedPackage ? [requestedPackage] : packageNames;

for (const packageName of targets) {
  if (!packageNames.includes(packageName)) {
    throw new Error(`Unknown package: ${packageName}`);
  }

  const packageDirectory = path.join(packagesDirectory, packageName);
  await copyFile(
    path.join(root, "LICENSE"),
    path.join(packageDirectory, "LICENSE"),
  );
  await copyFile(
    path.join(root, "NOTICE"),
    path.join(packageDirectory, "NOTICE"),
  );

  if (thirdPartyPackages.includes(packageName)) {
    await copyFile(
      path.join(root, "THIRD_PARTY_LICENSES.md"),
      path.join(packageDirectory, "THIRD_PARTY_LICENSES.md"),
    );
  }

  if (readmePackages.includes(packageName)) {
    await copyFile(
      path.join(root, "README.md"),
      path.join(packageDirectory, "README.md"),
    );
  }
}
