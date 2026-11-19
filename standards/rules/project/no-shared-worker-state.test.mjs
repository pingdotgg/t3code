import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../lint-fixture.mjs";

const lint = createRuleFixture("project/no-shared-worker-state", [
  {
    processWideCalls: ["Telemetry.start", "ApplicationAuthFactory.initialize"],
    allowPatterns: ["/test/setup/PerFileSetup\\.ts$"],
  },
]);

const sharedTest = "test/unit/Shared.test.ts";
const isolatedTest = "test/unit/Shared.isolated.test.ts";
const helper = "test/helpers/Fixture.ts";
const isolatedHelper = "test/helpers/Fixture.isolated.ts";

for (const [name, source, file, count] of [
  ["a module mock in a shared test", `vi.mock("./Client.js");`, sharedTest, 1],
  ["a module mock split across lines", `vi\n  .mock("./Client.js");`, sharedTest, 1],
  ["a mock reached through a computed property", `vi["doMock"]("./Client.js");`, sharedTest, 1],
  ["a stubbed global", `beforeEach(() => vi.stubGlobal("fetch", fetchStub));`, sharedTest, 1],
  [
    "a stubbed environment variable",
    `beforeEach(() => vi.stubEnv("REGION", "eu-west-1"));`,
    sharedTest,
    1,
  ],
  ["a process.env assignment", `process.env.REGION = "eu";`, sharedTest, 1],
  ["a computed process.env assignment", `process.env[key] = value;`, sharedTest, 1],
  ["a process.env deletion", `delete process.env.REGION;`, sharedTest, 1],
  ["a merge into process.env", `Object.assign(process.env, { REGION: "eu" });`, sharedTest, 1],
  ["a configured process-wide call", `Telemetry.start(config);`, sharedTest, 1],
  [
    "a configured process-wide static call",
    `ApplicationAuthFactory.initialize(profile);`,
    sharedTest,
    1,
  ],
  [
    "an isolated helper imported by a shared test",
    `import { Fixture } from "../helpers/Fixture.isolated.js";`,
    sharedTest,
    1,
  ],
  [
    "an isolated helper re-exported by a shared helper",
    `export { Fixture } from "./Fixture.isolated.js";`,
    helper,
    1,
  ],
  [
    "an isolated helper loaded dynamically",
    `const fixture = await import("./Fixture.isolated.js");`,
    helper,
    1,
  ],
  [
    "a spy a helper installs as it loads",
    `vi.spyOn(storage, "upload").mockResolvedValue(undefined);`,
    helper,
    1,
  ],
  [
    "a helper spy split across lines",
    `vi\n  .spyOn(storage, "upload")\n  .mockResolvedValue(undefined);`,
    helper,
    1,
  ],
  [
    "a helper spy in a module-level block",
    `if (enabled) { vi.spyOn(storage, "upload"); }`,
    helper,
    1,
  ],
  ["a module mock in a helper", `vi.mock("./Client.js");`, helper, 1],
]) {
  NodeTest.test(
    `Given ${name}, When the rule lints it, Then it reports the expected findings`,
    () => {
      NodeAssert.equal(lint(source, file).length, count);
    },
  );
}

for (const [name, source, file] of [
  [
    "a spy installed inside a test",
    `it("uploads", () => { vi.spyOn(storage, "upload"); });`,
    sharedTest,
  ],
  ["a spy a shared test installs as it loads", `vi.spyOn(storage, "upload");`, sharedTest],
  [
    "a spy a helper installs from a function",
    `export function stubUpload() { vi.spyOn(storage, "upload"); }`,
    helper,
  ],
  ["a spy a helper installs from a hook", `beforeEach(() => vi.spyOn(storage, "upload"));`, helper],
  ["a process.env read", `const region = process.env.REGION;`, sharedTest],
  ["a comparison with process.env", `process.env.CI == "true";`, sharedTest],
  ["a module mock in an isolated test", `vi.mock("./Client.js");`, isolatedTest],
  [
    "an isolated helper imported by an isolated test",
    `import { Fixture } from "../helpers/Fixture.isolated.js";`,
    isolatedTest,
  ],
  [
    "state in an isolated helper",
    `vi.spyOn(storage, "upload");\nprocess.env.REGION = "eu";`,
    isolatedHelper,
  ],
  [
    "an import of an ordinary helper",
    `import { Fixture } from "../helpers/Fixture.js";`,
    sharedTest,
  ],
  [
    "an allowed per-file setup file",
    `process.env.DATABASE_URL = url;`,
    "test/setup/PerFileSetup.ts",
  ],
]) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports nothing`, () => {
    NodeAssert.deepEqual(lint(source, file), []);
  });
}
