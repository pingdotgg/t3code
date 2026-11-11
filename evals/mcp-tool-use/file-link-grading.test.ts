import { assert, it } from "@effect/vitest";

import { fileLinkPills, gradeFileLinks } from "./file-link-grading.ts";

const cwd = "/home/user/app";
const files = [
  "packages/server/src/cloud/http.ts",
  "packages/web/src/api/http.ts",
  "packages/server/src/index.ts",
  "packages/web/src/index.ts",
  "packages/server/src/ws.ts",
  "packages/server/docs/report.pdf",
  "/home/user/work/worker/src/worker.ts",
];

it("grades pills the way chat resolves them against the thread cwd", () => {
  const text = [
    "[http.ts](/home/user/app/packages/server/src/cloud/http.ts#L4)",
    "`packages/server/src/cloud/http.ts:6` and `cloud/http.ts:6`",
    "`ws.ts:3`, `index.ts:5`, `src/index.ts`, `src/worker.ts`",
    "[worker.ts](/home/user/work/worker/src/worker.ts)",
    "[http](cloud/http.ts#L4), [ws](./ws.ts), `./packages/server/src/ws.ts`, `WS.ts:3`",
    "[`src/ws.ts`](/home/user/app/packages/server/src/ws.ts), [`src/index.ts` boots it](/home/user/app/packages/server/src/ws.ts)",
    "`/usr/bin/node`, `git rebase --onto`",
    "```md\n[example](docs/missing.md) and `src/missing.ts`\n```",
    "Write links as `[example](docs/missing.md)`.",
    "[report](docs/report.pdf)",
  ].join("\n");
  const pills = Object.fromEntries(
    fileLinkPills(text, cwd, files).map((pill) => [pill.source, pill.works]),
  );
  assert.deepStrictEqual(pills, {
    "/home/user/app/packages/server/src/cloud/http.ts#L4": true,
    "/home/user/work/worker/src/worker.ts": true,
    "packages/server/src/cloud/http.ts:6": true,
    "cloud/http.ts:6": true,
    "ws.ts:3": true,
    "cloud/http.ts#L4": true,
    "./ws.ts": false,
    "./packages/server/src/ws.ts": true,
    "WS.ts:3": true,
    "docs/report.pdf": false,
    "index.ts:5": false,
    "src/index.ts": false,
    "/home/user/app/packages/server/src/ws.ts": true,
    "src/worker.ts": false,
  });
});

it("grades a workspace outside home directories", () => {
  const pills = fileLinkPills("`src/main.ts` and `/usr/bin/node`", "/tmp/app", ["src/main.ts"]);
  assert.deepStrictEqual(
    pills.map((pill) => [pill.source, pill.works]),
    [["src/main.ts", true]],
  );
});

it("needs a finished answer with enough working pills", () => {
  const passes = (text: string | undefined, minWorking: number) =>
    gradeFileLinks({ minWorking }, text, cwd, files).every((check) => check.pass);
  assert.isTrue(passes("See `packages/server/src/ws.ts`.", 1));
  assert.isFalse(passes("It rebases the last three commits.", 1));
  assert.isTrue(passes("It rebases the last three commits.", 0));
  assert.isFalse(passes(undefined, 0));
  assert.isFalse(passes("`src/index.ts`", 0));
});
