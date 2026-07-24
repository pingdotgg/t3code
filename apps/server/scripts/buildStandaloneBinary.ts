// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import packageJson from "../package.json" with { type: "json" };

const [rawTarget, output] = process.argv.slice(2);
if ((rawTarget !== "bun-darwin-arm64" && rawTarget !== "bun-linux-x64-baseline") || !output) {
  throw new Error("Usage: bun scripts/buildStandaloneBinary.ts <bun-target> <output-path>");
}
const target = rawTarget;

const serverDir = NodePath.resolve(import.meta.dirname, "..");
const repoRoot = NodePath.resolve(serverDir, "../..");
const webDist = NodePath.join(repoRoot, "apps", "web", "dist");
const webIndex = NodePath.join(webDist, "index.html");
if (!NodeFS.existsSync(webIndex)) {
  throw new Error(`The standalone web client has not been built: ${webIndex}`);
}
const webIndexContents = NodeFS.readFileSync(webIndex, "utf8");

function listFiles(root: string): string[] {
  return NodeFS.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = NodePath.join(root, entry.name);
    if (entry.isDirectory()) return listFiles(absolute);
    return entry.isFile() && !entry.name.endsWith(".map") ? [absolute] : [];
  });
}

const result = await Bun.build({
  entrypoints: [
    NodePath.join(serverDir, "src", "standalone-bin.ts"),
    ...listFiles(webDist).filter((file) => file !== webIndex),
  ],
  compile: {
    target,
    outfile: NodePath.resolve(serverDir, output),
  },
  root: repoRoot,
  minify: true,
  sourcemap: "linked",
  external: ["*NodeSqliteClient.ts"],
  plugins: [
    {
      name: "standalone-client-assets",
      setup(build) {
        build.onLoad({ filter: /.*/ }, async (args) => {
          if (!args.path.startsWith(`${webDist}${NodePath.sep}`)) return;
          return {
            contents: new Uint8Array(await Bun.file(args.path).arrayBuffer()),
            loader: "file",
          };
        });
      },
    },
  ],
  naming: {
    asset: "standalone-client/[dir]/[name].[ext]",
  },
  define: {
    __T3CODE_STANDALONE_INDEX_HTML__: JSON.stringify(webIndexContents),
    __T3CODE_BUILD_CHANNEL__: JSON.stringify(
      packageJson.version.includes("-nightly.") ? "nightly" : "latest",
    ),
    __T3CODE_BUILD_RELAY_URL__: JSON.stringify(process.env.T3CODE_RELAY_URL?.trim() ?? ""),
    __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: JSON.stringify(
      process.env.T3CODE_CLERK_PUBLISHABLE_KEY?.trim() ?? "",
    ),
    __T3CODE_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: JSON.stringify(
      process.env.T3CODE_CLERK_CLI_OAUTH_CLIENT_ID?.trim() ?? "",
    ),
    __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: JSON.stringify(
      process.env.T3CODE_RELAY_CLIENT_OTLP_TRACES_URL?.trim() ?? "",
    ),
    __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: JSON.stringify(
      process.env.T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() ?? "",
    ),
    __T3CODE_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: JSON.stringify(
      process.env.T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() ?? "",
    ),
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exitCode = 1;
}
