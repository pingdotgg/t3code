// @effect-diagnostics nodeBuiltinImport:off - shared by the plain Node launcher and e2e tests, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** Writes and commits a small git repository at `root`, for use as a T3 project. */
export function writeFixtureRepository(root: string, name: string, env: NodeJS.ProcessEnv) {
  const files: Record<string, string> = {
    "README.md": `# ${name}\n\nA tiny project used by the T3 Code e2e suite.\n`,
    "package.json": `${JSON.stringify({ name, private: true, type: "module" }, null, 2)}\n`,
    "src/greet.ts":
      "export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const filePath = NodePath.join(root, relativePath);
    NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
    NodeFS.writeFileSync(filePath, contents);
  }
  const git = (...args: Array<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: root, env, stdio: "ignore" });
  git("init");
  git("add", ".");
  git("commit", "-m", "Initial commit");
}
