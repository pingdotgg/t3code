// @effect-diagnostics nodeBuiltinImport:off - builds skill folders in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { buildSkillMap, renderSkillMap } from "./workflow-map.ts";

it("links a skill only to names set off as names, and sorts skills by role", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "workflow-map-"));
  using _cleanup = { [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true }) };
  const add = (name: string, body: string) => {
    NodeFS.mkdirSync(NodePath.join(root, "ak", name), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(root, "ak", name, "SKILL.md"),
      `---\nname: ${name}\n---\n${body}`,
    );
  };
  add("entry", 'Use the "grilling" skill, then `how`, then read ../leaf/SKILL.md.');
  add("grilling", "Ask the how questions in plain prose.");
  add("how", "Nothing.");
  add("leaf", "Nothing.");
  add("alone", "Explain how and why.");

  const map = buildSkillMap(root);
  expect(map.calls.get("entry")).toEqual(["grilling", "how", "leaf"]);
  expect(map.calls.get("grilling")).toEqual([]);
  const text = renderSkillMap(map);
  expect(text).toContain("**Entry points** (call others, nothing calls them): entry\n");
  expect(text).toContain("**Standalone** (no links either way): alone\n");
});
