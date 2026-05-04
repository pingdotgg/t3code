import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function makeCheckpointWorkspace(fixtureName: string): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), `t3-orchestrator-v2-${fixtureName}-`));
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.name", "T3 Code Test"], { cwd });
  await execFileAsync("git", ["config", "user.email", "t3code-test@example.com"], { cwd });
  await writeFile(path.join(cwd, "README.md"), `# ${fixtureName}\n`, "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd });
  return cwd;
}
