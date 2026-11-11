const fs = require("node:fs");

const DAY_MS = 24 * 60 * 60 * 1000;
const OPEN_LIMIT = 8;
const CONFLICT_WINDOW_MS = 7 * DAY_MS;
const CLOSING_WINDOW_MS = 72 * 60 * 60 * 1000;
// A first run meets the whole backlog; cap it so one run cannot post hundreds of comments.
const MAX_WARNINGS_PER_RUN = 100;
const MAX_CLOSES_PER_RUN = 50;
// The Actions token gets 1,000 GraphQL points an hour; each lookup costs one.
const MAX_LOOKUPS_PER_RUN = 300;
const MERGEABLE_ATTEMPTS = 3;
const MERGEABLE_RETRY_MS = 30_000;
const MERGEABLE_LOOKUP_RETRY_MS = 5_000;
const RECENT_ACTIVITY_MS = 15 * 60 * 1000;

const REBASE_LABEL = "needs-rebase";
const CLOSING_LABEL = "triage:closing";
const KEEP_OPEN_LABEL = "triage:keep-open";
const UNVOUCHED_LABEL = "vouch:unvouched";
const TRUSTED_VOUCH_STATUSES = new Set(["bot", "collaborator", "vouched"]);
const EXEMPTIONS_PATH = ".github/TRIAGE_EXEMPTIONS.td";
const LOGIN_PATTERN = /^github:([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/;

const OPEN_PRS_QUERY = `
  query ($owner: String!, $repo: String!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequests(states: OPEN, first: 100, after: $cursor, orderBy: { field: CREATED_AT, direction: ASC }) {
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          mergeable
          labels(first: 100) { nodes { name } }
          timelineItems(itemTypes: [LABELED_EVENT], last: 30) {
            nodes { ... on LabeledEvent { createdAt label { name } } }
          }
        }
      }
    }
  }`;

const PR_DETAIL_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        state
        mergeable
        updatedAt
        labels(first: 100) { nodes { name } }
        timelineItems(itemTypes: [LABELED_EVENT], last: 100) {
          nodes { ... on LabeledEvent { createdAt label { name } } }
        }
        comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { author { login } } }
        reviews(first: 100) { pageInfo { hasNextPage endCursor } nodes { author { login } } }
      }
    }
  }`;

const PR_ACTIVITY_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!, $comments: String, $reviews: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        comments(first: 100, after: $comments) { pageInfo { hasNextPage endCursor } nodes { author { login } } }
        reviews(first: 100, after: $reviews) { pageInfo { hasNextPage endCursor } nodes { author { login } } }
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

function readsMergeable(pr) {
  return pr.labels.nodes.some(
    (label) => label.name === UNVOUCHED_LABEL || label.name === REBASE_LABEL,
  );
}

function sweepStep(pr) {
  const labels = new Set(pr.labels.nodes.map((label) => label.name));
  const keepOpen = labels.has(KEEP_OPEN_LABEL);
  if (labels.has(CLOSING_LABEL)) return keepOpen ? "skip" : "closing-window";
  if (labels.has(REBASE_LABEL)) {
    if (keepOpen || !labels.has(UNVOUCHED_LABEL) || pr.mergeable === "MERGEABLE") {
      return "clear-rebase";
    }
    return pr.mergeable === "CONFLICTING" ? "conflict-window" : "skip";
  }
  if (!keepOpen && labels.has(UNVOUCHED_LABEL) && pr.mergeable === "CONFLICTING") {
    return "conflict-warning";
  }
  return "skip";
}

// CONTRIBUTING.md leaves a PR to maintainers once an exempt login has commented or reviewed.
function maintainerOn(activity, exemptions) {
  for (const node of [...activity.comments.nodes, ...activity.reviews.nodes]) {
    const login = node.author?.login;
    if (login && exemptions.has(login.toLowerCase())) return login;
  }
  return undefined;
}

// Reads every page, so a long thread can neither hide a maintainer nor pass for one.
async function findMaintainer(github, repo, number, detail, exemptions) {
  for (let activity = detail; ;) {
    const login = maintainerOn(activity, exemptions);
    if (login) return login;
    const { comments, reviews } = activity;
    if (!comments.pageInfo.hasNextPage && !reviews.pageInfo.hasNextPage) return undefined;
    activity = (
      await github.graphql(PR_ACTIVITY_QUERY, {
        ...repo,
        number,
        comments: comments.pageInfo.endCursor,
        reviews: reviews.pageInfo.endCursor,
      })
    ).repository.pullRequest;
  }
}

function labeledAt(detail, name) {
  const events = detail.timelineItems.nodes.filter((event) => event.label?.name === name);
  const last = events.at(-1);
  return last ? Date.parse(last.createdAt) : undefined;
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

  // GitHub computes mergeability lazily and forgets it whenever main moves. Asking starts the
  // computation, so list again until the PRs this sweep reads it for have an answer.
  let openPrs = [];
  for (let attempt = 0; attempt < MERGEABLE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, MERGEABLE_RETRY_MS));
    openPrs = [];
    for (let cursor = null; ;) {
      const page = (await github.graphql(OPEN_PRS_QUERY, { ...repo, cursor })).repository
        .pullRequests;
      openPrs.push(...page.nodes);
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }
    if (!openPrs.some((pr) => pr.mergeable === "UNKNOWN" && readsMergeable(pr))) break;
  }
  // Start each day further down the list so the lookup cap cannot starve the same PRs every run.
  const due = openPrs.filter((pr) => sweepStep(pr) !== "skip");
  const start = due.length
    ? (Math.floor(Date.now() / DAY_MS) * MAX_LOOKUPS_PER_RUN) % due.length
    : 0;
  const candidates = [...due.slice(start), ...due.slice(0, start)];

  const plan = [];
  let warnings = 0;
  let closes = 0;
  let lookups = 0;
  const now = Date.now();
  const windowOf = (step) => (step === "closing-window" ? CLOSING_WINDOW_MS : CONFLICT_WINDOW_MS);
  const labelOf = (step) => (step === "closing-window" ? CLOSING_LABEL : REBASE_LABEL);
  for (const candidate of candidates) {
    const { number } = candidate;
    const listed = sweepStep(candidate);
    // Skip the lookup when the list already shows there is nothing to do this run.
    if (listed === "conflict-warning" && warnings >= MAX_WARNINGS_PER_RUN) continue;
    if (listed === "conflict-window" || listed === "closing-window") {
      const since = labeledAt(candidate, labelOf(listed));
      if (closes >= MAX_CLOSES_PER_RUN) continue;
      if (since !== undefined && now - since < windowOf(listed)) continue;
    }
    if (lookups >= MAX_LOOKUPS_PER_RUN) {
      core.warning(`Stopped at ${MAX_LOOKUPS_PER_RUN} lookups; the next run continues.`);
      break;
    }
    // The list can be minutes old by the time we act, so decide again on fresh state. A push or a
    // merge to main in between resets mergeability: ask once more, and never act on the old answer.
    const lookup = async () => {
      lookups += 1;
      return (await github.graphql(PR_DETAIL_QUERY, { ...repo, number })).repository.pullRequest;
    };
    let detail = await lookup();
    if (
      detail.state === "OPEN" &&
      detail.mergeable === "UNKNOWN" &&
      readsMergeable(detail) &&
      lookups < MAX_LOOKUPS_PER_RUN
    ) {
      await new Promise((resolve) => setTimeout(resolve, MERGEABLE_LOOKUP_RETRY_MS));
      detail = await lookup();
    }
    const step = detail.state === "OPEN" ? sweepStep(detail) : "skip";
    if (step === "skip") continue;

    if (step === "clear-rebase") {
      plan.push({ number, action: "clear-rebase" });
      if (!dryRun) await removeLabel(github, context, number, REBASE_LABEL);
      continue;
    }

    const maintainer = await findMaintainer(github, repo, number, detail, exemptions);
    if (maintainer) {
      const reason = `maintainer involved (${maintainer})`;
      if (step === "conflict-window") {
        plan.push({ number, action: "clear-rebase", reason });
        if (!dryRun) await removeLabel(github, context, number, REBASE_LABEL);
      } else {
        plan.push({ number, action: "leave-open", reason });
      }
      continue;
    }

    if (step === "conflict-warning") {
      if (warnings >= MAX_WARNINGS_PER_RUN) continue;
      warnings += 1;
      plan.push({ number, action: "warn-conflict" });
      if (dryRun) continue;
      // The request goes first: a label without it would start a clock nobody was told about.
      await github.rest.issues.createComment({
        ...context.repo,
        issue_number: number,
        body: [
          "This PR conflicts with `main`. Rebase it or merge `main` into it and push within 7 days, or it will be closed automatically.",
          "",
          `Pushing removes the \`${REBASE_LABEL}\` label and restarts the check. See the [conflict window](${guideLink(context, "conflict-window")}).`,
        ].join("\n"),
      });
      await github.rest.issues.addLabels({
        ...context.repo,
        issue_number: number,
        labels: [REBASE_LABEL],
      });
      continue;
    }

    const since = labeledAt(detail, labelOf(step));
    if (since === undefined || now - since < windowOf(step)) continue;
    if (closes >= MAX_CLOSES_PER_RUN) continue;
    // A reply or push clears the label from another job; give that job time before closing.
    if (Date.now() - Date.parse(detail.updatedAt) < RECENT_ACTIVITY_MS) continue;
    closes += 1;
    plan.push({ number, action: step === "closing-window" ? "close-triage" : "close-conflict" });
    if (dryRun) continue;
    await closeWithComment(
      github,
      context,
      number,
      step === "closing-window"
        ? [
            "Closing: 72 hours have passed since the triage notice above with no reply or push from the author.",
            "",
            `To ask for reconsideration, address the notice and comment here, or open a focused replacement PR that links this one. See [closure and reconsideration](${guideLink(context, "closure-and-reconsideration")}).`,
          ].join("\n")
        : [
            "Closing: this PR still conflicts with `main` 7 days after the rebase request, with no push since.",
            "",
            `To continue, rebase the branch and open a new PR that links this one. See the [conflict window](${guideLink(context, "conflict-window")}).`,
          ].join("\n"),
    );
  }

  const count = (action) => plan.filter((entry) => entry.action === action).length;
  core.info(
    `${dryRun ? "Dry run. " : ""}${candidates.length} candidates: ` +
      `${count("warn-conflict")} conflict warnings, ${count("close-conflict")} conflict closes, ` +
      `${count("close-triage")} triage closes, ${count("clear-rebase")} labels cleared, ` +
      `${count("leave-open")} left to maintainers.`,
  );
  for (const entry of plan) {
    core.info(`#${entry.number} ${entry.action}${entry.reason ? ` (${entry.reason})` : ""}`);
  }
  return plan;
}

async function enforceOpenLimit({ github, context, core, dryRun }) {
  const pr = context.payload.pull_request;
  const author = pr.user.login;
  const status = process.env.VOUCH_STATUS;
  if (!status) {
    core.warning(`PR #${pr.number}: no vouch status, leaving it open.`);
    return;
  }
  if (TRUSTED_VOUCH_STATUSES.has(status)) return;
  if (pr.labels.some((label) => label.name === KEEP_OPEN_LABEL)) return;
  // Someone else reopening a PR is a maintainer overriding the limit.
  if (context.payload.action === "reopened" && context.payload.sender.login !== author) return;

  const q = `repo:${context.repo.owner}/${context.repo.repo} is:pr is:open author:${author} sort:created-asc`;
  const { search } = await github.graphql(AUTHOR_OPEN_PRS_QUERY, { q });
  // A new PR counts only the older ones, so two opened together cannot close each other.
  const reopened = context.payload.action === "reopened";
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

module.exports = { enforceOpenLimit, maintainerOn, parseExemptions, sweep, sweepStep };
