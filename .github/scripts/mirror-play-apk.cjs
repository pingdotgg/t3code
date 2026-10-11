// Mirrors the newest build on a Google Play track to a rolling GitHub
// prerelease as a universal APK. Play generates and signs that APK from the
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

// Service account key -> OAuth access token via a self-signed JWT grant.
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
    return JSON.parse(gh("release", "view", tag, "--json", "assets,body"));
  } catch {
    return undefined;
  }
}

// Downloads the build's universal APK and uploads it, creating the release on
// first use. Returns false when Play lists no universal APK, which happens
// while it is still processing a fresh upload.
async function uploadApk({ token, appUrl, build, tag, apkName, notes, release }) {
  const generated = await (
    await play(token, "GET", `${appUrl}/generatedApks/${build.versionCode}`)
  ).json();
  // One entry per app signing key. More than one means a key rotation, so
  // fail rather than guess which signature testers should get.
  const universal = (generated.generatedApks ?? []).filter((entry) => entry.generatedUniversalApk);
  if (universal.length === 0) return false;
  if (universal.length > 1) {
    throw new Error(`Play returned ${universal.length} universal APKs, one per signing key.`);
  }
  const { downloadId } = universal[0].generatedUniversalApk;

  const apkPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "apk-")), apkName);
  const download = await play(
    token,
    "GET",
    `${appUrl}/generatedApks/${build.versionCode}/downloads/${encodeURIComponent(downloadId)}:download?alt=media`,
  );
  await pipeline(Readable.fromWeb(download.body), fs.createWriteStream(apkPath));

  if (!release) {
    // Prerelease with a non-v tag: release.yml, the desktop updater, the CLI,
    // and the marketing site's latest-release lookup all ignore it.
    gh(
      "release",
      "create",
      tag,
      "--prerelease",
      "--latest=false",
      "--title",
      "T3 Code for Android (nightly)",
      "--notes",
      notes,
    );
  }
  // --clobber replaces an asset a failed upload left behind.
  gh("release", "upload", tag, apkPath, "--clobber");
  return true;
}

async function main() {
  const packageName = requireEnv("PACKAGE_NAME");
  const trackName = requireEnv("PLAY_TRACK");
  const tag = requireEnv("RELEASE_TAG");
  const key = JSON.parse(requireEnv("GOOGLE_PLAY_SERVICE_ACCOUNT_JSON"));
  const summary = (line) =>
    process.env.GITHUB_STEP_SUMMARY &&
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);

  const token = await playAccessToken(key);
  const appUrl = `${PLAY_API}/${packageName}`;
  const build = await newestTrackBuild(token, appUrl, trackName);
  if (!build) {
    console.log(`The ${trackName} track has no live release.`);
    return;
  }

  const safeName = build.versionName.replace(/[^0-9A-Za-z.]+/g, "-").replace(/^-|-$/g, "");
  const apkName = `t3code-android-${safeName}-${build.versionCode}.apk`;
  const notes = [
    `T3 Code for Android that works with nightly servers, mirrored from the Google Play ${trackName} track. Current build: ${build.versionName} (${build.versionCode}).`,
    "",
    "The Play Store release can't connect to a nightly server yet. Install this APK if you can't join the Play testing group. Only the newest build is kept here.",
  ].join("\n");

  const release = readRelease(tag);
  const assets = release?.assets ?? [];
  // A failed upload can leave an empty asset under the final name.
  const published = assets.some(
    (asset) => asset.name === apkName && asset.state === "uploaded" && asset.size > 0,
  );
  if (published) {
    console.log(`${apkName} is already published.`);
  } else if (await uploadApk({ token, appUrl, build, tag, apkName, notes, release })) {
    console.log(`Published ${apkName}.`);
    summary(`:white_check_mark: Published \`${apkName}\` to the \`${tag}\` release.`);
  } else {
    // The next run retries.
    console.log(`Play lists no universal APK for ${build.versionCode}.`);
    summary(
      `:hourglass: Play lists no universal APK for ${build.versionName} (${build.versionCode}).`,
    );
    return;
  }

  // Reconciled on every run so an interrupted cleanup finishes on the next one.
  for (const stale of assets) {
    if (stale.name.endsWith(".apk") && stale.name !== apkName) {
      gh("release", "delete-asset", tag, stale.name, "--yes");
    }
  }
  if (release && release.body.replace(/\r\n/g, "\n").trim() !== notes) {
    gh("release", "edit", tag, "--notes", notes);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
