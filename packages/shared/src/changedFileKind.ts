import type { PullRequestChangeBreakdown } from "@t3tools/contracts";

export type ChangedFileKind = keyof NonNullable<PullRequestChangeBreakdown>;

const GENERATED_FILES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "gradle.lockfile",
  "mix.lock",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "packages.lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "podfile.lock",
  "poetry.lock",
  "pubspec.lock",
  "uv.lock",
  "yarn.lock",
]);
const GENERATED_NAME =
  /(\.generated\.|\.gen\.|\.g\.dart$|\.pb\.go$|_pb2(_grpc)?\.py$|\.pb\.(cc|h)$|\.min\.(js|css)$|\.(js|css)\.map$)/;
const GENERATED_DIRS = new Set(["__generated__", "_generated", "generated"]);

const MOCK_NAME =
  /(\.snap$|\.(mocks?|fixtures?|stubs?|fakes?)\.[^.]+$|^(mocks?|fixtures?|stubs?|fakes?)([-_.A-Z]|$))/;
const MOCK_DIRS = new Set([
  "__fixtures__",
  "__mocks__",
  "__snapshots__",
  "fakes",
  "fixture",
  "fixtures",
  "mock",
  "mocks",
  "stubs",
  "testdata",
]);

const TEST_NAME =
  /(\.(test|spec|e2e|eval)\.[^.]+$|_(test|spec)\.[^.]+$|^test_.+\.py$|^conftest\.py$|^(vitest|jest)\.setup\.[^.]+$)/i;
// Case-sensitive: `FooTest.java` is a test class, `Latest.java` is not.
const CLASS_TEST_NAME = /(Tests?|Spec)\.(java|kt|kts|scala|groovy|cs|php|swift|m)$/;
const TEST_DIRS = new Set([
  "__tests__",
  "__test__",
  "cypress",
  "e2e",
  "evals",
  "spec",
  "specs",
  "test",
  "tests",
]);

const DOCS_NAME = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
// Plain-text files that tools read as config or input, not prose.
const NOT_DOCS_NAME = /^(requirements.*|constraints.*|CMakeLists|robots|llms)\.txt$/i;

/**
 * Sorts a changed file by its path alone, using common naming conventions. Lockfiles and build
 * output count as generated, and test support (mocks, fixtures, snapshots) is kept apart from the
 * tests themselves, and prose (Markdown, plain text) is its own kind, so a reviewer can see how much of a change is logic.
 */
export function isTestChangedFile(path: string): boolean {
  const kind = classifyChangedFile(path);
  return kind === "tests" || kind === "mocks";
}

export function classifyChangedFile(path: string): ChangedFileKind {
  const segments = path.replaceAll("\\", "/").split("/");
  const name = segments.pop() ?? "";
  const dirs = segments.map((segment) => segment.toLowerCase());
  const inDir = (set: ReadonlySet<string>) => dirs.some((dir) => set.has(dir));
  if (GENERATED_FILES.has(name.toLowerCase()) || GENERATED_NAME.test(name) || inDir(GENERATED_DIRS))
    return "generated";
  if (MOCK_NAME.test(name) || inDir(MOCK_DIRS)) return "mocks";
  if (TEST_NAME.test(name) || CLASS_TEST_NAME.test(name) || inDir(TEST_DIRS)) return "tests";
  if (DOCS_NAME.test(name) && !NOT_DOCS_NAME.test(name)) return "docs";
  return "code";
}
