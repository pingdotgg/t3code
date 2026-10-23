import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
const home = process.argv[2];
if (!home?.startsWith("/tmp/issue-14743-")) {
  throw new Error("Use an isolated /tmp/issue-14743- home, with its server stopped");
}
const rules = {
  worktreeKeepWhen: "uncommitted-changes",
  worktreeAfterDays: null,
  worktreeSettledAfterDays: null,
  worktreeOnMerge: false,
  worktreeOnDelete: false,
  worktreeUnchanged: false,
};
NodeFS.mkdirSync(`${home}/userdata`, { recursive: true });
NodeFS.mkdirSync(`${home}/project`, { recursive: true });
NodeChildProcess.execFileSync("git", ["init", "--quiet", `${home}/project`]);
NodeFS.writeFileSync(
  `${home}/userdata/settings.json`,
  JSON.stringify(
    {
      storageCleanup: { ...rules, browserArtifactsAfterDays: null, logsAfterDays: null },
      enableProviderUpdateChecks: false,
      projectSettingsOverrides: { "proof-project": { worktreeCleanup: { mode: "custom", rules } } },
    },
    null,
    2,
  ),
);
console.log(
  `Start vp run dev --home-dir ${home}, pair the collaborative preview, then register the project through project-capture.js.`,
);
