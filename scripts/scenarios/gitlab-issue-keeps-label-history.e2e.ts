import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { T3_HOME } from "../e2e.config.ts";
import { runPromise, test, WEB } from "./t3.ts";

// The scenario server finds this glab on its private PATH. No request reaches GitLab.
const GLAB = `#!/usr/bin/env node
const args = process.argv.slice(2);
const send = value => console.log(JSON.stringify(value));
const issue = {
  iid: 42, title: "Label history fixture", state: "opened",
  web_url: "https://gitlab.com/acme/web/-/issues/42",
  description: "An issue with 101 label changes.",
  author: { id: 1, username: "fixture" },
  created_at: "2026-07-01T00:00:00Z", updated_at: "2026-07-03T00:00:00Z",
  labels: ["second-page-label"], assignees: [], user_notes_count: 0
};
if (args[0] === "--version") console.log("glab version 1.79.0");
else if (args[0] === "auth") console.log("gitlab.com\\n  ✓ Logged in to gitlab.com as fixture (token)");
else if (args[0] === "api") {
  const url = new URL(args[1], "https://gitlab.com/");
  const path = decodeURIComponent(url.pathname);
  if (path === "/user") send({ username: "fixture" });
  else if (path.endsWith("/resource_label_events")) {
    const page = Number(url.searchParams.get("page") || 1);
    const events = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1, action: index % 2 === 0 ? "add" : "remove", user: { username: "fixture" },
      label: { name: index === 100 ? "second-page-label" : "bug" },
      created_at: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString()
    }));
    send(events.slice((page - 1) * 100, page * 100));
  } else if (path.endsWith("/notes")) {
    const page = Number(url.searchParams.get("page") || 1);
    send(Array.from({ length: 101 }, (_, index) => ({
      id: index + 1, system: true, body: index % 2 === 0 ? "added ~7 label" : "removed ~7 label",
      author: { username: "fixture" },
      created_at: new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString()
    })).slice((page - 1) * 100, page * 100));
  }
  else if (path.endsWith("/closed_by") || path.endsWith("/related_merge_requests")) send([]);
  else if (path === "/graphql") {
    process.stdin.resume();
    process.stdin.on("end", () => send({ data: {
      currentUser: { username: "fixture" }, project: { mergeRequest: {
        awardEmoji: { nodes: [] }, notes: { nodes: [], pageInfo: { hasNextPage: false } }
      } }
    } }));
  } else if (path === "/projects/acme/web/issues/42") send(issue);
  else if (path === "/projects/acme/web/issues") send([issue]);
  else if (path === "/projects/acme/web") send({
    id: 1, path_with_namespace: "acme/web", web_url: "https://gitlab.com/acme/web",
    default_branch: "main", http_url_to_repo: "https://gitlab.com/acme/web.git",
    ssh_url_to_repo: "git@gitlab.com:acme/web.git"
  });
  else send([]);
} else if (args[0] === "mr" && args[1] === "list") send([]);
else process.exit(1);
`;

const GLAB_PATH = `${T3_HOME}/bin/glab`;

const installFakeGlab = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(GLAB_PATH, GLAB);
  yield* fs.chmod(GLAB_PATH, 0o755);
});

// Every scenario in a run shares one home, so the fake glab must not outlive this one.
const removeFakeGlab = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(GLAB_PATH, { force: true });
});

test(
  "GitLab issue activity keeps label changes beyond the first page",
  WEB,
  async ({ t3, app, screen, browser }) => {
    await runPromise(installFakeGlab);
    try {
      await t3.project("gitlab-label-history", {
        ".git/config":
          '[remote "origin"]\n\turl = https://gitlab.com/acme/web.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n',
      });
      await t3.open("/issues");
      await screen.getByRole("button", /Label history fixture/).tap();
      await screen.getByRole("button", "Refresh issue").waitFor();
      await browser.evaluate(() => {
        const events = [...document.querySelectorAll("span")].filter((element) =>
          /^(?:added|removed) the .+ label$/.test(element.textContent ?? ""),
        );
        events.at(-1)?.scrollIntoView({ block: "center" });
        return null;
      });
      await app.screenshot("label-history");
      await expect(
        screen.getByText("added the second-page-label label", { exact: true }),
      ).toHaveCount(1);
    } finally {
      await runPromise(removeFakeGlab);
    }
  },
);
