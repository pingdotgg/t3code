import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeZlib from "node:zlib";

const fixtureRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const repoRoot = NodePath.resolve(fixtureRoot, "../..");

function outDirFromArgs(argv) {
  const direct = argv.find((arg) => arg.startsWith("--out-dir="));
  if (direct) return NodePath.resolve(fixtureRoot, direct.slice("--out-dir=".length));
  const index = argv.indexOf("--out-dir");
  if (index >= 0 && argv[index + 1]) return NodePath.resolve(fixtureRoot, argv[index + 1]);
  return NodePath.join(fixtureRoot, "dist");
}

const outDir = outDirFromArgs(process.argv.slice(2));
const packageDir = NodePath.join(outDir, "package");
const manifest = JSON.parse(
  NodeFS.readFileSync(NodePath.join(fixtureRoot, "manifest.json"), "utf8"),
);
const tarballName = `${manifest.id}-${manifest.version}.tgz`;
const tarballPath = NodePath.join(outDir, tarballName);
const shaPath = `${tarballPath}.sha256`;
const marketplacePath = NodePath.join(outDir, "marketplace.json");

function run(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, {
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

NodeFS.rmSync(outDir, { recursive: true, force: true });
NodeFS.mkdirSync(NodePath.join(packageDir, "server"), { recursive: true });
NodeFS.mkdirSync(NodePath.join(packageDir, "web"), { recursive: true });

NodeFS.writeFileSync(
  NodePath.join(packageDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

bundle(
  NodePath.join(fixtureRoot, "server/index.ts"),
  NodePath.join(packageDir, "server/index.js"),
  "node",
  ["@t3tools/plugin-sdk", "effect", "effect/*"],
);
bundle(
  NodePath.join(fixtureRoot, "web/index.tsx"),
  NodePath.join(packageDir, "web/index.js"),
  "browser",
  [
    "@effect/atom-react",
    "@t3tools/plugin-sdk-web",
    "effect",
    "react",
    "react/*",
    "react-dom",
    "react-dom/*",
  ],
);

const archive = NodeZlib.gzipSync(
  tar([
    {
      name: "manifest.json",
      body: NodeFS.readFileSync(NodePath.join(packageDir, "manifest.json")),
    },
    {
      name: "server/index.js",
      body: NodeFS.readFileSync(NodePath.join(packageDir, "server/index.js")),
    },
    { name: "web/index.js", body: NodeFS.readFileSync(NodePath.join(packageDir, "web/index.js")) },
  ]),
  { mtime: 0 },
);
NodeFS.writeFileSync(tarballPath, archive);

const sha256 = NodeCrypto.createHash("sha256").update(archive).digest("hex");
NodeFS.writeFileSync(shaPath, `${sha256}  ${tarballName}\n`);
NodeFS.writeFileSync(
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
              tarball: NodeURL.pathToFileURL(tarballPath).href,
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
