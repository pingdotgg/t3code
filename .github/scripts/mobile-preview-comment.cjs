const PROJECT_ID = "d763fcb8-d37c-41ea-a773-b54a0ab4a454";
const APP_SCHEME = "t3-code";

function readState(body) {
  const match = /^<!-- mobile-preview(?:-(android|ios))? (\{.*\}) -->/.exec(body ?? "");
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[2]);
    const state = match[1] ? { [match[1]]: parsed } : parsed;
    const text = (value) => (typeof value === "string" ? value : "");
    return Object.fromEntries(
      ["android", "ios"]
        .filter((platform) => state?.[platform])
        .map((platform) => [
          platform,
          {
            fingerprint: text(state[platform].fingerprint),
            client: text(state[platform].client),
            group: text(state[platform].group),
          },
        ]),
    );
  } catch {
    return null;
  }
}

/**
 * New values win; a new fingerprint drops the old fingerprint's client. A build that finishes
 * after the PR moved to another fingerprint changes nothing: its client cannot run the update
 * the comment now shows.
 */
function mergeState(previous, next) {
  if (!next.client && !next.group) return previous;
  const buildOnly = Boolean(next.client) && !next.group;
  if (
    buildOnly &&
    previous?.fingerprint &&
    next.fingerprint &&
    previous.fingerprint !== next.fingerprint
  ) {
    return previous;
  }
  const fingerprint = next.fingerprint || previous?.fingerprint || "";
  const sameFingerprint = !previous?.fingerprint || previous.fingerprint === fingerprint;
  return {
    fingerprint,
    client: next.client || (sameFingerprint ? (previous?.client ?? "") : ""),
    group: next.group || previous?.group || "",
  };
}

function render(state, runUrl) {
  const platforms = ["android", "ios"];
  const cells = (value) => platforms.map((platform) => value(state[platform]));
  const rows = [
    `<!-- mobile-preview ${JSON.stringify(state)} -->`,
    "🚀 Mobile preview",
    "",
    "&nbsp; | 🤖 Android | 🍎 iOS",
    "--- | --- | ---",
    `Fingerprint | ${cells((entry) => entry?.fingerprint || "n/a").join(" | ")}`,
    `Dev client | ${cells((entry) => (entry?.client ? `[Install](${entry.client})` : entry?.fingerprint ? `Client unavailable ([build run](${runUrl}))` : "n/a")).join(" | ")}`,
    `Update Details | ${cells((entry) => (entry?.group ? `[Update Permalink](https://expo.dev/projects/${PROJECT_ID}/updates/${entry.group})` : "n/a")).join(" | ")}`,
    `Update QR | ${cells((entry) => {
      if (!entry?.group) return "n/a";
      const qr = `https://qr.expo.dev/eas-update?appScheme=${APP_SCHEME}&projectId=${PROJECT_ID}&groupId=${entry.group}`;
      return `<a href="${qr}"><img src="${qr}" width="250px" height="250px" /></a>`;
    }).join(" | ")}`,
  ];
  return rows.join("\n");
}

async function github(path, init = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${process.env.GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub ${init.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
    );
  }
  return response.status === 204 ? null : response.json();
}

async function main({ env = process.env, request = github } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const pr = env.PR;
  if (!repository || !pr || !env.GH_TOKEN) {
    throw new Error("GITHUB_REPOSITORY, PR and GH_TOKEN are required.");
  }
  if (!env.ANDROID_FINGERPRINT && !env.IOS_FINGERPRINT) return;
  if (env.PR_HEAD_SHA) {
    const pull = await request(`/repos/${repository}/pulls/${pr}`);
    if (pull.head.sha !== env.PR_HEAD_SHA) return;
  }
  const runUrl = `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`;
  const previews = [];
  for (let page = 1; ; page++) {
    const comments = await request(
      `/repos/${repository}/issues/${pr}/comments?per_page=100&page=${page}`,
    );
    previews.push(
      ...comments.filter(
        (comment) =>
          comment.user?.login === "github-actions[bot]" &&
          (readState(comment.body) !== null ||
            comment.body?.startsWith(
              `<!-- continuous-deploy-fingerprint-projectId:${PROJECT_ID} -->`,
            )),
      ),
    );
    if (comments.length < 100) break;
  }
  const existing =
    previews.find((comment) => comment.body.startsWith("<!-- mobile-preview ")) ?? previews[0];
  const state = Object.assign(
    {},
    ...previews.map((comment) => readState(comment.body)),
    readState(existing?.body),
  );
  for (const platform of ["android", "ios"]) {
    const prefix = platform.toUpperCase();
    const next = {
      fingerprint: env[`${prefix}_FINGERPRINT`] ?? "",
      client: env[`${prefix}_CLIENT`] ?? "",
      group: env[`${prefix}_GROUP`] ?? "",
    };
    if (next.fingerprint) state[platform] = mergeState(state[platform], next);
  }
  const body = JSON.stringify({ body: render(state, runUrl) });
  if (existing) {
    await request(`/repos/${repository}/issues/comments/${existing.id}`, { method: "PATCH", body });
  } else {
    await request(`/repos/${repository}/issues/${pr}/comments`, { method: "POST", body });
  }
  for (const comment of previews) {
    if (comment.id !== existing.id) {
      await request(`/repos/${repository}/issues/comments/${comment.id}`, { method: "DELETE" });
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { main, mergeState, readState, render };
