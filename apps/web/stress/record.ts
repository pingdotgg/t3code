// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalTimers:off - a standalone recording CLI.
/**
 * `vp run stress:record-pr <owner/name#number>`: saves a GitHub pull request for `vp run stress
 * --pr`. It fetches the base and head commits into a shared bare clone for diffs, then opens the
 * pull request in a recording server, so every read the panel makes is saved as the real host
 * answered it. Needs `gh` signed in.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { chromium } from "playwright";

import {
  changeFile,
  fixturesDir,
  freePort,
  log,
  parsePullRequest,
  prepareHome,
  repo,
  run,
  startServer,
  t3,
  type RecordedChange,
} from "./stack.ts";
import {
  linkPullRequest,
  openPullRequestPanel,
  openThread,
  scrollEverything,
  selectPullRequestTab,
} from "./ui.ts";

const { values: options, positionals } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: { headed: { type: "boolean", default: false } },
});
if (positionals[0] === undefined) throw new Error("Usage: vp run stress:record-pr owner/name#123");
const { repository, number } = parsePullRequest(positionals[0]);
const slug = repository.replace("/", "__");

function recordRevisions() {
  const [baseSha, headSha, ...titleWords] = run(
    "gh",
    [
      "api",
      `repos/${repository}/pulls/${number}`,
      "--jq",
      '.base.sha + " " + .head.sha + " " + .title',
    ],
    repo,
  )
    .trim()
    .split(" ");
  if (!baseSha || !headSha) throw new Error(`No base and head for ${repository}#${number}`);
  const gitDir = NodePath.join(fixturesDir, "repos", `${slug}.git`);
  if (!NodeFS.existsSync(gitDir)) run("git", ["init", "-q", "--bare", gitDir], repo);
  log(`fetching ${baseSha.slice(0, 10)} and ${headSha.slice(0, 10)} from ${repository}`);
  run(
    "git",
    [
      "--git-dir",
      gitDir,
      "fetch",
      "-q",
      "--depth=1",
      `https://github.com/${repository}.git`,
      baseSha,
      headSha,
    ],
    repo,
  );
  NodeFS.mkdirSync(NodePath.dirname(changeFile(repository, number)), { recursive: true });
  const change: RecordedChange = { baseSha, headSha, title: titleWords.join(" ") };
  NodeFS.writeFileSync(changeFile(repository, number), JSON.stringify(change));
  return change;
}

async function main() {
  const change = recordRevisions();
  const home = NodePath.join(repo, ".t3/stress/record-home");
  const workspace = prepareHome(home, `https://github.com/${repository}.git`);
  const server = await startServer({
    home,
    port: await freePort(),
    logFile: NodePath.join(home, "server.log"),
    env: { T3CODE_PR_FIXTURES: fixturesDir, T3CODE_PR_FIXTURES_RECORD: "1" },
  });
  try {
    const projectId = /Added project (\S+)/.exec(t3(home, "project", "add", workspace))?.[1];
    if (!projectId) throw new Error("project add printed no id");
    const browser = await chromium.launch({ headless: !options.headed });
    const page = await (
      await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ).newPage();
    await page.goto(server.pairingUrl);
    await page.getByRole("navigation", { name: "Threads" }).waitFor({ timeout: 60_000 });
    const origin = new URL(server.pairingUrl).origin;
    await page.goto(
      `${origin}/pull-requests?${new URLSearchParams({ repository, number: String(number), projectId, host: "github.com" })}`,
    );
    const visitTabs = async (where: string) => {
      for (const tab of ["Summary", "Timeline", "Code"] as const) {
        await selectPullRequestTab(page, tab);
        log(`recording the ${tab} tab (${where})`);
        await page.waitForTimeout(5000);
        await scrollEverything(page);
      }
    };
    await page.getByRole("navigation", { name: "Pull request tabs" }).waitFor({ timeout: 120_000 });
    await visitTabs("pull request page");
    // A thread's panel reads the pull request through its own requests.
    t3(
      home,
      "thread",
      "start",
      workspace,
      "Record",
      "--title",
      "Record",
      "--provider",
      "devReplay",
      "--model",
      "stress",
    );
    await page.goto(origin);
    await openThread(page, "Record");
    await linkPullRequest(page, `https://github.com/${repository}/pull/${number}`);
    await openPullRequestPanel(page, change.title).catch(async (error: Error) => {
      await page.screenshot({ path: NodePath.join(home, "record-failure.png") });
      throw error;
    });
    await visitTabs("thread panel");
    await page.screenshot({ path: NodePath.join(home, "recorded.png") });
    await browser.close();
  } finally {
    server.stop();
  }
  const calls = NodeFS.readdirSync(NodePath.join(fixturesDir, "calls"));
  log(`${calls.length} recorded reads in ${fixturesDir}`);
}

await main();
