import { defineRule } from "@oxlint/plugins";
import * as Option from "effect/Option";

import { getPropertyName, isIdentifier, unwrapExpression } from "../utils.ts";

const RUNTIME_PROPERTIES = new Set(["platform", "arch"]);
const HOST_PROCESS_REFERENCE_FILE = "packages/shared/src/hostProcess.ts";
const SCOPED_RUNTIME_MODULE_PREFIXES = [
  "apps/server/src/process/externalLauncher.ts",
  "apps/server/src/provider/",
  "apps/server/src/textGeneration/",
  "packages/ssh/src/",
  "scripts/build-desktop-artifact.ts",
  "scripts/dev-runner.ts",
  "scripts/lib/build-target-arch.ts",
] as const;

const normalizePath = (path: string) => path.replaceAll("\\", "/");

const toRepoPath = (filename: string, cwd: string) => {
  const normalizedFilename = normalizePath(filename);
  const normalizedCwd = normalizePath(cwd).replace(/\/+$/u, "");
  const prefix = `${normalizedCwd}/`;
  return normalizedFilename.startsWith(prefix)
    ? normalizedFilename.slice(prefix.length)
    : normalizedFilename;
};

const isHostProcessReferenceFile = (filename: string, cwd: string) =>
  toRepoPath(filename, cwd) === HOST_PROCESS_REFERENCE_FILE;

const shouldCheckFile = (filename: string, cwd: string) => {
  if (normalizePath(filename).endsWith("/fixture.ts")) return true;

  const repoPath = toRepoPath(filename, cwd);
  if (repoPath.endsWith(".test.ts") || repoPath.includes("/test/")) return false;

  return SCOPED_RUNTIME_MODULE_PREFIXES.some((prefix) => repoPath.startsWith(prefix));
};

const isGlobalProcessObject = (node: unknown): boolean => {
  const expression = unwrapExpression(node);
  if (isIdentifier(expression, "process")) return true;
  if (Option.isNone(expression) || expression.value.type !== "MemberExpression") return false;

  const object = unwrapExpression(expression.value.object);
  const property = getPropertyName(expression.value.property);
  return (
    isIdentifier(object, "globalThis") && Option.isSome(property) && property.value === "process"
  );
};

const message = (property: string) =>
  `Use HostProcess${property === "arch" ? "Architecture" : "Platform"} instead of process.${property}; inject the runtime reference in Effect code and provide it explicitly in tests.`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct host runtime platform/architecture reads outside the shared host process references.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (isHostProcessReferenceFile(context.filename, context.cwd)) return;
        if (!shouldCheckFile(context.filename, context.cwd)) return;

        const property = getPropertyName(node.property);
        if (Option.isNone(property) || !RUNTIME_PROPERTIES.has(property.value)) return;
        if (!isGlobalProcessObject(node.object)) return;

        context.report({
          node,
          message: message(property.value),
        });
      },
    };
  },
});
