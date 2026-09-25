// Dependency-free so the stack check also runs before pnpm install in fork CI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function git(...args) {
  return NodeChildProcess.execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function loadFeatures(root) {
  const text = NodeFS.readFileSync(NodePath.join(root, "docs/fork-features.md"), "utf8");
  const features = [...text.matchAll(/^```json\r?\n([\s\S]*?)^```\s*$/gm)].map((m) =>
    JSON.parse(m[1]),
  );
  if (!features.length) throw new Error("docs/fork-features.md has no feature entries");
  const ids = new Set();
  for (const feature of features) {
    if (
      typeof feature.id !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(feature.id) ||
      ids.has(feature.id)
    ) {
      throw new Error(`invalid or duplicate feature id: ${feature.id}`);
    }
    ids.add(feature.id);
    if (typeof feature.purpose !== "string" || !feature.purpose.trim()) {
      throw new Error(`${feature.id}: missing purpose`);
    }
    for (const field of ["issues", "prs", "newFiles", "upstreamFiles", "sharedFiles", "keywords"]) {
      const values = feature[field];
      if (!Array.isArray(values) || values.some((v) => typeof v !== "string" || !v.trim())) {
        throw new Error(`${feature.id}: invalid ${field}`);
      }
      if (new Set(values).size !== values.length) {
        throw new Error(`${feature.id}: duplicate ${field}`);
      }
    }
    if (!feature.issues.length || !feature.prs.length || !feature.keywords.length) {
      throw new Error(`${feature.id}: Issue, PR and watch keywords are required`);
    }
  }
  const allowlist = NodeFS.readFileSync(
    NodePath.join(root, "scripts/fork-upstream-edits.txt"),
    "utf8",
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  for (const path of new Set(allowlist)) {
    const owners = features.filter((feature) => feature.upstreamFiles.includes(path));
    if (owners.length !== 1) {
      throw new Error(`${path}: expected exactly one feature owner, found ${owners.length}`);
    }
  }
  for (const feature of features) {
    for (const path of feature.upstreamFiles) {
      if (!allowlist.includes(path))
        throw new Error(`${feature.id}: path not allowlisted: ${path}`);
    }
  }
  return features;
}

// Escape commit subjects/keywords before placing them in Markdown table cells.
function cell(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("\n", " ");
}

function report(features, baseRef, targetRef) {
  const base = git("rev-parse", "--verify", `${baseRef}^{commit}`).trim();
  const target = git("rev-parse", "--verify", `${targetRef}^{commit}`).trim();
  git("merge-base", "--is-ancestor", base, target);
  const commits = git("rev-list", "--reverse", `${base}..${target}`)
    .trim()
    .split("\n")
    .filter(Boolean);
  const matches = new Map(features.map((f) => [f.id, []]));
  for (const sha of commits) {
    const title = git("show", "-s", "--format=%s", sha).trim();
    // Compare every commit to its first parent, including merge commits. Disable
    // renames so both old and new paths are visible, and external diff drivers.
    const paths = git("diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", `${sha}^`, sha)
      .split("\0")
      .filter(Boolean);
    const patch = git(
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--unified=0",
      `${sha}^`,
      sha,
    );
    const haystacks = {
      title: title.toLowerCase(),
      files: paths.join("\n").toLowerCase(),
      diff: patch.toLowerCase(),
    };
    for (const feature of features) {
      const reasons = [];
      const files = new Set([
        ...feature.newFiles,
        ...feature.upstreamFiles,
        ...feature.sharedFiles,
      ]);
      for (const path of paths) if (files.has(path)) reasons.push(`file: ${path}`);
      for (const keyword of feature.keywords) {
        const sources = Object.entries(haystacks)
          .filter(([, value]) => value.includes(keyword.toLowerCase()))
          .map(([source]) => source);
        if (sources.length) reasons.push(`keyword (${sources.join(", ")}): ${keyword}`);
      }
      if (reasons.length) matches.get(feature.id).push({ sha, title, reasons });
    }
  }
  console.log(
    `# Upstream overlap report\n\nBase: ${base}\n\nTarget: ${target}\n\nScanned ${commits.length} upstream commit(s).`,
  );
  console.log(
    "\nCopy this report into the absorption PR. For EVERY match replace PENDING with one decision and a rationale: keep ours; adopt upstream and delete ours; merge both. Record removed paths or the combined behavior and proof. No matches is not proof of no semantic overlap.",
  );
  for (const feature of features) {
    console.log(`\n## ${feature.id}\n\n${feature.purpose}`);
    const rows = matches.get(feature.id);
    if (!rows.length) {
      console.log("\nNo matches.");
      continue;
    }
    console.log("\n| Commit | Match evidence | Decision and rationale |\n| --- | --- | --- |");
    for (const row of rows) {
      console.log(`| ${row.sha} ${cell(row.title)} | ${cell(row.reasons.join("; "))} | PENDING |`);
    }
  }
}

try {
  const [command, ...args] = process.argv.slice(2);
  const root = git("rev-parse", "--show-toplevel").trim();
  const features = loadFeatures(root);
  if (command === "check" && args.length === 0) {
    console.log(`fork-features: OK (${features.length} features).`);
  } else if (command === "report" && args.length === 2) {
    report(features, ...args);
  } else {
    throw new Error("usage: node scripts/fork-features.mjs check | report <base> <target>");
  }
} catch (error) {
  console.error(`fork-features: FAIL: ${error.message}`);
  process.exitCode = 1;
}
