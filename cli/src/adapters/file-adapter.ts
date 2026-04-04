/**
 * FileAdapter - File system operations for the CLI.
 *
 * T3 Code's server handles file access via workspace/project layers managed
 * server-side. The CLI runs directly against the local file system using
 * Node.js fs, so there's no shared wrapper to import — this is the adapter.
 *
 * @t3tools/shared/git is imported for .gitignore-aware scanning.
 */
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

export interface DirectoryEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

export interface WorkspaceContext {
  workingDirectory: string;
  files: string[];
}

export class FileAdapter {
  constructor(readonly workingDir: string) {}

  /** Scan the workspace, returning relative file paths (excludes node_modules, .git, dist). */
  async scan(): Promise<WorkspaceContext> {
    const files = await this.#walkDir(this.workingDir, this.workingDir);
    return { workingDirectory: this.workingDir, files };
  }

  /** Read a file by path (absolute or relative to workingDir). */
  async read(filePath: string): Promise<string> {
    const resolved = this.#resolve(filePath);
    return fs.readFile(resolved, "utf-8");
  }

  /** Write content to a file, creating directories as needed. */
  async write(filePath: string, content: string): Promise<void> {
    const resolved = this.#resolve(filePath);
    await fs.mkdir(nodePath.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf-8");
  }

  /** Delete a file. */
  async delete(filePath: string): Promise<void> {
    const resolved = this.#resolve(filePath);
    await fs.unlink(resolved);
  }

  /** Move a file (binary-safe: uses fs.copyFile then unlink). */
  async move(fromPath: string, toPath: string): Promise<void> {
    const from = this.#resolve(fromPath);
    const to = this.#resolve(toPath);
    await fs.mkdir(nodePath.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
    await fs.unlink(from);
  }

  /** List direct children of a directory. */
  async listDirectory(dirPath: string): Promise<DirectoryEntry[]> {
    const resolved = this.#resolve(dirPath);
    const entries = await fs.readdir(resolved, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      path: nodePath.join(dirPath, e.name),
      isDirectory: e.isDirectory(),
    }));
  }

  /** Resolve a path against the working directory. */
  #resolve(filePath: string): string {
    return nodePath.isAbsolute(filePath)
      ? filePath
      : nodePath.resolve(this.workingDir, filePath);
  }

  async #walkDir(dir: string, root: string): Promise<string[]> {
    const results: string[] = [];
    let entries: import("node:fs").Dirent<string>[];

    try {
      entries = await fs.readdir(dir, { withFileTypes: true, encoding: "utf-8" });
    } catch {
      return results;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await this.#walkDir(fullPath, root)));
      } else {
        results.push(nodePath.relative(root, fullPath));
      }
    }

    return results;
  }
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "dist-electron",
  ".turbo",
  ".next",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".cache",
]);
