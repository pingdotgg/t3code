import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(fixtureRoot, "../..");

function outDirFromArgs(argv) {
  const direct = argv.find((arg) => arg.startsWith("--out-dir="));
  if (direct) return resolve(fixtureRoot, direct.slice("--out-dir=".length));
  const index = argv.indexOf("--out-dir");
  if (index >= 0 && argv[index + 1]) return resolve(fixtureRoot, argv[index + 1]);
  return join(fixtureRoot, "dist");
}

const outDir = outDirFromArgs(process.argv.slice(2));
const packageDir = join(outDir, "package");
const manifest = JSON.parse(readFileSync(join(fixtureRoot, "manifest.json"), "utf8"));
const tarballName = `${manifest.id}-${manifest.version}.tgz`;
const tarballPath = join(outDir, tarballName);
const shaPath = `${tarballPath}.sha256`;
const marketplacePath = join(outDir, "marketplace.json");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function bundle(input, output, platform, externals) {
  run("pnpm", [
    "exec",
    "esbuild",
    input,
    "--bundle",
    "--format=esm",
    `--platform=${platform}`,
    "--target=es2022",
    ...externals.flatMap((external) => [`--external:${external}`]),
    `--outfile=${output}`,
  ]);
}

function writeString(buffer, offset, length, value) {
  buffer.write(value, offset, length, "utf8");
}

function writeOctal(buffer, offset, length, value) {
  writeString(buffer, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function tarChecksum(header) {
  let sum = 0;
  for (const byte of header) sum += byte;
  return sum;
}

function tarEntry(name, body) {
  if (Buffer.byteLength(name) > 100) {
    throw new Error(`Tar entry name is too long: ${name}`);
  }
  const header = Buffer.alloc(512);
  writeString(header, 0, 100, name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, body.byteLength);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeString(header, 156, 1, "0");
  writeString(header, 257, 6, "ustar");
  writeString(header, 263, 2, "00");
  writeOctal(header, 148, 8, tarChecksum(header));

  const paddingLength = Math.ceil(body.byteLength / 512) * 512 - body.byteLength;
  return Buffer.concat([header, body, Buffer.alloc(paddingLength)]);
}

function tar(entries) {
  return Buffer.concat([
    ...entries.map((entry) => tarEntry(entry.name, entry.body)),
    Buffer.alloc(1024),
  ]);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(packageDir, "server"), { recursive: true });
mkdirSync(join(packageDir, "web"), { recursive: true });

writeFileSync(join(packageDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

bundle(join(fixtureRoot, "server/index.ts"), join(packageDir, "server/index.js"), "node", [
  "@t3tools/plugin-sdk",
  "effect",
  "effect/*",
]);
bundle(join(fixtureRoot, "web/index.tsx"), join(packageDir, "web/index.js"), "browser", [
  "@effect/atom-react",
  "@t3tools/plugin-sdk-web",
  "effect",
  "react",
  "react/*",
  "react-dom",
  "react-dom/*",
]);

const archive = gzipSync(
  tar([
    { name: "manifest.json", body: readFileSync(join(packageDir, "manifest.json")) },
    { name: "server/index.js", body: readFileSync(join(packageDir, "server/index.js")) },
    { name: "web/index.js", body: readFileSync(join(packageDir, "web/index.js")) },
  ]),
  { mtime: 0 },
);
writeFileSync(tarballPath, archive);

const sha256 = createHash("sha256").update(archive).digest("hex");
writeFileSync(shaPath, `${sha256}  ${tarballName}\n`);
writeFileSync(
  marketplacePath,
  `${JSON.stringify(
    {
      plugins: [
        {
          id: manifest.id,
          name: manifest.name,
          description: manifest.description,
          author: manifest.author,
          capabilities: manifest.capabilities,
          versions: [
            {
              version: manifest.version,
              tarball: pathToFileURL(tarballPath).href,
              sha256,
              hostApi: manifest.hostApi,
              publishedAt: "2026-07-03T00:00:00.000Z",
            },
          ],
        },
      ],
    },
    null,
    2,
  )}\n`,
);

console.log(`tarball=${tarballPath}`);
console.log(`sha256=${sha256}`);
console.log(`sha256File=${shaPath}`);
console.log(`marketplace=${marketplacePath}`);
