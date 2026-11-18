import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { T3_HOME } from "../e2e.config.ts";
import { run } from "./shell.ts";
import { startSecondServer } from "./second-server.ts";
import { environmentId, makeState, runPromise, test, WEB } from "./t3.ts";

const HOST = "github.scenario.invalid";
const SCOPE = "scenario/demo";
const HOME = `${T3_HOME}-github-issue-links`;

// Install only on the isolated server. The real GitHub adapter still builds and decodes requests.
const upstream = String.raw`
const host = "${HOST}";
const scope = "${SCOPE}";
const viewer = { login: "scenario-user" };
const createdAt = "2026-10-01T00:00:00Z";
const updatedAt = "2026-10-05T00:00:00Z";
const row = {
  __typename: "Issue", number: 42, title: "Release preparation",
  url: "https://" + host + "/" + scope + "/issues/42",
  state: "OPEN", stateReason: null, author: null, createdAt, updatedAt, closedAt: null,
};
const empty = { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false, endCursor: null } };
const links = Array.from({ length: 21 }, (_, i) => ({
  number: 100 + i,
  title: i === 20 ? "Backfill release metadata" : "Fix release check " + (i + 1),
  url: "https://" + host + "/" + scope + "/pull/" + (100 + i),
  state: "OPEN",
  isDraft: false,
  repository: { nameWithOwner: scope },
}));
const timeline = [
  ...links.map((link) => ({
    __typename: "CrossReferencedEvent", id: "ref-" + link.number, createdAt, actor: null,
    source: { ...link, __typename: "PullRequest" },
  })),
  ...Array.from({ length: 100 }, (_, i) => ({
    __typename: "RenamedTitleEvent", id: "rename-" + i,
    createdAt: new Date(Date.parse(updatedAt) - (99 - i) * 60_000).toISOString(),
    actor: null, currentTitle: i === 99 ? row.title : "Release draft " + i,
  })),
];
function arg(query, field, argument, vars) {
  const args = query.match(new RegExp("\\b" + field + "\\s*\\(([^)]*)\\)"))?.[1] ?? "";
  const value = args.match(new RegExp("\\b" + argument + '\\s*:\\s*(\\$[\\w]+|[0-9]+|"[^"]*")'))?.[1];
  if (value === undefined) return undefined;
  if (value.startsWith("$")) return vars[value.slice(1)];
  return JSON.parse(value);
}

function page(nodes, query, field, vars) {
  const filter = arg(query, field, "query", vars)?.toLowerCase();
  const matches = filter ? nodes.filter((node) => node.name?.toLowerCase().includes(filter)) : nodes;
  const start = Number(arg(query, field, "after", vars) ?? 0);
  const end = start + (arg(query, field, "first", vars) ?? 100);
  const last = arg(query, field, "last", vars);
  return {
    nodes: last === undefined ? matches.slice(start, end) : matches.slice(-last),
    totalCount: matches.length,
    pageInfo: { hasNextPage: end < matches.length, endCursor: String(end) },
  };
}

const fetchActual = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== host) return fetchActual(input, init);
  if (url.pathname === "/api/v3/user") return Response.json({ ...viewer, name: null });
  if (url.pathname !== "/api/graphql") return new Response(null, { status: 404 });
  const { query, variables = {} } = await request.json();
  if (/\bsearch\s*\(/.test(query)) {
    return Response.json({ data: { search: { ...empty, nodes: [
      { ...row, assignees: empty, labels: empty, comments: { totalCount: 0 } },
    ] } } });
  }
  const repository = {
    viewerPermission: "WRITE",
    labels: empty, assignableUsers: empty,
    issue: {
      ...row, labels: empty, assignees: empty, body: "Check the release notes.",
      viewerCanUpdate: true, viewerCanClose: true, viewerCanReopen: false, reactionGroups: [],
      locked: false, activeLockReason: null, viewerCanComment: true,
      comments: { nodes: [], totalCount: 0, pageInfo: { hasPreviousPage: false, startCursor: null } },
      closedByPullRequestsReferences: page(links, query, "closedByPullRequestsReferences", variables),
      timelineItems: page(timeline, query, "timelineItems", variables),
    },
  };
  return Response.json({ data: { viewer, repository } });
};
`;

test(
  "A closing pull request remains visible after its timeline reference ages out",
  WEB,
  async ({ t3, app, browser, screen }) => {
    const workspace = await t3.project("Release");
    const server = startSecondServer(app.baseUrl ?? "", {
      home: HOME,
      nodeArgs: [
        `--import=data:text/javascript;base64,${Buffer.from(upstream).toString("base64")}`,
      ],
      env: { HOME, GH_HOST: HOST, GH_ENTERPRISE_TOKEN: "scenario-only-token" },
    });
    try {
      const { host: origin, token } = await server.ready;
      const repository = await runPromise(
        Effect.map(Path.Path, (path) => path.join(HOME, "release")),
      );
      await runPromise(run("git", ["clone", "--quiet", workspace, repository]));
      await runPromise(
        run("git", ["remote", "set-url", "origin", `https://${HOST}/${SCOPE}.git`], {
          cwd: repository,
        }),
      );
      const added = await runPromise(makeState(HOME).cli(["project", "add", repository]));
      const projectId = /Added project (\S+) /.exec(added.stdout)?.[1];
      if (!projectId) throw new Error("The fixture project was not added.");
      const environment = await runPromise(environmentId(origin));
      const link = new URLSearchParams({
        key: "42",
        tracker: "github",
        scope: SCOPE,
        selectedHost: HOST,
        selectedEnvironmentId: environment,
        selectedProjectId: projectId,
      });

      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(origin);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await screen.getByRole("button", "More actions for Scenario").waitFor();
      await app.open(`/issues?${link}`);

      await screen.getByRole("button", /Fix release check 20/).waitFor();
      try {
        await expect(screen.getByRole("button", /Backfill release metadata/)).toBeVisible();
      } finally {
        await browser.evaluate(() => {
          const rows = document.querySelectorAll("button");
          const row =
            [...rows].find((button) => button.textContent?.includes("Backfill release metadata")) ??
            [...rows].find((button) => button.textContent?.includes("Fix release check 20"));
          row?.scrollIntoView({ block: "center" });
          return null;
        });
        await app.screenshot("last-linked-pull-request");
      }
    } finally {
      await server.stop();
    }
  },
);
