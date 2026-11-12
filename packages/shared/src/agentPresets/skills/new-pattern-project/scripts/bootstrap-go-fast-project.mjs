#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const TEMPLATE_REPO = "https://github.com/jayleaton/go-fast-stack";
const PROJECTS_DIR = "~/projects";

function run(command, args, cwd) {
  console.log(`$ ${command} ${args.join(" ")}`);
  NodeChildProcess.execFileSync(command, args, { cwd, stdio: "inherit" });
}

function parseArgs(argv) {
  const args = { visibility: "private", projectsDir: PROJECTS_DIR, template: TEMPLATE_REPO };
  const flags = new Set(["skip-github", "install", "verify"]);
  const values = new Set([
    "project-name",
    "display-name",
    "projects-dir",
    "module-path",
    "github-owner",
    "repo-name",
    "visibility",
    "template",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i].replace(/^--/, "");
    const key = flag.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (argv[i] === "--help") return null;
    if (!argv[i].startsWith("--")) throw new Error(`Unexpected argument: ${argv[i]}`);
    if (flags.has(flag)) args[key] = true;
    else if (values.has(flag) && argv[i + 1] && !argv[i + 1].startsWith("--"))
      args[key] = argv[++i];
    else throw new Error(`Unknown option or missing value: ${argv[i]}`);
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(args.projectName ?? ""))
    throw new Error("--project-name must be a lowercase directory slug");
  if (!args.displayName?.trim() || /[\r\n#$\\]/.test(args.displayName))
    throw new Error(
      "--display-name is required and must be one line without Make env metacharacters (#, $, backslash)",
    );
  args.repoName ??= args.projectName;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(args.repoName)) throw new Error("Invalid --repo-name");
  if (args.githubOwner && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(args.githubOwner))
    throw new Error("Invalid --github-owner");
  if (!["private", "public"].includes(args.visibility))
    throw new Error("--visibility must be private or public");
  if (!args.skipGithub && !args.githubOwner)
    throw new Error("Supply --github-owner for authorized publication, or --skip-github");
  args.modulePath ??= args.githubOwner
    ? `github.com/${args.githubOwner}/${args.repoName}`
    : `example.com/${args.projectName}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(args.modulePath))
    throw new Error("Invalid --module-path");
  return args;
}

function walk(root) {
  return NodeFS.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (
      [".git", "node_modules", ".cache", "bin", "vendor"].includes(entry.name) ||
      entry.isSymbolicLink()
    )
      return [];
    const path = NodePath.join(root, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.log(
      "Usage: node bootstrap-go-fast-project.mjs --project-name <slug> --display-name <name> [--projects-dir <path>] [--module-path <path>] [--skip-github | --github-owner <owner> --repo-name <name> --visibility private|public] [--template <source>] [--install] [--verify]",
    );
    return;
  }
  const projectsDir = NodePath.resolve(args.projectsDir.replace(/^~(?=\/|$)/, NodeOS.homedir()));
  const projectDir = NodePath.join(projectsDir, args.projectName);
  if (NodeFS.existsSync(projectDir))
    throw new Error(`Project directory already exists: ${projectDir}`);
  NodeFS.mkdirSync(projectsDir, { recursive: true });
  run("git", ["clone", "--depth", "1", "--", args.template, projectDir]);
  run("git", ["remote", "remove", "origin"], projectDir);
  const oldModule = NodeFS.readFileSync(NodePath.join(projectDir, "go.mod"), "utf8").match(
    /^module\s+(\S+)/m,
  )?.[1];
  if (!oldModule) throw new Error("Template go.mod has no module directive");
  const oldSlug = oldModule.split("/").at(-1);
  for (const file of walk(projectDir)) {
    if (
      !/\.(go|mod|templ|md|yaml|yml|json|toml|sh|[cm]?[jt]sx?)$/.test(file) &&
      !["Makefile", ".env.example"].includes(NodePath.basename(file))
    )
      continue;
    let text = NodeFS.readFileSync(file, "utf8");
    if (text.includes("\0")) continue;
    text = text
      .split(oldModule)
      .join(args.modulePath)
      .split(oldSlug)
      .join(args.projectName)
      .split("betterstack")
      .join(args.projectName)
      .split("Better Stack")
      .join(args.displayName);
    NodeFS.writeFileSync(file, text);
  }
  const envPath = NodePath.join(projectDir, ".env.example");
  let env = NodeFS.readFileSync(envPath, "utf8");
  for (const [key, value] of [
    ["APP_NAME", args.displayName],
    ["ADMIN_APP_NAME", `${args.displayName} Admin`],
  ]) {
    const line = `${key}=${value}`;
    const pattern = new RegExp(`^#? ?${key}=.*$`, "m");
    env = pattern.test(env) ? env.replace(pattern, () => line) : `${env}\n${line}\n`;
  }
  NodeFS.writeFileSync(envPath, env);
  const mobileDir = NodePath.join(projectDir, "apps/mobile-app");
  if (NodeFS.existsSync(NodePath.join(mobileDir, "package.json"))) {
    const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(mobileDir, "package.json"), "utf8"));
    pkg.name = `${args.projectName}-mobile`;
    NodeFS.writeFileSync(
      NodePath.join(mobileDir, "package.json"),
      `${JSON.stringify(pkg, null, 2)}\n`,
    );
    const app = JSON.parse(NodeFS.readFileSync(NodePath.join(mobileDir, "app.json"), "utf8"));
    app.expo.name = `${args.displayName} Mobile`;
    app.expo.slug = `${args.projectName}-mobile`;
    app.expo.scheme = args.projectName;
    NodeFS.writeFileSync(NodePath.join(mobileDir, "app.json"), `${JSON.stringify(app, null, 2)}\n`);
  }
  if (args.install) {
    for (const file of walk(projectDir).filter((path) => NodePath.basename(path) === "go.mod"))
      run("go", ["mod", "download"], NodePath.resolve(file, ".."));
  }
  if (args.verify)
    for (const target of ["lint", "test", "build"]) run("make", [target], projectDir);
  run("git", ["add", "."], projectDir);
  run("git", ["commit", "-m", `Initialize ${args.displayName} from Go Fast Stack`], projectDir);
  run("git", ["branch", "-M", "main"], projectDir);
  if (!args.skipGithub) {
    run("gh", ["auth", "status"], projectDir);
    run(
      "gh",
      [
        "repo",
        "create",
        `${args.githubOwner}/${args.repoName}`,
        `--${args.visibility}`,
        "--source",
        ".",
        "--remote",
        "origin",
        "--push",
      ],
      projectDir,
    );
  }
  console.log(
    `Created ${args.displayName} at ${projectDir}. Inspect names and git remotes, then follow the template's make-based checks and development runbook.`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
