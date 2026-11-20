import { describe, expect, it } from "vite-plus/test";

import { classifyArtifact, groupArtifacts, parseReadme } from "./artifact";

describe("classifyArtifact", () => {
  // Every path is from a real run's evidence layout, under the store folder.
  const cases = [
    ["artifacts/XEO-3366/01-discovery.txt", "proof", "XEO-3366"],
    ["artifacts/XEO-3366/README.txt", "report", "XEO-3366"],
    ["artifacts/XEO-3366/smoke-main.sh", "script", "XEO-3366"],
    ["artifacts/XEO-3371/head-a6c729bc45/presence-timeRange84.png", "screenshot", "XEO-3371"],
    [
      "artifacts/XEO-3378/pr-screenshots/01-consent-page-after-navigation-302.png",
      "screenshot",
      "XEO-3378",
    ],
    ["artifacts/XEO-3378/fixture.mts", "script", "XEO-3378"],
    ["artifacts/XEO-3377/fix4/diff.patch", "diff", "XEO-3377"],
    ["artifacts/XEO-3377/claude-code-protocol-probe.jsonl", "proof", "XEO-3377"],
    ["artifacts/RESUME-xeo-3330.md", "report", null],
    ["review/XEO-3366/round-1.md", "review", "XEO-3366"],
    ["inbox/XEO-3378-handoff.md", "brief", null],
    ["design.md", "design", null],
  ] as const;

  it.each(cases)(
    "Given %s, when it is classified, then it is a %s for %s",
    (path, kind, ticketKey) => {
      expect(classifyArtifact(path)).toMatchObject({ path, kind, ticketKey });
    },
  );

  it("Given the store's own files, when they are classified, then none is an artifact", () => {
    for (const path of [
      "board.json",
      "tickets.json",
      "foryou.jsonl",
      "gates.md",
      "roles/task.md",
    ]) {
      expect(classifyArtifact(path)).toBeNull();
    }
  });

  it("Given a root decisions file, when it is classified, then it is decisions for the orchestrator", () => {
    expect(classifyArtifact("decisions.tsv")).toMatchObject({ kind: "decisions", ticketKey: null });
  });

  it("Given a screenshot under review, when it is classified, then the image wins over the folder", () => {
    expect(classifyArtifact("review/XEO-3366/blocker.png")).toMatchObject({
      kind: "screenshot",
      ticketKey: "XEO-3366",
    });
  });

  it("Given a hidden file or a file named like an object member, when it is classified, then it is not an artifact or is a plain proof", () => {
    expect(classifyArtifact("artifacts/XEO-3366/.DS_Store")).toBeNull();
    expect(classifyArtifact("artifacts/XEO-3366/constructor")).toMatchObject({ kind: "proof" });
  });
});

describe("groupArtifacts", () => {
  it("Given files for a known ticket, a stray key, and the board, when they are grouped, then only the known ticket keeps its own", () => {
    const refs = [
      "artifacts/T-1/a.png",
      "artifacts/T-1/b.txt",
      "artifacts/HOTFIX-9/c.txt",
      "design.md",
    ].flatMap((path) => classifyArtifact(path) ?? []);
    const groups = groupArtifacts(refs, ["T-1", "T-2"]);
    expect(groups.byTicket.get("T-1")?.map((ref) => ref.name)).toEqual(["a.png", "b.txt"]);
    expect(groups.byTicket.has("T-2")).toBe(false);
    expect(groups.board.map((ref) => ref.path)).toEqual(["artifacts/HOTFIX-9/c.txt", "design.md"]);
  });
});

describe("parseReadme", () => {
  it("Given files with indented descriptions, when it is parsed, then each file carries its description", () => {
    const text = [
      "XEO-3375 smoke evidence (list_brands, 2026-11-17)",
      "",
      "list-brands-outcomes.json",
      "  Output of a throwaway script.",
      "  Users: member and admin.",
      "",
      "  What it proves: the tool lists one row per brand.",
      "",
      "Not covered: no transport exists yet.",
    ].join("\n");
    expect(parseReadme(text)).toEqual([
      {
        file: "list-brands-outcomes.json",
        proves:
          "Output of a throwaway script. Users: member and admin. What it proves: the tool lists one row per brand.",
      },
    ]);
  });

  it("Given files with the description after two spaces, when it is parsed, then paths and descriptions split", () => {
    const text = [
      "Client: Claude Code's metadata document.",
      "run.sh                       The script that produced files 01-08.",
      "pr-screenshots/01-consent-page.png  Consent page after the 302.",
      "transport-probe.txt, vercel-edge-header-check.json   Earlier probes.",
    ].join("\n");
    expect(parseReadme(text)).toEqual([
      { file: "run.sh", proves: "The script that produced files 01-08." },
      { file: "pr-screenshots/01-consent-page.png", proves: "Consent page after the 302." },
    ]);
  });

  it("Given a file with no description, when it is parsed, then it is listed with an empty one", () => {
    expect(parseReadme("notes.txt\n")).toEqual([{ file: "notes.txt", proves: "" }]);
  });
});
