const fs = require("node:fs");

const HOUR_MS = 60 * 60 * 1000;
const OPEN_LIMIT = 3;
const CONFLICT_IDLE_MS = 7 * 24 * HOUR_MS;
const NOTICE_MS = 72 * HOUR_MS;
// A first run meets the whole backlog. These keep one run from flooding watchers or GitHub's
// limit on how fast a token may comment.
const MAX_REQUESTS_PER_RUN = 100;
const MAX_CLOSES_PER_RUN = 50;
const WRITE_PAUSE_MS = 1_000;
// Measured here: about two and a half minutes until every open PR has an answer.
const MERGEABLE_WAIT_MS = 150_000;
// GitHub stamps a label event and the PR's updatedAt a second or two apart.
const SAME_MOMENT_MS = 15_000;

const REBASE_LABEL = "needs-rebase";
const CLOSING_LABEL = "triage:closing";
const KEEP_OPEN_LABEL = "triage:keep-open";
const UNVOUCHED_LABEL = "vouch:unvouched";
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);
const EXEMPTIONS_PATH = ".github/TRIAGE_EXEMPTIONS.td";
const VOUCHED_PATH = ".github/VOUCHED.td";
const LOGIN_PATTERN = /^github:([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/;

// `labels` matches a PR that carries any one of them.
const SWEEP_QUERY = `
  query ($owner: String!, $repo: String!, $labels: [String!], $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: OPEN, labels: $labels, first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          mergeable
          baseRefName
          updatedAt
          author { login }
          labels(first: 100) { nodes { name } }
          timelineItems(itemTypes: [LABELED_EVENT], last: 20) {
            nodes { ... on LabeledEvent { createdAt label { name } } }
          }
        }
      }
    }
  }`;

const RECHECK_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        state
        mergeable
        updatedAt
        labels(first: 100) { nodes { name } }
      }
    }
  }`;

const AUTHOR_OPEN_PRS_QUERY = `
  query ($q: String!) {
    search(query: $q, type: ISSUE, first: 50) {
      nodes { ... on PullRequest { number } }
    }
  }`;

// Fails closed: a missing, empty, or malformed list must never read as "nobody is exempt".
function parseExemptions(text) {
  const logins = new Set();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = LOGIN_PATTERN.exec(line);
    if (!match) throw new Error(`${EXEMPTIONS_PATH}: malformed entry "${line}"`);
    const login = match[1].toLowerCase();
    if (logins.has(login)) throw new Error(`${EXEMPTIONS_PATH}: duplicate entry "${line}"`);
    logins.add(login);
  }
  if (logins.size === 0) throw new Error(`${EXEMPTIONS_PATH}: no entries`);
  return logins;
}

// VOUCHED.td: one `github:login` per line, `#` comments, and `-github:login reason` to denounce.
function vouchedLogins(text) {
  const logins = new Set();
  for (const raw of text.split("\n")) {
    const entry = raw.trim().split(/\s+/)[0];
    if (entry.startsWith("github:")) logins.add(entry.slice("github:".length).toLowerCase());
  }
  if (logins.size === 0) throw new Error(`${VOUCHED_PATH}: no entries`);
  return logins;
}

function labeledAt(pr, name) {
  const last = pr.timelineItems.nodes.filter((event) => event.label?.name === name).at(-1);
  return last ? Date.parse(last.createdAt) : undefined;
}

// The whole policy for the two windows. Activity is anything that moves the PR's updatedAt: a
// push, a comment, a review, a label. Nobody can set that time, so nothing here trusts the author.
function decide(pr, exemptions, now) {
  const labels = new Set(pr.labels.nodes.map((label) => label.name));
  if (labels.has(KEEP_OPEN_LABEL)) return "skip";
  const updatedAt = Date.parse(pr.updatedAt);

  if (labels.has(CLOSING_LABEL)) {
    const since = labeledAt(pr, CLOSING_LABEL);
    if (since === undefined) return "unknown-notice";
    // Any activity after the notice sends the PR back to triage.
    if (updatedAt - since > SAME_MOMENT_MS) return "clear-notice";
    return now - since >= NOTICE_MS ? "close-notice" : "skip";
  }

  const exempt = exemptions.has((pr.author?.login ?? "").toLowerCase());
  const subject = labels.has(UNVOUCHED_LABEL) && !exempt;
  if (labels.has(REBASE_LABEL)) {
    if (!subject || pr.mergeable === "MERGEABLE") return "clear-rebase";
    // Activity restarts the seven days and keeps the label, so a PR is asked to rebase once.
    const idle = now - updatedAt >= CONFLICT_IDLE_MS;
    return idle && pr.mergeable === "CONFLICTING" ? "close-conflict" : "skip";
  }
  return subject && pr.mergeable === "CONFLICTING" ? "request-rebase" : "skip";
}

function guideLink(context, anchor) {
  return `https://github.com/${context.repo.owner}/${context.repo.repo}/blob/main/CONTRIBUTING.md#${anchor}`;
}

async function removeLabel(github, context, number, name) {
  try {
    await github.rest.issues.removeLabel({ ...context.repo, issue_number: number, name });
  } catch (error) {
    if (error.status !== 404) throw error;
  }
}

async function closeWithComment(github, context, number, body) {
  await github.rest.issues.createComment({ ...context.repo, issue_number: number, body });
  await github.rest.pulls.update({ ...context.repo, pull_number: number, state: "closed" });
}

async function sweep({ github, context, core, dryRun }) {
  const exemptions = parseExemptions(fs.readFileSync(EXEMPTIONS_PATH, "utf8"));
  const repo = { owner: context.repo.owner, repo: context.repo.repo };
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const list = async () => {
    const prs = [];
    for (let cursor = null; ;) {
      const page = (
        await github.graphql(SWEEP_QUERY, {
          ...repo,
          cursor,
          labels: [UNVOUCHED_LABEL, REBASE_LABEL, CLOSING_LABEL],
        })
      ).repository.pullRequests;
      prs.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) return prs;
      cursor = page.pageInfo.endCursor;
    }
  };
  // GitHub computes mergeability lazily and forgets it whenever the base moves. Asking starts the
  // computation, so ask once more. A PR that is still unknown waits for tomorrow's run.
  let prs = await list();
  if (prs.some((pr) => pr.mergeable === "UNKNOWN")) {
    await pause(MERGEABLE_WAIT_MS);
    prs = await list();
  }

  const now = Date.now();
  const count = {};
  for (const pr of prs) {
    const { number } = pr;
    let action = decide(pr, exemptions, now);
    if (action === "skip") continue;
    if (action === "unknown-notice") {
      core.warning(`#${number}: cannot tell when ${CLOSING_LABEL} was applied, leaving it open.`);
      continue;
    }
    if (action === "request-rebase" && (count[action] ?? 0) >= MAX_REQUESTS_PER_RUN) continue;
    if (action.startsWith("close")) {
      if ((count["close-conflict"] ?? 0) + (count["close-notice"] ?? 0) >= MAX_CLOSES_PER_RUN) {
        continue;
      }
      // The list is minutes old by now. Closing is the one step worth a second look.
      const fresh = (await github.graphql(RECHECK_QUERY, { ...repo, number })).repository
        .pullRequest;
      if (fresh.state !== "OPEN") continue;
      // A merge to the base can resolve a conflict without touching the PR, so this is re-read
      // too. An answer that is not ready yet reads as "not conflicting" and waits for tomorrow.
      action = decide({ ...pr, ...fresh }, exemptions, now);
      if (!action.startsWith("close")) continue;
    }

    count[action] = (count[action] ?? 0) + 1;
    core.info(`#${number} ${action}${dryRun ? " (dry run)" : ""}`);
    if (dryRun) continue;

    if (action === "request-rebase") {
      // The request goes first: a label without it would start a clock nobody was told about.
      await github.rest.issues.createComment({
        ...context.repo,
        issue_number: number,
        body: [
          `This PR conflicts with \`${pr.baseRefName}\`. Rebase it or merge \`${pr.baseRefName}\` into it. If it still conflicts after 7 days with no activity, it will be closed automatically.`,
          "",
          `See the [conflict window](${guideLink(context, "conflict-window")}).`,
        ].join("\n"),
      });
      await github.rest.issues.addLabels({
        ...context.repo,
        issue_number: number,
        labels: [REBASE_LABEL],
      });
    } else if (action === "clear-rebase") {
      await removeLabel(github, context, number, REBASE_LABEL);
    } else if (action === "clear-notice") {
      await removeLabel(github, context, number, CLOSING_LABEL);
    } else {
      const conflict = action === "close-conflict";
      await closeWithComment(
        github,
        context,
        number,
        conflict
          ? [
              `Closing: this PR still conflicts with \`${pr.baseRefName}\` and has had no activity for 7 days since the rebase request.`,
              "",
              `To continue, rebase the branch and open a new PR that links this one. See the [conflict window](${guideLink(context, "conflict-window")}).`,
            ].join("\n")
          : [
              "Closing: 72 hours have passed since the triage notice above with no activity on this PR.",
              "",
              `To ask for reconsideration, address the notice and comment here, or open a focused replacement PR that links this one. See [closure and reconsideration](${guideLink(context, "closure-and-reconsideration")}).`,
            ].join("\n"),
      );
      // Without this a maintainer's reopen would be closed again by the next run.
      await removeLabel(github, context, number, conflict ? REBASE_LABEL : CLOSING_LABEL);
    }
    await pause(WRITE_PAUSE_MS);
  }

  const summary = Object.entries(count).map(([action, n]) => `${n} ${action}`);
  core.info(
    `${dryRun ? "Dry run. " : ""}${prs.length} PRs read: ${summary.join(", ") || "nothing to do"}.`,
  );
  return count;
}

async function enforceOpenLimit({ github, context, core, dryRun }) {
  const pr = context.payload.pull_request;
  const author = pr.user.login;
  // Who is trusted is decided here rather than by the vouch action, which reports its own failed
  // lookups as "not vouched". Every read below throws on failure, and a throw closes nothing.
  if (pr.user.type === "Bot") return;
  if (parseExemptions(fs.readFileSync(EXEMPTIONS_PATH, "utf8")).has(author.toLowerCase())) return;
  if (vouchedLogins(fs.readFileSync(VOUCHED_PATH, "utf8")).has(author.toLowerCase())) return;
  const { data: access } = await github.rest.repos.getCollaboratorPermissionLevel({
    ...context.repo,
    username: author,
  });
  if (WRITE_PERMISSIONS.has(access.permission)) return;
  if (pr.labels.some((label) => label.name === KEEP_OPEN_LABEL)) return;
  // Someone else reopening a PR is a maintainer overriding the limit.
  const reopened = context.payload.action === "reopened";
  if (reopened && context.payload.sender.login.toLowerCase() !== author.toLowerCase()) return;

  const q = `repo:${context.repo.owner}/${context.repo.repo} is:pr is:open author:${author} sort:created-asc`;
  const { search } = await github.graphql(AUTHOR_OPEN_PRS_QUERY, { q });
  // A new PR counts only the older ones, so two opened together cannot close each other.
  const others = search.nodes.filter(
    (node) => node.number && (reopened ? node.number !== pr.number : node.number < pr.number),
  ).length;
  if (others < OPEN_LIMIT) {
    core.info(`PR #${pr.number}: ${author} has ${others} other open PRs.`);
    return;
  }
  if (dryRun) {
    core.notice(`Dry run. PR #${pr.number} would close: ${author} has ${others} other open PRs.`);
    return;
  }

  await closeWithComment(
    github,
    context,
    pr.number,
    [
      `Closing: ${author} already has ${OPEN_LIMIT} or more open PRs here, which is the limit for contributors who are not vouched.`,
      "",
      `Once one of them is merged or closed, open this again. See the [open PR limit](${guideLink(context, "open-pr-limit")}).`,
    ].join("\n"),
  );
  core.info(`PR #${pr.number}: closed, ${author} has ${others} other open PRs.`);
}

module.exports = { decide, enforceOpenLimit, parseExemptions, sweep };
