import { assert, it } from "@effect/vitest";

import { fileLinkPills, gradeFileLinks } from "./file-link-grading.ts";

const cwd = "/home/user/app";
const files = [
  "packages/server/src/cloud/http.ts",
  "packages/web/src/api/http.ts",
  "packages/server/src/index.ts",
  "packages/web/src/index.ts",
  "packages/server/src/ws.ts",
  "/home/user/work/worker/src/worker.ts",
];

it("grades pills the way chat resolves them against the thread cwd", () => {
  const text = [
    "[http.ts](/home/user/app/packages/server/src/cloud/http.ts#L4)",
    "`packages/server/src/cloud/http.ts:6` and `cloud/http.ts:6`",
    "`ws.ts:3`, `index.ts:5`, `src/index.ts`, `src/worker.ts`",
    "[worker.ts](/home/user/work/worker/src/worker.ts)",
    "[http](cloud/http.ts#L4), [ws](./ws.ts)",
    "`/usr/bin/node`, `git rebase --onto`",
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
    "index.ts:5": false,
    "src/index.ts": false,
    "src/worker.ts": false,
  });
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
