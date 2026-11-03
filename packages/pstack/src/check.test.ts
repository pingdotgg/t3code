// @effect-diagnostics nodeBuiltinImport:off - Pack inspection is synchronous and independent of the server runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { checkPack } from "./check.ts";
import { fileFingerprint, packFiles, type UpstreamManifest } from "./files.ts";
import {
  parsePstackRoleDefaults,
  pstackContentHash,
  pstackPackEntries,
  PSTACK_SKILL_PREFIX,
  PSTACK_LAYOUT_VERSION,
} from "./index.ts";

const packageDir = NodeURL.fileURLToPath(new URL("..", import.meta.url));

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pstack-check-"));
  const write = (path: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, path), text);
  };
  const seal = () => {
    const manifest: UpstreamManifest = {
      repository: "https://github.com/ScriptedAlchemy/pstack-t3code",
      commit: "a".repeat(40),
      subtreeHash: "b".repeat(40),
      version: "1.0.0",
      files: Object.fromEntries(
        packFiles(NodePath.join(root, "upstream")).map((path) => [
          path,
          fileFingerprint(NodePath.join(root, "upstream", path)),
        ]),
      ),
    };
    write("UPSTREAM.json", `${JSON.stringify(manifest)}\n`);
  };
  write(
    "upstream/skills/setup-pstack/SKILL.md",
    `---\nname: setup-pstack\n---\n### 5. Write the rule\n\n\`\`\`\n---\ndescription: roles\nalwaysApply: true\n---\n# budget: large\n${Array.from({ length: 17 }, (_, index) => `role ${index}: inherit-parent`).join("\n")}\n\`\`\`\n### 6. Confirm\n`,
  );
  write("upstream/README.md", "# Native T3 Code pack\n");
  write("upstream/helper.sh", "#!/bin/sh\nexit 0\n");
  NodeFS.chmodSync(NodePath.join(root, "upstream/helper.sh"), 0o755);
  seal();
  return {
    root,
    write,
    seal,
    [Symbol.dispose]: () => NodeFS.rmSync(root, { recursive: true, force: true }),
  };
}

describe("checkPack", () => {
  it("checks the shipped native snapshot", () => {
    expect(checkPack(packageDir)).toEqual([]);
  });

  it("accepts a complete fixture", () => {
    using pack = fixture();
    expect(checkPack(pack.root)).toEqual([]);
  });

  it("reports all missing, extra, modified, and non-executable files", () => {
    using pack = fixture();
    pack.write("upstream/helper.sh", "changed\n");
    NodeFS.chmodSync(NodePath.join(pack.root, "upstream/helper.sh"), 0o644);
    pack.write("upstream/extra.md", "extra\n");
    NodeFS.rmSync(NodePath.join(pack.root, "upstream/README.md"));
    expect(checkPack(pack.root)).toEqual(
      expect.arrayContaining([
        "Missing upstream file: README.md",
        "Unrecorded upstream file: extra.md",
        "Hash mismatch: helper.sh",
        "Executable flag mismatch: helper.sh",
      ]),
    );
  });

  it.each(["missing", "invalid JSON", "invalid metadata", "invalid file entry"])(
    "reports an %s manifest",
    (kind) => {
      using pack = fixture();
      if (kind === "missing") NodeFS.rmSync(NodePath.join(pack.root, "UPSTREAM.json"));
      else if (kind === "invalid JSON") pack.write("UPSTREAM.json", "{");
      else if (kind === "invalid metadata") pack.write("UPSTREAM.json", "{}");
      else {
        const text = NodeFS.readFileSync(NodePath.join(pack.root, "UPSTREAM.json"), "utf8");
        pack.write("UPSTREAM.json", text.replace('"helper.sh"', '"../helper.sh"'));
      }
      expect(checkPack(pack.root).some((problem) => problem.startsWith("UPSTREAM.json:"))).toBe(
        true,
      );
    },
  );

  it("reports missing source without throwing", () => {
    using pack = fixture();
    NodeFS.rmSync(NodePath.join(pack.root, "upstream"), { recursive: true });
    const problems = checkPack(pack.root);
    expect(problems.some((problem) => problem.startsWith("upstream:"))).toBe(true);
    expect(problems).toContain("Expected 17 role defaults, found 0");
  });

  it("requires each skill's frontmatter name to match its folder", () => {
    using pack = fixture();
    pack.write("upstream/skills/wrong/SKILL.md", "---\nname: other\n---\n# Wrong\n");
    pack.seal();
    expect(checkPack(pack.root)).toEqual([
      'Frontmatter name mismatch: skills/wrong/SKILL.md has "other", expected wrong',
    ]);
  });

  it.each([
    "`Task`",
    "AskQuestion",
    "todo list",
    "generalPurpose",
    "readonly: true",
    'environment: "cloud"',
    "cloud_base_branch",
    "run_in_background",
    "`resume`",
    "file_attachments",
    "pstack-models.mdc",
    ".cursor/skills/",
    "~/.cursor/plugins/",
    ".cursor/rules/",
    "agent-transcripts",
    "Bugbot",
    "/loop",
    "update_state",
    "watch-pr",
    "bootstrap",
    "Custom Mode",
    "create-skill",
    "cursor-team-kit",
    "docs/harness/t3-code.md",
    "gpt-6-astra",
    "grok-4.7",
    "claude-opus-5-5",
    "grok-4.7-fast",
  ])("rejects non-native pack content %s", (term) => {
    using pack = fixture();
    pack.write("upstream/guide.md", `Use ${term}.\n`);
    pack.seal();
    expect(checkPack(pack.root)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^Non-native term .+: guide\.md:1$/)]),
    );
  });

  it("checks helper source and permits native personas, defaults, and status-only verdicts", () => {
    using pack = fixture();
    pack.write(
      "upstream/README.md",
      "poteto-agent comment-sicko inherit-parent\nwatch-pr --status-only\n",
    );
    pack.write(
      "upstream/skills/poteto-mode/scripts/watch-pr/github.ts",
      "function isBugbot() {}\n",
    );
    pack.write("upstream/helper.ts", 'import { check } from "./passes/loop-check.ts";\n');
    pack.seal();
    expect(checkPack(pack.root)).toEqual([]);
    pack.write("upstream/helper.sh", "AskQuestion\n");
    pack.seal();
    expect(checkPack(pack.root)).toEqual(["Non-native term `AskQuestion`: helper.sh:1"]);
  });

  it("requires 17 distinct role defaults", () => {
    using pack = fixture();
    const path = "upstream/skills/setup-pstack/SKILL.md";
    const original = NodeFS.readFileSync(NodePath.join(pack.root, path), "utf8");
    pack.write(path, original.replace("role 16: inherit-parent\n", ""));
    pack.seal();
    expect(checkPack(pack.root)).toEqual(["Expected 17 role defaults, found 16"]);
    pack.write(path, original.replace("role 16:", "role 15:"));
    pack.seal();
    expect(checkPack(pack.root)).toEqual(["Duplicate role default labels"]);
  });
});

describe("pack interface", () => {
  it("omits gitignore metadata and desktop-pruned fixtures from delivery while verifying upstream bytes", () => {
    using pack = fixture();
    pack.write("upstream/.gitignore", "node_modules/\n");
    pack.write("upstream/skills/.gitignore", "local/\n");
    pack.write("upstream/skills/bun.lock", "lockfile\n");
    pack.write("upstream/skills/statechart/scripts/statechart.ts", "export {};\n");
    pack.write("upstream/skills/statechart/scripts/test/chart.test.ts", "test\n");
    pack.seal();
    expect(checkPack(pack.root)).toEqual([]);
    const paths = pstackPackEntries(pack.root).map(({ packPath }) => packPath);
    expect(paths).not.toContain(".gitignore");
    expect(paths).not.toContain("skills/.gitignore");
    expect(paths).toContain("skills/bun.lock");
    expect(paths).toContain("skills/statechart/scripts/statechart.ts");
    expect(paths).not.toContain("skills/statechart/scripts/test/chart.test.ts");
    pack.write("upstream/.gitignore", "changed\n");
    expect(checkPack(pack.root)).toContain("Hash mismatch: .gitignore");
    NodeFS.rmSync(NodePath.join(pack.root, "upstream/.gitignore"));
    expect(checkPack(pack.root)).toContain("Missing upstream file: .gitignore");
    expect(() => pstackPackEntries(pack.root)).not.toThrow();
  });

  it("invalidates the delivery stamp from the adapter layout", () => {
    using pack = fixture();
    expect(pstackContentHash(pack.root)).not.toBe(pstackContentHash(pack.root, 2));
  });

  it("uses manifest executable flags despite archive modes and keeps T3 files non-executable", () => {
    using pack = fixture();
    NodeFS.chmodSync(NodePath.join(pack.root, "upstream/helper.sh"), 0o644);
    NodeFS.chmodSync(NodePath.join(pack.root, "UPSTREAM.json"), 0o755);
    const entries = pstackPackEntries(pack.root);
    expect(entries).toContainEqual({
      packPath: "helper.sh",
      sourcePath: NodePath.join(pack.root, "upstream/helper.sh"),
      executable: true,
    });
    expect(entries).toContainEqual({
      packPath: "UPSTREAM.json",
      sourcePath: NodePath.join(pack.root, "UPSTREAM.json"),
      executable: false,
    });
    expect(entries).toHaveLength(4);
    expect(PSTACK_SKILL_PREFIX).toBe("pstack:");
  });

  it("keys content by the layout version and native subtree", () => {
    using pack = fixture();
    const hash = pstackContentHash(pack.root);
    expect(hash).toMatch(/^[a-f0-9]{16}$/);
    expect(pstackContentHash(pack.root)).toBe(hash);
    expect(pstackContentHash(pack.root, PSTACK_LAYOUT_VERSION + 1)).not.toBe(hash);
    const manifest = NodeFS.readFileSync(NodePath.join(pack.root, "UPSTREAM.json"), "utf8");
    pack.write("UPSTREAM.json", manifest.replace("a".repeat(40), "c".repeat(40)));
    expect(pstackContentHash(pack.root)).toBe(hash);
    pack.write("UPSTREAM.json", manifest.replace("b".repeat(40), "d".repeat(40)));
    expect(pstackContentHash(pack.root)).not.toBe(hash);
  });

  it("derives all roles from upstream step 5, preserving comma-bearing labels", () => {
    const markdown = NodeFS.readFileSync(
      NodePath.join(packageDir, "upstream/skills/setup-pstack/SKILL.md"),
      "utf8",
    );
    const roles = parsePstackRoleDefaults(markdown);
    expect(roles).toHaveLength(17);
    expect(roles[0]).toEqual({
      label: "feature, refactoring",
      defaultValue: "grok-4.7-xhigh",
    });
    expect(roles.find(({ label }) => label === "architect runners")).toEqual({
      label: "architect runners",
      defaultValue: "claude-opus-5-5-xhigh, grok-4.7-xhigh",
    });
    expect(parsePstackRoleDefaults(markdown.replaceAll("\n", "\r\n"))).toEqual(roles);
    expect(parsePstackRoleDefaults("### 4. Other\n```\nignore: value\n```\n")).toEqual([]);
  });
});
