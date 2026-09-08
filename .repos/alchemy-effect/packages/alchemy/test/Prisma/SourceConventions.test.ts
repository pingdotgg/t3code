import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { Project as MorphProject, SyntaxKind } from "ts-morph";

const forbiddenPatterns = [
  {
    name: "raw filesystem/path/os imports",
    pattern:
      /\bfrom\s+["'](?:node:fs|node:fs\/promises|node:path|node:os|pathe)["']/,
  },
  {
    name: "async/await",
    pattern: /(?:^|[^\w.])(?:async|await)\b/,
  },
  {
    name: "Effect.promise",
    pattern: /\bEffect\.promise\b/,
  },
  {
    name: "raw Promise constructor",
    pattern: /\bnew\s+Promise\b/,
  },
  {
    name: "raw fetch",
    pattern: /\bfetch\s*\(/,
  },
  {
    name: "Effect.orDie",
    pattern: /\bEffect\.orDie\b/,
  },
  {
    name: "legacy create/update lifecycle handlers",
    pattern: /\b(?:create|update)\s*:\s*Effect\.fn\b/,
  },
  {
    name: "explicit output undefined create/update branch",
    pattern:
      /\b(?:output\s*(?:===|!==)\s*undefined|undefined\s*(?:===|!==)\s*output)\b/,
  },
  {
    name: "bare process.cwd()",
    pattern: /\bprocess\.cwd\(\)/,
  },
  {
    name: "explicit any",
    pattern: /\bany\b/,
  },
  {
    name: "double unknown cast",
    pattern: /\bas\s+unknown\s+as\b/,
  },
] as const;

const documentedResources = [
  "Branch",
  "Bucket",
  "BucketAccessKey",
  "Compute",
  "App",
  "Deployment",
  "Connection",
  "CustomDomain",
  "Database",
  "EnvironmentVariable",
  "Project",
  "SourceRepository",
] as const;

const resourceConfigInterfaces = {
  Compute: ["ComputeBuild", "ComputeDev", "ComputeProps"],
  Connection: ["ConnectionEnvOptions"],
  Database: ["DatabaseDev"],
} as const;

const nodePlatformBoundaryFiles = new Set([
  "Internal/ArchivePlatform.ts",
  "Internal/ArtifactFile.ts",
]);

const stripStringsAndComments = (source: string) =>
  source
    .replaceAll(/`(?:\\.|[^`])*`/gs, "``")
    .replaceAll(/"(?:\\.|[^"])*"/g, '""')
    .replaceAll(/'(?:\\.|[^'])*'/g, "''")
    .replaceAll(/\/\*[\s\S]*?\*\//g, "")
    .replaceAll(/\/\/.*$/gm, "");

describe("Prisma source conventions", () => {
  it.effect("keeps provider source in Effect-style lifecycle conventions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceRoot = path.resolve(import.meta.dirname, "../../src/Prisma");
      const files = (yield* fs.readDirectory(sourceRoot, { recursive: true }))
        .filter((file) => file.endsWith(".ts"))
        .sort();

      const violations: string[] = [];
      for (const file of files) {
        const fullPath = path.join(sourceRoot, file);
        const source = yield* fs.readFileString(fullPath);
        for (const { name, pattern } of forbiddenPatterns) {
          if (
            nodePlatformBoundaryFiles.has(file) &&
            (name === "raw filesystem/path/os imports" ||
              name === "async/await")
          ) {
            continue;
          }
          const scannedSource =
            name === "raw filesystem/path/os imports"
              ? source
              : stripStringsAndComments(source);
          const match = pattern.exec(scannedSource);
          if (match) {
            violations.push(`${file}: ${name}: ${match[0]}`);
          }
        }
      }

      expect(violations).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps Prisma resources ready for generated API docs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceRoot = path.resolve(import.meta.dirname, "../../src/Prisma");

      for (const resource of documentedResources) {
        const source = yield* fs.readFileString(
          path.join(sourceRoot, `${resource}.ts`),
        );
        expect(source).toContain(`export interface ${resource}Props`);
        const constructorPattern =
          resource === "Compute"
            ? `export const ${resource}: Platform<`
            : `export const ${resource} = Resource<`;
        expect(source).toContain(constructorPattern);

        const resourceDoc = source.match(
          new RegExp(
            resource === "Compute"
              ? `/\\*\\*[\\s\\S]*?\\*/\\s*export const ${resource}: Platform<`
              : `/\\*\\*[\\s\\S]*?\\*/\\s*export const ${resource} = Resource<`,
          ),
        )?.[0];
        if (resourceDoc === undefined) {
          throw new Error(`${resource} is missing resource JSDoc`);
        }
        // `docs:fix-jsdoc` rewrites `@section` / `@example` into markdown
        // headings (`###` / `**Example:**`). Source of truth is the
        // rewritten form — see scripts/fix-api-jsdocs.ts.
        expect(resourceDoc).toContain("### ");
        expect(resourceDoc).toContain("**Example:**");
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("documents public Prisma resource props and attributes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceRoot = path.resolve(import.meta.dirname, "../../src/Prisma");
      const project = new MorphProject({ useInMemoryFileSystem: true });
      const missingDocs: string[] = [];

      for (const resource of documentedResources) {
        const fileName = `${resource}.ts`;
        const source = yield* fs.readFileString(
          path.join(sourceRoot, fileName),
        );
        const sourceFile = project.createSourceFile(fileName, source, {
          overwrite: true,
        });
        const configInterfaces = [
          `${resource}Props`,
          ...(resourceConfigInterfaces[
            resource as keyof typeof resourceConfigInterfaces
          ] ?? []),
        ];

        for (const interfaceName of configInterfaces) {
          const declaration = sourceFile.getInterface(interfaceName);
          if (declaration === undefined) continue;
          for (const property of declaration.getProperties()) {
            if (property.getJsDocs().length === 0) {
              missingDocs.push(
                `${fileName}:${interfaceName}.${property.getName()}`,
              );
            }
          }
        }

        const resourceDeclaration = sourceFile.getInterface(resource);
        const attributes = resourceDeclaration
          ?.getExtends()[0]
          ?.getTypeArguments()[2]
          ?.asKind(SyntaxKind.TypeLiteral);
        if (attributes === undefined) continue;
        for (const property of attributes.getProperties()) {
          if (property.getJsDocs().length === 0) {
            missingDocs.push(
              `${fileName}:${resource}.Attributes.${property.getName()}`,
            );
          }
        }
      }

      expect(missingDocs).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps raw artifact bytes out of persisted resource props", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceRoot = path.resolve(import.meta.dirname, "../../src/Prisma");
      const project = new MorphProject({ useInMemoryFileSystem: true });

      for (const resource of ["Compute", "Deployment"] as const) {
        const source = yield* fs.readFileString(
          path.join(sourceRoot, `${resource}.ts`),
        );
        const sourceFile = project.createSourceFile(`${resource}.ts`, source, {
          overwrite: true,
        });
        const props = sourceFile.getInterface(`${resource}Props`);
        expect(props?.getProperty("artifact")).toBeUndefined();
        expect(props?.getProperty("artifactPath")).toBeDefined();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("models deployment environment values as redaction markers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.readFileString(
        path.resolve(import.meta.dirname, "../../src/Prisma/Types.ts"),
      );

      expect(source).toContain(
        'export type RedactedDeploymentEnvironmentValue = "[redacted]"',
      );
      expect(source).toContain(
        "envVars?: Record<string, RedactedDeploymentEnvironmentValue>",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
