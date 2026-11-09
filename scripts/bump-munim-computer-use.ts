#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalFetch:off globalTimers:off - a tiny standalone CLI.
// Pin the newest munim-computer-use release when it is newer than
// native/munim-computer-use.json, then download every pinned asset and check it
// against the release's SHA256SUMS. Leaves the pin untouched when it is current.
// The fleet release commits the file if this changed it.
//
//   node scripts/bump-munim-computer-use.ts
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  parseMunimComputerUseManifest,
  type MunimComputerUseAssetKey,
} from "@t3tools/shared/munimComputerUse";

import { bumpedManifest, parseSha256Sums } from "./lib/munim-computer-use-bump.ts";
import { fetchPinnedAsset } from "./lib/munim-computer-use.ts";

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const manifestPath = NodePath.join(repoRoot, "native/munim-computer-use.json");
const text = await NodeFSP.readFile(manifestPath, "utf8");
const manifest = parseMunimComputerUseManifest(text);

const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
const headers: Record<string, string> = {
  accept: "application/vnd.github+json",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
};
const latestResponse = await fetch(
  `https://api.github.com/repos/${manifest.repository}/releases/latest`,
  { headers },
);
if (!latestResponse.ok) {
  throw new Error(
    `could not read the latest ${manifest.repository} release: ${latestResponse.status}`,
  );
}
const { tag_name: tag, assets: releaseAssets = [] } = (await latestResponse.json()) as {
  tag_name: string;
  assets?: ReadonlyArray<{ name: string; url: string }>;
};
const latest = tag.replace(/^v/, "");

// github.com download links sometimes 504 while the API still serves assets,
// so read SHA256SUMS through the API first and retry before giving up.
async function fetchSha256Sums(): Promise<string> {
  const apiUrl = releaseAssets.find((asset) => asset.name === "SHA256SUMS.txt")?.url;
  const sources = [
    ...(apiUrl
      ? [{ url: apiUrl, init: { headers: { ...headers, accept: "application/octet-stream" } } }]
      : []),
    {
      url: `https://github.com/${manifest.repository}/releases/download/${tag}/SHA256SUMS.txt`,
      init: {},
    },
  ];
  let lastStatus = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const source of sources) {
      const response = await fetch(source.url, source.init);
      if (response.ok) return response.text();
      lastStatus = response.status;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000 * (attempt + 1)));
  }
  throw new Error(`${manifest.repository} ${tag} has no SHA256SUMS.txt: ${lastStatus}`);
}

const next = bumpedManifest(manifest, latest, parseSha256Sums(await fetchSha256Sums()));
if (next === null) {
  console.log(`munim-computer-use ${manifest.version} is current (latest ${latest})`);
} else {
  // Verify every asset against the new checksums before touching the pin, so
  // a bad download never leaves an unverified version pinned.
  for (const key of Object.keys(next.assets) as MunimComputerUseAssetKey[]) {
    await fetchPinnedAsset({
      manifest: next,
      key,
      environment: process.env,
      log: (message) => console.log(message),
    });
  }
  // Rewrite only the version and checksums, keeping the file's other keys.
  const raw = JSON.parse(text) as {
    version: string;
    assets: Record<string, { sha256: string }>;
  };
  raw.version = next.version;
  for (const [key, asset] of Object.entries(next.assets)) raw.assets[key]!.sha256 = asset.sha256;
  await NodeFSP.writeFile(manifestPath, `${JSON.stringify(raw, null, 2)}\n`);
  console.log(
    `munim-computer-use pinned ${manifest.version} -> ${next.version}, all assets verified`,
  );
}
