// Counts the test cases a pull request adds and removes, from a zero-context diff, so PR Size can
// say when a change grows the suite. Counting declarations keeps the number deterministic, unlike
// CI timings, which move with runner load.
const MARKER = "<!-- test-delta -->";
const NET_CASES_TO_REPORT = 20;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// `<` admits type arguments, as in `it.each<Row>(...)`, which may span lines.
const TEST_CASE = /^\s*(?:it|test)(?:\.\w+)*\s*[(<]/;
const isBrowserTest = (path) => path.includes(".browser.test.");

function kindOf(path) {
  if (isBrowserTest(path)) return "browser";
  if (path.startsWith("apps/server/") || path.includes(".integration.")) return "server";
  return "unit";
}

/** @param {string} diff output of `git diff -U0 base...head` */
function countTestDelta(diff) {
  const kinds = { browser: 0, server: 0, unit: 0 };
  const newBrowserFiles = [];
  let path = null;
  // A browser test file is new when it is added, or renamed from a file that was not one.
  let file = null;
  const flush = () => {
    if (file?.isNew && isBrowserTest(file.target)) newBrowserFiles.push(file.target);
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      path = null;
      file = { target: line.replace(/^diff --git a\/\S+ b\//, ""), isNew: false };
      continue;
    }
    if (line.startsWith("new file mode") && file) file.isNew = true;
    if (line.startsWith("rename from ") && file) file.isNew = !isBrowserTest(line.slice(12));
    if (line.startsWith("--- ")) {
      const source = line.slice(4).replace(/^a\//, "");
      path = TEST_FILE.test(source) ? source : null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/^b\//, "");
      // A deleted file's target is /dev/null; keep its old path to count the removed cases.
      if (target !== "/dev/null") path = TEST_FILE.test(target) ? target : null;
      continue;
    }
    if (line.startsWith("new file mode") || !path) continue;
    const sign = line[0] === "+" ? 1 : line[0] === "-" ? -1 : 0;
    if (sign !== 0 && TEST_CASE.test(line.slice(1))) kinds[kindOf(path)] += sign;
  }
  flush();
  return { kinds, net: kinds.browser + kinds.server + kinds.unit, newBrowserFiles };
}

/** Returns the comment body, or null when the change does not grow the suite enough to mention. */
function render(delta) {
  if (delta.net < NET_CASES_TO_REPORT && delta.newBrowserFiles.length === 0) return null;
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  const lines = [
    MARKER,
    `This PR changes the test suite by **${signed(delta.net)} test cases** ` +
      `(browser ${signed(delta.kinds.browser)}, unit ${signed(delta.kinds.unit)}, server ${signed(delta.kinds.server)}).`,
  ];
  if (delta.newBrowserFiles.length > 0) {
    lines.push(
      "",
      `New browser test files: ${delta.newBrowserFiles.map((file) => `\`${file}\``).join(", ")}.`,
      "Each browser test file costs CI seconds of module loading before its first test runs; a unit test costs milliseconds.",
    );
  }
  lines.push(
    "",
    "Keep tests that would fail for a real reason, and test logic below the UI where it can be. See [Testing](https://github.com/pingdotgg/t3code/blob/main/docs/internals/testing.md).",
  );
  return lines.join("\n");
}

module.exports = { MARKER, countTestDelta, render };
