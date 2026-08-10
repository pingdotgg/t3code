import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

const manifestUrl = new URL("../src/content/verified-releases.json", import.meta.url);
const releasePrefix = "/AuldricAI/auldrics/releases/download/";
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const maxRedirects = 5;
const platforms = new Set([
  "macos-apple-silicon",
  "macos-intel",
  "windows-x64",
  "windows-arm64",
  "linux-x64",
]);

interface ReleaseArtifactInput {
  readonly id: string;
  readonly url: string;
  readonly sha256: string;
}

function isGitHubReleaseStorageUrl(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    (url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com"))
  );
}

function parseAllowedRedirect(value: string, base: URL, artifactId: string): URL {
  let target: URL;
  try {
    target = new URL(value, base);
  } catch {
    fail(`artifact ${artifactId} returned an invalid redirect location`);
  }
  if (!isGitHubReleaseStorageUrl(target)) {
    fail(`artifact ${artifactId} redirected outside HTTPS GitHub release storage`);
  }
  return target;
}

function fail(message: string): never {
  throw new Error(`Auldric release manifest: ${message}`);
}

export function decodeReleaseManifest(value: unknown): ReadonlyArray<ReleaseArtifactInput> {
  if (
    typeof value !== "object" ||
    value === null ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("artifacts" in value) ||
    !Array.isArray(value.artifacts)
  ) {
    fail("expected schemaVersion 1 and an artifacts array");
  }

  const ids = new Set<string>();
  return value.artifacts.map((artifact: unknown, index: number) => {
    if (typeof artifact !== "object" || artifact === null) {
      fail(`artifact ${index} is not an object`);
    }

    if (
      !("id" in artifact) ||
      !("url" in artifact) ||
      !("fileName" in artifact) ||
      !("platform" in artifact) ||
      !("version" in artifact) ||
      !("sha256" in artifact)
    ) {
      fail(`artifact ${index} is missing required fields`);
    }

    const { id, url, fileName, platform, version, sha256 } = artifact;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/u.test(id) || ids.has(id)) {
      fail(`artifact ${index} has an invalid or duplicate id`);
    }
    ids.add(id);

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(typeof url === "string" ? url : "");
    } catch {
      fail(`artifact ${id} has an invalid URL`);
    }

    if (
      !isGitHubReleaseStorageUrl(parsedUrl) ||
      parsedUrl.hostname !== "github.com" ||
      !parsedUrl.pathname.startsWith(releasePrefix) ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      fail(`artifact ${id} must use the exact Auldric GitHub release path`);
    }
    const releasePathParts = parsedUrl.pathname.slice(releasePrefix.length).split("/");
    if (releasePathParts.length !== 2 || releasePathParts.some((part) => part.length === 0)) {
      fail(`artifact ${id} must contain one release tag and one filename`);
    }
    if (
      typeof fileName !== "string" ||
      decodeURIComponent(parsedUrl.pathname.split("/").at(-1) ?? "") !== fileName
    ) {
      fail(`artifact ${id} filename does not match its URL`);
    }
    if (typeof platform !== "string" || !platforms.has(platform)) {
      fail(`artifact ${id} has an unsupported platform`);
    }
    if (typeof version !== "string" || !/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
      fail(`artifact ${id} has an invalid version`);
    }
    const normalizedVersion = version.startsWith("v") ? version.slice(1) : version;
    const releaseTag = releasePathParts[0];
    if (releaseTag !== normalizedVersion && releaseTag !== `v${normalizedVersion}`) {
      fail(`artifact ${id} release tag does not match its version`);
    }
    if (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256)) {
      fail(`artifact ${id} has an invalid SHA-256`);
    }

    return { id, url: parsedUrl.toString(), sha256 };
  });
}

export async function verifyReleaseArtifacts(
  manifest: unknown,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const artifacts = decodeReleaseManifest(manifest);
  for (const artifact of artifacts) {
    const signal = AbortSignal.timeout(60_000);
    let currentUrl = new URL(artifact.url);
    let response: Response;
    let redirects = 0;

    while (true) {
      if (!isGitHubReleaseStorageUrl(currentUrl)) {
        fail(`artifact ${artifact.id} attempted a request outside HTTPS GitHub release storage`);
      }
      response = await fetcher(currentUrl, {
        headers: { "user-agent": "auldric-public-release-verifier" },
        redirect: "manual",
        signal,
      });
      if (!redirectStatuses.has(response.status)) break;

      if (redirects >= maxRedirects) {
        fail(`artifact ${artifact.id} exceeded ${maxRedirects} redirects`);
      }
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) fail(`artifact ${artifact.id} returned a redirect without a location`);
      currentUrl = parseAllowedRedirect(location, currentUrl, artifact.id);
      redirects += 1;
    }

    if (!response.ok) fail(`artifact ${artifact.id} returned HTTP ${response.status}`);
    if (response.url) {
      const responseUrl = new URL(response.url);
      if (!isGitHubReleaseStorageUrl(responseUrl)) {
        fail(`artifact ${artifact.id} returned bytes outside HTTPS GitHub release storage`);
      }
    }

    if (!response.body) fail(`artifact ${artifact.id} returned no body`);
    const hash = NodeCrypto.createHash("sha256");
    for await (const chunk of response.body) hash.update(chunk);
    const digest = hash.digest("hex");
    if (digest !== artifact.sha256) {
      fail(`artifact ${artifact.id} SHA-256 mismatch (received ${digest})`);
    }
  }

  return artifacts.length;
}

async function main(): Promise<void> {
  const source = await NodeFSP.readFile(manifestUrl, "utf8");
  const count = await verifyReleaseArtifacts(JSON.parse(source) as unknown);
  console.log(`Verified ${count} configured Auldric release artifact(s).`);
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === NodeURL.pathToFileURL(entryPath).href) {
  await main();
}
