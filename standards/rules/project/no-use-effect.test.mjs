import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { createRuleFixture } from "../lint-fixture.mjs";

const lint = createRuleFixture("project/no-use-effect");

const reported = [
  ["a named useEffect import", 'import { useEffect } from "react";\nexport const a = useEffect;'],
  [
    "a namespace useEffect call",
    'import * as React from "react";\nexport const a = React.useEffect;',
  ],
];

const allowed = [
  ["a state hook", 'import { useState } from "react";\nexport const a = useState;'],
  [
    "a useEffect from another module",
    'import { useEffect } from "./hooks";\nexport const a = useEffect;',
  ],
];

for (const [name, source] of reported) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports a finding`, () => {
    NodeAssert.ok(lint(source, "fixture.tsx").length > 0);
  });
}

for (const [name, source] of allowed) {
  NodeTest.test(`Given ${name}, When the rule lints it, Then it reports nothing`, () => {
    NodeAssert.deepEqual(lint(source, "fixture.tsx"), []);
  });
}
