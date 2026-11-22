// Lab data for the Pull requests page: edit LAB_PULL_REQUESTS to change the list. The fake
// environment answers pullRequests.list, listStats and filterOptions from it, applying the
// input's state, involvement, filters and search the way the host would.
import type {
  ProjectId,
  PullRequestActor,
  PullRequestChecksState,
  PullRequestFilterOptionsInput,
  PullRequestListEntry,
  PullRequestListInput,
  PullRequestListStatsInput,
  PullRequestReviewDecision,
  PullRequestState,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { answerRpc } from "../../../web/test/fakeEnvironment";
import { matchesPullRequestFilters } from "~/components/pullRequest/pullRequestList.logic";

const GITHUB = "github" as PullRequestListEntry["provider"];
const VIEWER = "nckrtl";
const HOST = "github.com";
const PROJECT_ID = "project-conn" as ProjectId;
const REPOSITORY = "nckrtl/conn";

const user = (login: string, name: string | null = null, isBot = false): PullRequestActor => ({
  login,
  name,
  avatarUrl: null,
  ...(isBot ? { isBot } : {}),
});
const ME = user(VIEWER, "Nick");
const MARLON = user("marlon-dev", "Marlon");
const SOFIA = user("sofia-b", "Sofia");
const DEPENDABOT = user("dependabot[bot]", null, true);

const label = (name: string, color: string) => ({ name, color, description: null });
const SIZE_S = label("size:S", "0e8a16");
const SIZE_M = label("size:M", "fbca04");
const SIZE_L = label("size:L", "d93f0b");
const SIZE_XL = label("size:XL", "b60205");
const TRUSTED = label("vouch:trusted", "5319e7");
const BUG = label("bug", "d73a4a");
const FEATURE = label("enhancement", "a2eeef");
const DEPS = label("dependencies", "0366d6");
const DESIGN = label("design", "f9d0c4");

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.now();
const ago = (ms: number) => new Date(now - ms).toISOString();

interface Seed {
  readonly number: number;
  readonly title: string;
  readonly author: PullRequestActor;
  readonly state?: PullRequestState;
  readonly draft?: boolean;
  readonly reviewRequested?: boolean;
  readonly labels?: ReadonlyArray<ReturnType<typeof label>>;
  readonly review?: PullRequestReviewDecision;
  readonly checks?: PullRequestChecksState;
  readonly conflicting?: boolean;
  readonly additions: number;
  readonly deletions: number;
  readonly created: number;
  readonly updated: number;
  readonly head: string;
  readonly base?: string;
  readonly repository?: string;
}

const seed = (s: Seed): PullRequestListEntry => {
  const repository = s.repository ?? REPOSITORY;
  return {
    provider: GITHUB,
    host: HOST,
    projectId: PROJECT_ID,
    projectTitle: "conn",
    repository,
    number: s.number,
    title: s.title,
    url: `https://${HOST}/${repository}/pull/${s.number}`,
    author: s.author,
    headBranch: s.head,
    baseBranch: s.base ?? "main",
    state: s.state ?? "open",
    isDraft: s.draft ?? false,
    mergeability: s.conflicting ? "conflicting" : "mergeable",
    additions: s.additions,
    deletions: s.deletions,
    createdAt: ago(s.created),
    updatedAt: ago(s.updated),
    viewerReviewRequested: s.reviewRequested ?? false,
    labels: s.labels ?? [],
    ...(s.review === undefined ? {} : { reviewDecision: s.review }),
    ...(s.checks === undefined ? {} : { checksState: s.checks }),
  };
};

const PEOPLE = [ME, MARLON, SOFIA, user("jules-k", "Jules"), user("priya-n", "Priya"), DEPENDABOT];
const REVIEWS: ReadonlyArray<PullRequestReviewDecision | undefined> = [
  "review-required",
  "approved",
  "changes-requested",
  undefined,
];
const CHECKS: ReadonlyArray<PullRequestChecksState | undefined> = [
  "passing",
  "pending",
  "failing",
  "passing",
  undefined,
];
const SIZES = [SIZE_S, SIZE_M, SIZE_L, SIZE_XL];
const STATES: ReadonlyArray<PullRequestState> = [
  "open",
  "open",
  "open",
  "merged",
  "open",
  "closed",
];
const TITLES: ReadonlyArray<readonly [string, string, string?]> = [
  ["feat(web): thread search matches branch names", "web/search-branches"],
  ["fix(server): checkpoint capture skips ignored files", "server/checkpoint-ignored"],
  ["feat(mobile): swipe to settle a thread", "mobile/swipe-settle"],
  ["fix(web): diff viewer scroll jumps on resize", "web/diff-scroll-resize"],
  ["chore: bump effect to 4.1.2", "deps/effect-4.1.2"],
  ["feat(desktop): open threads in a new window", "desktop/thread-window"],
  ["fix(web): snooze menu closes on hover out", "web/snooze-hover"],
  ["feat(server): Kiro adapter reports token usage", "server/kiro-usage"],
  ["refactor(web): one hook for sidebar row actions", "web/row-actions-hook"],
  ["feat(web): keyboard shortcut to settle the open thread", "web/settle-shortcut"],
  ["fix(client-runtime): relay reconnect drops queued commands", "runtime/relay-queue"],
  ["docs: remote setup over Tailscale", "docs/tailscale"],
  ["feat(web): pull request page groups by repository", "web/pr-group-repo"],
  ["fix(mobile): composer covers the last message", "mobile/composer-inset"],
  ["perf(web): virtualize the work log", "web/worklog-virtual"],
  ["feat(gateway): task insights per project", "gateway/insights-project", "nckrtl/orbit"],
  [
    "fix(gateway): task insights stay under the memory limit",
    "gateway/insights-memory",
    "nckrtl/orbit",
  ],
  ["feat(swamp): pause release during stacked merges", "swamp/pause-release", "nckrtl/orbit"],
  ["chore(orbit): PHP 8.4 on all nodes", "orbit/php-84", "nckrtl/orbit"],
  ["feat(icons): superheroicons for Conn", "icons/conn-set", "nckrtl/superheroicons"],
  ["fix(icons): snooze glyph at 16px", "icons/snooze-16", "nckrtl/superheroicons"],
  ["feat(web): Orbit task receipts open the Tasks panel", "web/task-receipt-open"],
  ["fix(web): tooltip flickers over the rail", "web/rail-tooltip"],
  ["feat(server): scheduled tasks resume after restart", "server/schedule-resume"],
  ["chore(deps): bump react to 19.3.1", "dependabot/npm_and_yarn/react-19.3.1"],
  ["feat(web): two-line thread rows setting", "web/two-line-rows"],
  ["fix(server): Claude adapter keeps the session on compact", "server/claude-compact"],
  ["feat(mobile): pull requests tab", "mobile/pr-tab"],
];
const GENERATED: ReadonlyArray<Seed> = TITLES.map(([title, head, repository], index) => {
  const author = title.startsWith("chore(deps)") ? DEPENDABOT : PEOPLE[index % 5]!;
  const state = STATES[index % STATES.length]!;
  return {
    number: (repository === undefined ? 1890 : 160) - index - 1,
    title,
    author,
    head,
    ...(repository === undefined ? {} : { repository }),
    state,
    draft: state === "open" && index % 7 === 3,
    reviewRequested: author !== ME && index % 3 === 0,
    labels: [
      SIZES[index % 4]!,
      ...(title.startsWith("fix")
        ? [BUG]
        : title.startsWith("chore")
          ? [DEPS]
          : title.startsWith("feat")
            ? [FEATURE]
            : []),
      ...(index % 4 === 1 ? [TRUSTED] : index % 5 === 2 ? [DESIGN] : []),
    ],
    ...(REVIEWS[index % REVIEWS.length] === undefined
      ? {}
      : { review: REVIEWS[index % REVIEWS.length]! }),
    ...(CHECKS[index % CHECKS.length] === undefined
      ? {}
      : { checks: CHECKS[index % CHECKS.length]! }),
    conflicting: index % 9 === 4,
    additions: 12 + ((index * 137) % 900),
    deletions: 3 + ((index * 61) % 320),
    created: (index + 2) * 7 * HOUR,
    updated: (index + 1) * 2 * HOUR + index * 11 * MINUTE,
  };
});

export const LAB_PULL_REQUESTS: ReadonlyArray<PullRequestListEntry> = [
  seed({
    number: 1931,
    title: "feat(web): Tasks board polish, round 2",
    author: ME,
    labels: [SIZE_L, DESIGN],
    review: "review-required",
    checks: "pending",
    additions: 842,
    deletions: 317,
    created: 6 * HOUR,
    updated: 12 * MINUTE,
    head: "feat/tasks-board-polish-2",
  }),
  seed({
    number: 1928,
    title: "fix(web): context menu separators use the glass divider",
    author: ME,
    labels: [SIZE_S, BUG, DESIGN],
    review: "approved",
    checks: "passing",
    additions: 24,
    deletions: 9,
    created: 3 * HOUR,
    updated: 41 * MINUTE,
    head: "fix/context-menu-glass-divider",
  }),
  seed({
    number: 1926,
    title: "feat(web): Pull requests page on the fixture list in the UI lab",
    author: ME,
    draft: true,
    labels: [SIZE_M, FEATURE],
    checks: "pending",
    additions: 233,
    deletions: 12,
    created: 5 * HOUR,
    updated: 2 * HOUR,
    head: "feat/lab-pull-requests-page",
  }),
  seed({
    number: 1921,
    title: "feat(server): Orbit task receipts in thread details",
    author: MARLON,
    reviewRequested: true,
    labels: [SIZE_L, TRUSTED, FEATURE],
    review: "changes-requested",
    checks: "failing",
    conflicting: true,
    additions: 611,
    deletions: 140,
    created: 2 * DAY,
    updated: 3 * HOUR,
    head: "marlon/orbit-task-receipts",
  }),
  seed({
    number: 1917,
    title: "fix(web): chat composer loses focus after a slash command",
    author: SOFIA,
    reviewRequested: true,
    labels: [SIZE_S, TRUSTED, BUG],
    review: "review-required",
    checks: "passing",
    additions: 38,
    deletions: 6,
    created: 1 * DAY,
    updated: 5 * HOUR,
    head: "sofia/composer-focus-slash",
  }),
  seed({
    number: 1913,
    title: "refactor(client-runtime): one source for thread pull request links",
    author: MARLON,
    labels: [SIZE_M, TRUSTED],
    review: "approved",
    checks: "passing",
    additions: 188,
    deletions: 204,
    created: 3 * DAY,
    updated: 1 * DAY,
    head: "marlon/thread-pr-links",
  }),
  seed({
    number: 1909,
    title: "chore(deps): bump vite-plus from 0.4.2 to 0.4.5",
    author: DEPENDABOT,
    labels: [DEPS, SIZE_S],
    checks: "passing",
    additions: 14,
    deletions: 14,
    created: 2 * DAY,
    updated: 2 * DAY,
    head: "dependabot/npm_and_yarn/vite-plus-0.4.5",
  }),
  seed({
    number: 1902,
    title: "feat(web): sidebar sweep selects a range of threads",
    author: ME,
    state: "merged",
    labels: [SIZE_M, FEATURE],
    review: "approved",
    checks: "passing",
    additions: 301,
    deletions: 58,
    created: 4 * DAY,
    updated: 1 * DAY + 2 * HOUR,
    head: "feat/sidebar-sweep-range",
  }),
  seed({
    number: 1897,
    title: "fix(web): right panel keeps its width across thread switches",
    author: SOFIA,
    state: "merged",
    labels: [SIZE_S, BUG],
    review: "approved",
    checks: "passing",
    additions: 52,
    deletions: 17,
    created: 6 * DAY,
    updated: 3 * DAY,
    head: "sofia/right-panel-width",
  }),
  seed({
    number: 1890,
    title: "feat(web): experiment with a split diff gutter",
    author: ME,
    state: "closed",
    labels: [SIZE_XL, DESIGN],
    review: "changes-requested",
    checks: "failing",
    additions: 1204,
    deletions: 388,
    created: 9 * DAY,
    updated: 5 * DAY,
    head: "spike/split-diff-gutter",
  }),
  seed({
    number: 164,
    title: "feat(gateway): conn.thread.record accepts a pull request link",
    author: ME,
    repository: "nckrtl/orbit",
    labels: [SIZE_M, FEATURE],
    review: "review-required",
    checks: "passing",
    additions: 96,
    deletions: 21,
    created: 8 * HOUR,
    updated: 90 * MINUTE,
    head: "feat/thread-record-pr-link",
  }),
  seed({
    number: 163,
    title: "fix(swamp): retry the deploy step when the node is waking",
    author: MARLON,
    repository: "nckrtl/orbit",
    state: "merged",
    reviewRequested: false,
    labels: [SIZE_S, TRUSTED, BUG],
    review: "approved",
    checks: "passing",
    additions: 41,
    deletions: 8,
    created: 2 * DAY,
    updated: 6 * HOUR,
    head: "marlon/swamp-deploy-retry",
  }),
  ...GENERATED.map(seed),
];

const entryViewer = () => VIEWER;

function listAnswer(input: PullRequestListInput) {
  const query = input.query?.toLowerCase();
  const entries = LAB_PULL_REQUESTS.filter((entry) => {
    if (input.state !== "all" && entry.state !== input.state) return false;
    if (input.host !== undefined && entry.host !== input.host) return false;
    if (input.projectId !== undefined && entry.projectId !== input.projectId) return false;
    if (input.projectIds !== undefined && !input.projectIds.includes(entry.projectId)) return false;
    if (input.involvement === "authored" && entry.author?.login !== VIEWER) return false;
    if (input.involvement === "reviewing" && !entry.viewerReviewRequested) return false;
    if (input.filters !== undefined) {
      if (!matchesPullRequestFilters(entry, input.filters, entryViewer())) return false;
      if (input.filters.checks !== undefined && entry.checksState !== input.filters.checks) {
        return false;
      }
    }
    if (query === undefined) return true;
    return [`#${entry.number}`, entry.title, entry.author?.login ?? "", entry.headBranch]
      .join(" ")
      .toLowerCase()
      .includes(query);
  })
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, input.limit);
  return {
    viewers: { [HOST]: VIEWER },
    providers: [
      {
        host: HOST,
        kind: GITHUB,
        searchesOnHost: true,
        projectCount: 1,
        projectIds: [PROJECT_ID],
        configured: true,
        detail: null,
      },
    ],
    entries,
    errors: [],
    truncated: false,
    nextCursors: {},
  };
}

/** Answers the list reads of the Pull requests page from LAB_PULL_REQUESTS until disposed. */
export function installPullRequestListFixture(): Disposable {
  const disposables = [
    answerRpc("pullRequests.list", (input: PullRequestListInput) =>
      Effect.succeed(listAnswer(input)),
    ),
    answerRpc("pullRequests.listStats", (input: PullRequestListStatsInput) =>
      Effect.succeed({
        stats: input.refs.flatMap((ref) => {
          const entry = LAB_PULL_REQUESTS.find(
            (candidate) =>
              candidate.repository === ref.repository && candidate.number === ref.number,
          );
          return entry === undefined
            ? []
            : [
                {
                  projectId: entry.projectId,
                  repository: entry.repository,
                  number: entry.number,
                  additions: entry.additions,
                  deletions: entry.deletions,
                },
              ];
        }),
      }),
    ),
    answerRpc("pullRequests.filterOptions", (input: PullRequestFilterOptionsInput) => {
      const labels = new Map(
        LAB_PULL_REQUESTS.flatMap((entry) => entry.labels).map((l) => [l.name, l]),
      );
      const authors = new Map(
        LAB_PULL_REQUESTS.flatMap((entry) => (entry.author === null ? [] : [entry.author])).map(
          (a) => [a.login, a],
        ),
      );
      const query = input.query?.toLowerCase() ?? "";
      return Effect.succeed({
        labels:
          input.kind === "labels"
            ? [...labels.values()].filter((l) => l.name.toLowerCase().includes(query))
            : [],
        authors:
          input.kind === "authors"
            ? [...authors.values()].filter((a) => a.login.toLowerCase().includes(query))
            : [],
        references: [],
        truncated: false,
      });
    }),
  ];
  return {
    [Symbol.dispose]: () => {
      for (const disposable of disposables) disposable[Symbol.dispose]();
    },
  };
}
