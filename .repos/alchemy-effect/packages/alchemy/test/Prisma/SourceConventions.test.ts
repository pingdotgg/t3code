import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ts from "typescript-api/unstable/ast";
import { API } from "typescript-api/unstable/async";

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

const prismaSourceProject = Effect.gen(function* () {
  const path = yield* Path.Path;
  const sourceRoot = path.resolve(import.meta.dirname, "../../src/Prisma");
  const configPath = path.join(sourceRoot, "tsconfig.source-conventions.json");
  const config = JSON.stringify({
    files: documentedResources.map((resource) =>
      path.join(sourceRoot, `${resource}.ts`),
    ),
    compilerOptions: { noResolve: true, noLib: true, types: [] },
  });
  const api = yield* Effect.acquireRelease(
    Effect.sync(
      () =>
        new API({
          fs: {
            readFile: (file) => (file === configPath ? config : undefined),
          },
        }),
    ),
    (api) => Effect.promise(() => api.close()),
  );
  const snapshot = yield* Effect.tryPromise(() =>
    api.updateSnapshot({ openProjects: [configPath] }),
  );
  const project = snapshot.getProject(configPath);
  if (!project) throw new Error(`Missing project ${configPath}`);
  return project.program;
});

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
      const path = yield* Path.Path;
      const sourceRoot = path.resolve(import.meta.dirname, "../../src/Prisma");
      const program = yield* prismaSourceProject;
      const missingDocs: string[] = [];

      for (const resource of documentedResources) {
        const fileName = `${resource}.ts`;
        const sourceFile = yield* Effect.tryPromise(() =>
          program.getSourceFile(path.join(sourceRoot, fileName)),
        );
        if (!sourceFile) throw new Error(`Missing source file ${fileName}`);
        const configInterfaces = [
          `${resource}Props`,
          ...(resourceConfigInterfaces[
            resource as keyof typeof resourceConfigInterfaces
          ] ?? []),
        ];

        for (const interfaceName of configInterfaces) {
          const declaration = sourceFile.statements
            .filter(ts.isInterfaceDeclaration)
            .find((node) => node.name.text === interfaceName);
          if (declaration === undefined) continue;
          for (const property of declaration.members.filter(
            ts.isPropertySignatureDeclaration,
          )) {
            if (!property.jsDoc?.length) {
              missingDocs.push(
                `${fileName}:${interfaceName}.${property.name.getText()}`,
              );
            }
          }
        }

        const resourceDeclaration = sourceFile.statements
          .filter(ts.isInterfaceDeclaration)
          .find((node) => node.name.text === resource);
        const attrs = resourceDeclaration?.heritageClauses?.find(
          (clause) => clause.token === ts.SyntaxKind.ExtendsKeyword,
        )?.types[0]?.typeArguments?.[2];
        const attributes =
          attrs && ts.isTypeLiteralNode(attrs) ? attrs : undefined;
        if (attributes === undefined) continue;
        for (const property of attributes.members.filter(
          ts.isPropertySignatureDeclaration,
        )) {
          if (!property.jsDoc?.length) {
            missingDocs.push(
              `${fileName}:${resource}.Attributes.${property.name.getText()}`,
            );
          }
        }
      }

      expect(missingDocs).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps raw artifact bytes out of persisted resource props", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const sourceRoot = path.resolve(import.meta.dirname, "../../src/Prisma");
      const program = yield* prismaSourceProject;

      for (const resource of ["Compute", "Deployment"] as const) {
        const sourceFile = yield* Effect.tryPromise(() =>
          program.getSourceFile(path.join(sourceRoot, `${resource}.ts`)),
        );
        if (!sourceFile) throw new Error(`Missing source file ${resource}.ts`);
        const props = sourceFile.statements
          .filter(ts.isInterfaceDeclaration)
          .find((node) => node.name.text === `${resource}Props`);
        const properties = props?.members
          .filter(ts.isPropertySignatureDeclaration)
          .map((node) => node.name.getText());
        expect(properties).not.toContain("artifact");
        expect(properties).toContain("artifactPath");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
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
