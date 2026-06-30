// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

export const unsafeWorkflowInstructionPathMessage = (repoRelativePath: string): string =>
  `Instruction file path must be relative and stay within the project root: "${repoRelativePath}"`;

export const isSafeWorkflowInstructionPath = (repoRelativePath: string): boolean => {
  if (NodePath.isAbsolute(repoRelativePath) || NodePath.win32.isAbsolute(repoRelativePath)) {
    return false;
  }

  return !repoRelativePath.split(/[\\/]+/).some((segment) => segment === "..");
};

export const resolveWorkflowInstructionPath = (
  repoRoot: string,
  repoRelativePath: string,
): string | null =>
  isSafeWorkflowInstructionPath(repoRelativePath) ? NodePath.resolve(repoRoot, repoRelativePath) : null;

export const containsRealPath = (realRoot: string, realTarget: string): boolean => {
  const relative = NodePath.relative(realRoot, realTarget);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
};
