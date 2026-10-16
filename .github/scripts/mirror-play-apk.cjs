// Publishes closed-testing betas, or downloads the internal APK for a normal
// nightly release. Play generates and signs the APK from the
// uploaded bundle with the app signing key, so it carries the same signature
// as the Play Store install. Run by .github/workflows/mobile-android-apk.yml.
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");

const PLAY_API = "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function playAccessToken(key) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: key.token_uri,
    iat: now,
    exp: now + 600,
  })}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(unsigned), key.private_key);
  const response = await fetch(key.token_uri, {
    method: "POST",
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature.toString("base64url")}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google token exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()).access_token;
}

async function play(token, method, url) {
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`${method} ${url} failed: ${response.status} ${await response.text()}`);
  }
  return response;
}

// Highest version code the track serves, with its release name. Play names a
// release after the bundle's versionName unless the uploader sets one. This
// endpoint reads without opening an edit; an edit would invalidate any open
// EAS Submit edit made with the same service account.
async function newestTrackBuild(token, appUrl, trackName) {
  const { releases = [] } = await (
    await play(token, "GET", `${appUrl}/tracks/${trackName}/releases`)
  ).json();
  let newest;
  for (const release of releases) {
    if (release.releaseLifecycleState !== "RELEASE_LIFECYCLE_STATE_PUBLISHED") continue;
    for (const { versionCode } of release.activeArtifacts ?? []) {
      if (!newest || versionCode > newest.versionCode) {
        newest = { versionCode, versionName: release.releaseName || String(versionCode) };
      }
    }
  }
  return newest;
}

function gh(...args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function readRelease(tag) {
  try {
    return JSON.parse(gh("release", "view", tag, "--json", "assets,body,isDraft"));
  } catch {
    return undefined;
  }
}

// Download to a temporary directory so a failed request cannot leave a partial
// APK among the release assets.
async function downloadApk({ token, appUrl, build, apkName }) {
  const generated = await (
    await play(token, "GET", `${appUrl}/generatedApks/${build.versionCode}`)
  ).json();
  const universal = (generated.generatedApks ?? []).filter((entry) => entry.generatedUniversalApk);
  if (universal.length === 0) return undefined;
  if (universal.length > 1) {
    throw new Error(`Play returned ${universal.length} universal APKs, one per signing key.`);
  }
  const { downloadId } = universal[0].generatedUniversalApk;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "apk-"));
  const apkPath = path.join(directory, apkName);
  try {
    const download = await play(
      token,
      "GET",
      `${appUrl}/generatedApks/${build.versionCode}/downloads/${encodeURIComponent(downloadId)}:download?alt=media`,
    );
    await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(apkPath));
    return apkPath;
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

function publishBeta(tag, apkPath, notes, title) {
  const release = readRelease(tag);
  if (
    release &&
    !release.isDraft &&
    release.assets.some(
      (asset) =>
        asset.name === path.basename(apkPath) && asset.state === "uploaded" && asset.size > 0,
    )
  )
    return;
  if (!release) {
    gh(
      "release",
      "create",
      tag,
      "--draft",
      "--prerelease",
      "--latest=false",
      "--title",
      title,
      "--notes",
      notes,
    );
  }
  gh("release", "upload", tag, apkPath, "--clobber");
  gh(
    "release",
    "edit",
    tag,
    "--draft=false",
    "--prerelease",
    "--latest=false",
    "--title",
    title,
    "--notes",
    notes,
  );
}

async function main() {
  const packageName = requireEnv("PACKAGE_NAME");
  const outputDirectory = process.env.APK_OUTPUT_DIR;
  const channel = outputDirectory ? "internal" : "beta";
  const track = outputDirectory ? "internal" : "alpha";
  const token = await playAccessToken(JSON.parse(requireEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON")));
  const appUrl = `${PLAY_API}/${packageName}`;
  const build = await newestTrackBuild(token, appUrl, track);
  if (!build) {
    console.log(`The ${track} track has no live release.`);
    return;
  }
  const safeName = build.versionName.replace(/[^0-9A-Za-z.]+/g, "-").replace(/^-|-$/g, "");
  const apkName = `t3code-android-${channel}-${safeName}-${build.versionCode}.apk`;
  const tag = `android-beta-${build.versionCode}`;
  const release = outputDirectory ? undefined : readRelease(tag);
  if (
    release &&
    !release.isDraft &&
    release.assets.some(
      (asset) => asset.name === apkName && asset.state === "uploaded" && asset.size > 0,
    )
  ) {
    console.log(`${apkName} is already published.`);
    return;
  }
  const apkPath = await downloadApk({ token, appUrl, build, apkName });
  if (!apkPath) {
    console.log(`Play is still processing the ${track} APK for ${build.versionCode}.`);
    return;
  }
  try {
    if (outputDirectory) {
      fs.mkdirSync(outputDirectory, { recursive: true });
      const destination = path.join(outputDirectory, apkName);
      const temporary = `${destination}.tmp`;
      try {
        fs.copyFileSync(apkPath, temporary);
        fs.renameSync(temporary, destination);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      return;
    }
    const notes = [
      `T3 Code for Android beta, mirrored from Google Play closed testing. Build: ${build.versionName} (${build.versionCode}).`,
      "",
      "These builds have been promoted for wider testing, but may still contain bugs. The beta is optional; the store app also works with Nightly servers.",
    ].join("\n");
    // The build number makes retries and unchanged hourly checks idempotent.
    publishBeta(tag, apkPath, notes, `Android beta ${build.versionName} (${build.versionCode})`);
  } finally {
    fs.rmSync(path.dirname(apkPath), { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
