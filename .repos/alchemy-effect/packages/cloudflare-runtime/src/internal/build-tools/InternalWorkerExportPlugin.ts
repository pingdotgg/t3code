import path from "node:path";
import type * as rolldown from "rolldown";
import { RolldownMagicString } from "rolldown";

export const InternalWorkerExportPlugin = (): rolldown.Plugin => {
  const getChunks = (bundle: rolldown.OutputBundle) => {
    const chunks = new Map<string, rolldown.OutputChunk>();
    for (const [fileName, output] of Object.entries(bundle)) {
      if (output.type === "chunk") {
        chunks.set(fileName, output);
      }
    }
    return chunks;
  };

  const getImportedChunks = (
    chunk: rolldown.OutputChunk,
    chunks: Map<string, rolldown.OutputChunk>,
  ) => {
    const modules: Array<rolldown.OutputChunk> = [];
    const seen = new Set<string>();

    const visit = (module: rolldown.OutputChunk) => {
      for (const fileName of module.imports) {
        const imported = chunks.get(fileName);
        if (!imported || seen.has(fileName)) {
          continue;
        }
        seen.add(fileName);
        visit(imported);
        modules.push(imported);
      }
    };

    visit(chunk);
    return modules;
  };

  const getRelativeModulePath = (importer: string, imported: string) => {
    const relativePath = path.posix.relative(
      path.posix.dirname(importer),
      imported,
    );
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
  };

  return {
    name: "distilled:worker-exports",
    generateBundle(_options, bundle) {
      const chunks = getChunks(bundle);

      for (const chunk of chunks.values()) {
        const magicString = new RolldownMagicString(chunk.code);
        const code = chunk.code;

        if (chunk.isEntry) {
          const modules = getImportedChunks(chunk, chunks);
          const imports: Array<string> = [];
          const moduleEntries: Array<string> = [];
          for (let index = 0; index < modules.length; index++) {
            const module = modules[index];
            const relativePath = getRelativeModulePath(
              chunk.fileName,
              module.fileName,
            );
            if (module.isEntry) {
              imports.push(
                `import { modules as worker${index}Modules } from ${JSON.stringify(relativePath)};`,
              );
              moduleEntries.push(`  ...worker${index}Modules,`);
            } else {
              imports.push(
                `import worker${index} from ${JSON.stringify(relativePath)};`,
              );
              moduleEntries.push(
                `  ${JSON.stringify(module.fileName)}: worker${index},`,
              );
            }
          }

          magicString.update(
            0,
            code.length,
            [
              ...imports,
              imports.length > 0 ? "" : undefined,
              `export const main = ${JSON.stringify(chunk.fileName)};`,
              "export const modules = {",
              `  ${JSON.stringify(chunk.fileName)}: ${JSON.stringify(code)},`,
              ...moduleEntries,
              "};",
              "",
            ]
              .filter((line) => line !== undefined)
              .join("\n"),
          );
        } else {
          magicString.update(
            0,
            code.length,
            `export default ${JSON.stringify(code)};\n`,
          );
        }

        chunk.code = magicString.toString();
      }
    },
  };
};
