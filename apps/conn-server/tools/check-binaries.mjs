import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, accessSync, constants } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot } from "./monorepo.mjs";
import { cargoBuildEnv } from "./sealed-env.mjs";

const examples = [
  ["release", "conn-server", "effect_fixture", "replay_server", "settings_secrets", "text_generation", "model_manifest_cache", "mcp_apps"],
  ["release", "conn-engine", "export_turn", "tool_output_cases"],
  ["release", "conn-source-control", "registry_cases", "pr_watch_cases"],
  ["release", "conn-features", "webhook_functions"],
  ["release", "conn-mcp", "html_cases"],
  ["debug", "conn-provider-codex", "conformance", "codex_probe"],
  ["debug", "conn-provider-claude", "conformance", "claude_probe", "t3_replay"],
  ["debug", "conn-provider-acp", "conformance", "grok_probe"],
  ["debug", "conn-engine", "t3_fixture_replay"],
];

export function exampleBinary(pkg, name) {
  const row = examples.find(([, owner, ...names]) => owner === pkg && names.includes(name));
  if (!row) throw new Error(`Unknown check binary: ${pkg}/${name}`);
  if (process.env.CONN_CHECK_BINARIES) {
    const binary = row[0] === "release"
      ? resolve(process.env.CONN_CHECK_BINARIES, "release/examples", name)
      : resolve(process.env.CONN_CHECK_BINARIES, pkg, name);
    accessSync(binary, constants.X_OK);
    return binary;
  }
  build(row[0], [[pkg, name]]);
  return join(process.env.CARGO_TARGET_DIR ? resolve(repoRoot, process.env.CARGO_TARGET_DIR) : join(repoRoot, "target"), row[0], "examples", name);
}

function build(profile, selections, withServer = false) {
  const args = ["build", "--locked", "--quiet"];
  if (profile === "release") args.push("--release");
  for (const [pkg, ...names] of selections) {
    args.push("-p", pkg);
    if (pkg === "conn-engine" && names.includes("export_turn")) args.push("--features", "conn-engine/fake-provider");
    for (const name of names) args.push("--example", name);
  }
  if (withServer) args.push("--bin", "conn-server");
  const result = spawnSync("cargo", args, { cwd: repoRoot, env: cargoBuildEnv(), stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Building ${profile} comparison binaries failed (${result.status})`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--build") {
    const selectedProfile = process.argv[4] ?? "all";
    if (!["all", "release", "debug"].includes(selectedProfile)) {
      throw new Error(`Unknown build profile: ${selectedProfile}`);
    }
    const selectedPackage = process.argv[5] ?? "all";
    const selected = examples.filter(([profile, pkg]) =>
      (selectedProfile === "all" || selectedProfile === profile)
      && (selectedPackage === "all" || selectedPackage === pkg),
    );
    if (!selected.length) throw new Error(`No comparison binaries for ${selectedProfile}/${selectedPackage}`);
    const out = resolve(process.argv[3]);
    mkdirSync(join(out, "release/examples"), { recursive: true });
    const release = selected.filter(([profile]) => profile === "release");
    if (release.length) {
      console.time("release");
      build("release", release.map(([, ...selection]) => selection), true);
      console.timeEnd("release");
    }
    for (const [profile, pkg, ...names] of selected) {
      // Debug conformance examples share a filename; copy each before the next build.
      if (profile === "debug") {
        console.time(`${profile}/${pkg}`);
        build(profile, [[pkg, ...names]]);
        console.timeEnd(`${profile}/${pkg}`);
      }
      if (profile === "debug") mkdirSync(join(out, pkg), { recursive: true });
      for (const name of names) {
        const source = join(repoRoot, "target", profile, "examples", name);
        copyFileSync(source, profile === "release" ? join(out, "release/examples", name) : join(out, pkg, name));
      }
    }
    if (release.length) {
      copyFileSync(join(repoRoot, "target/release/conn-server"), join(out, "release/conn-server"));
    }
  } else {
    console.log(exampleBinary(process.argv[2], process.argv[3]));
  }
}
