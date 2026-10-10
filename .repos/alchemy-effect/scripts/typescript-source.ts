import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { API, formatDiagnostics } from "typescript-api/unstable/async";

/** Native syntax-only project: don't load imports, libraries, or inferred types. */
export async function createSyntaxProject(files: readonly string[]) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "alchemy-typescript-"),
  );
  const configPath = path.join(directory, "tsconfig.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      files,
      compilerOptions: {
        noResolve: true,
        noLib: true,
        types: [],
        jsx: "preserve",
      },
    }),
  );
  const api = new API();
  try {
    const snapshot = await api.updateSnapshot({ openProjects: [configPath] });
    const project = snapshot.getProject(configPath);
    if (!project)
      throw new Error(`Failed to open syntax project ${configPath}`);
    const diagnostics = await project.program.getSyntacticDiagnostics();
    if (diagnostics.length)
      throw new Error(formatDiagnostics(diagnostics, api));
    return {
      api,
      project,
      async [Symbol.asyncDispose]() {
        try {
          await api.close();
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    try {
      await api.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
