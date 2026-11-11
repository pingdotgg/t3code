const assert = require("node:assert/strict");
const test = require("node:test");

const { countTestDelta, render } = require("./test-delta.cjs");

const diff = `diff --git a/apps/web/src/Panel.browser.test.tsx b/apps/web/src/Panel.browser.test.tsx
new file mode 100644
--- /dev/null
+++ b/apps/web/src/Panel.browser.test.tsx
@@ -0,0 +1,4 @@
+it("opens", async () => {});
+  it.each<{ n: number }>([{ n: 1 }])("renders $n", async () => {});
+// it("is a comment, still counted only when it starts the line")
diff --git a/apps/server/src/thing.test.ts b/apps/server/src/thing.test.ts
--- a/apps/server/src/thing.test.ts
+++ b/apps/server/src/thing.test.ts
@@ -3,2 +3,1 @@
-it.effect("old", () => {});
-test("older", () => {});
+  it.effect("new", () => {});
diff --git a/packages/shared/src/gone.test.ts b/packages/shared/src/gone.test.ts
deleted file mode 100644
--- a/packages/shared/src/gone.test.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-it("goes", () => {});
diff --git a/apps/web/src/Menu.test.tsx b/apps/web/src/Menu.browser.test.tsx
similarity index 100%
rename from apps/web/src/Menu.test.tsx
rename to apps/web/src/Menu.browser.test.tsx
diff --git a/apps/web/src/Old.browser.test.tsx b/apps/web/src/New.browser.test.tsx
similarity index 100%
rename from apps/web/src/Old.browser.test.tsx
rename to apps/web/src/New.browser.test.tsx
diff --git a/apps/web/src/Panel.tsx b/apps/web/src/Panel.tsx
--- a/apps/web/src/Panel.tsx
+++ b/apps/web/src/Panel.tsx
@@ -1 +1 @@
+it("is not a test file", () => {});
`;

test("counts cases by kind, including deleted files, and finds new or renamed browser files", () => {
  assert.deepEqual(countTestDelta(diff), {
    kinds: { browser: 2, server: -1, unit: -1 },
    net: 0,
    newBrowserFiles: ["apps/web/src/Panel.browser.test.tsx", "apps/web/src/Menu.browser.test.tsx"],
  });
});

test("reports only growth worth a reviewer's attention", () => {
  const quiet = { kinds: { browser: 0, server: 3, unit: 5 }, net: 8, newBrowserFiles: [] };
  assert.equal(render(quiet), null);
  const growth = { kinds: { browser: 4, server: 10, unit: 12 }, net: 26, newBrowserFiles: [] };
  assert.match(render(growth), /\*\*\+26 test cases\*\* \(browser \+4, unit \+12, server \+10\)/);
  assert.match(
    render(countTestDelta(diff)),
    /New browser test files: `apps\/web\/src\/Panel\.browser\.test\.tsx`/,
  );
});
