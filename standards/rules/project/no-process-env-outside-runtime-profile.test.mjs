import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../lint-fixture.mjs";

const lint = createRuleFixture("project/no-process-env-outside-runtime-profile");

const reported = [
  ["a process.env read", "export const port = process.env.PORT;"],
  ["a process.env index read", 'export const port = process.env["PORT"];'],
];

const allowed = [["no environment access", "export const port = 3000;"]];

for (const [name, source] of reported) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports a finding`, () => {
    NodeAssert.ok(lint(source).length > 0);
  });
}

for (const [name, source] of allowed) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports nothing`, () => {
    NodeAssert.deepEqual(lint(source), []);
  });
}

const allowedLint = createRuleFixture("project/no-process-env-outside-runtime-profile", [
  { allowPatterns: ["/scripts/"] },
]);

NodeTest.test(
  "Given a file matching an allowPatterns entry, When the rule lints a process.env read, Then it reports nothing",
  () => {
    NodeAssert.deepEqual(
      allowedLint("export const port = process.env.PORT;", "scripts/dev.ts"),
      [],
    );
  },
);

NodeTest.test(
  "Given a file outside every allowPatterns entry, When the rule lints a process.env read, Then it reports a finding",
  () => {
    NodeAssert.equal(allowedLint("export const port = process.env.PORT;", "src/dev.ts").length, 1);
  },
);
