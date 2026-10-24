// GitHub creates at most 256 jobs from one matrix and fails the whole run when
// a matrix asks for more, so the label job never starts.
const MAX_MATRIX_JOBS = 256;
const TRUST_LIST_PATH = ".github/VOUCHED.td";

// Maps each GitHub handle in a VOUCHED.td file to "vouched" or "denounced",
// read the way mitchellh/vouch check-user reads it (vouch/file.nu parse-line
// and parse-handle, vouch/lib.nu check-user): the whole handle is lowercased,
// details start at the first space, an entry without a platform applies to
// GitHub, and the first entry for a handle decides its status.
function parseTrustList(text) {
  const statuses = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
    if (line === "" || line.startsWith("#")) continue;
    const denounced = line.startsWith("-");
    const handle = (denounced ? line.slice(1) : line).split(" ", 1)[0].toLowerCase();
    const separator = handle.indexOf(":");
    if (separator !== -1 && handle.slice(0, separator) !== "github") continue;
    const username = handle.slice(separator + 1);
    if (!statuses.has(username)) statuses.set(username, denounced ? "denounced" : "vouched");
  }
  return statuses;
}

function changedHandles(beforeText, afterText) {
  const before = parseTrustList(beforeText);
  const after = parseTrustList(afterText);
  const changed = new Set();
  for (const handle of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(handle) !== after.get(handle)) changed.add(handle);
  }
  return changed;
}

// `pulls` comes most recently updated first, so the cap keeps the newest PRs.
// The REST API types a pull's `user` as nullable, so skip PRs without one.
function selectTargets(pulls, handles) {
  const matching = pulls
    .filter((pull) => pull.user !== null && handles.has(pull.user.login.toLowerCase()))
    .map((pull) => ({ number: pull.number, user: pull.user.login }));
  return {
    targets: matching.slice(0, MAX_MATRIX_JOBS),
    skipped: matching.slice(MAX_MATRIX_JOBS),
  };
}

async function readTrustList({ github, context, ref }) {
  try {
    const { data } = await github.rest.repos.getContent({
      ...context.repo,
      path: TRUST_LIST_PATH,
      ref,
    });
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    // A missing file or unreadable commit counts as an empty list, so every
    // listed author is relabeled instead of none.
    if (error.status === 404) return "";
    throw error;
  }
}

// A trust-list push relabels only the open PRs whose author's status changed.
async function collectPushTargets({ github, context, core }) {
  const [beforeText, afterText] = await Promise.all([
    readTrustList({ github, context, ref: context.payload.before }),
    readTrustList({ github, context, ref: context.sha }),
  ]);
  const handles = changedHandles(beforeText, afterText);
  if (handles.size === 0) {
    core.info("No trust status changed.");
    return [];
  }

  const pulls = await github.paginate(github.rest.pulls.list, {
    ...context.repo,
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  const { targets, skipped } = selectTargets(pulls, handles);
  core.info(`Changed handles: ${[...handles].join(", ")}. Relabeling ${targets.length} PRs.`);
  if (skipped.length > 0) {
    core.warning(
      `Skipped ${skipped.length} PRs over the ${MAX_MATRIX_JOBS}-job matrix limit: ` +
        `${skipped.map((target) => `#${target.number}`).join(", ")}. ` +
        "Comment /recheck-vouch on each to relabel it.",
    );
  }
  return targets;
}

module.exports = {
  MAX_MATRIX_JOBS,
  changedHandles,
  collectPushTargets,
  selectTargets,
};
