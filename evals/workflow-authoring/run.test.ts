// A test of an eval script, which works on plain file paths.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { cases } from "./cases.ts";
import { grade } from "./grade.ts";

const fixture = (name: string) => NodePath.join(import.meta.dirname, "fixtures", `${name}.ts`);
const entry = (id: string) => cases.find((candidate) => candidate.id === id)!;

it.each(cases.map((candidate) => candidate.id))("a correct answer to %s passes", async (id) => {
  expect(await grade(fixture(id), entry(id))).toEqual([]);
});

it("a body that reads the clock outside a step fails the replay case", async () => {
  expect(
    await grade(fixture("replay-reads-outside-a-step"), entry("replay-keeps-what-it-read")),
  ).toEqual([
    "restart while waiting: The time it returned was read again after the restart, not kept from the start.",
  ]);
});

it("an answer to another task fails with the reason", async () => {
  expect(
    await grade(fixture("webhook-filter-and-dedupe"), entry("replay-keeps-what-it-read")),
  ).toEqual(["restart while waiting: No workflow named stamp is defined."]);
});
