// Sets TestFlight "What to Test" for the build just uploaded, listing commits that
// touch the app since the previous TestFlight build. Run after upload, before tagging.
const { execFileSync } = require("node:child_process");
const { createPrivateKey, sign } = require("node:crypto");

const MAX_LENGTH = 4000;
const PATHS = ["apps/mobile", "packages/client-runtime", "packages/contracts", "packages/shared"];

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function buildNotes(base) {
  const range = base ? `${base}..HEAD` : "-50";
  const subjects = git("log", "--no-merges", "--format=%s", range, "--", ...PATHS)
    .split("\n")
    .filter(Boolean)
    .map((subject) => `• ${subject.replace(/^patch: /, "").replace(/ \(#\d+\)$/, "")}`);
  const body =
    subjects.length > 0 ? subjects.join("\n") : "Native dependency refresh; no app changes.";
  return `${base ? "Changes since the last TestFlight build:" : "Recent changes:"}\n${body}`.slice(
    0,
    MAX_LENGTH,
  );
}

function jwt({ keyId, issuer, key }) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({
    iss: issuer,
    exp: Math.floor(Date.now() / 1000) + 600,
    aud: "appstoreconnect-v1",
  })}`;
  const signature = sign("sha256", Buffer.from(input), {
    key: createPrivateKey(key),
    dsaEncoding: "ieee-p1363",
  });
  return `${input}.${signature.toString("base64url")}`;
}

async function main() {
  const { APPLE_API_KEY, APPLE_API_KEY_ID, APPLE_API_ISSUER, BUNDLE_ID, BUILD_NUMBER, BASE_REF } =
    process.env;
  const token = jwt({ keyId: APPLE_API_KEY_ID, issuer: APPLE_API_ISSUER, key: APPLE_API_KEY });
  const api = async (path, init) => {
    const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    });
    if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
    return response.json();
  };

  const notes = buildNotes(BASE_REF);
  console.log(notes);

  const app = (await api(`/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}`)).data[0];
  if (!app) throw new Error(`No App Store Connect app for ${BUNDLE_ID}`);

  // The build only appears once Apple has processed the upload.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const [build] = (await api(`/v1/builds?filter[app]=${app.id}&filter[version]=${BUILD_NUMBER}`))
      .data;
    if (build) {
      await api("/v1/betaBuildLocalizations", {
        method: "POST",
        body: JSON.stringify({
          data: {
            type: "betaBuildLocalizations",
            attributes: { locale: "en-US", whatsNew: notes },
            relationships: { build: { data: { type: "builds", id: build.id } } },
          },
        }),
      });
      console.log(`Set What to Test for build ${BUILD_NUMBER}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
  throw new Error(`Build ${BUILD_NUMBER} did not appear in App Store Connect within 30 minutes`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { buildNotes };
