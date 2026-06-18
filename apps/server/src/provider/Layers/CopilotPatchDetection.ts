function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function commandLooksLikeCopilotPatchEdit(command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  return /(?:^|\s)apply_patch(?:\s|$)/u.test(command) || command.includes("*** Begin Patch");
}

export function hasCopilotApplyPatchEdit(detail: string): boolean {
  return extractCopilotApplyPatchEdit(detail) !== undefined;
}

export function extractCopilotApplyPatchEdit(detail: string | undefined): string | undefined {
  const normalized = trimOrUndefined(detail?.replace(/\r\n/g, "\n"));
  if (!normalized) {
    return undefined;
  }
  const beginIndex = normalized.indexOf("*** Begin Patch");
  if (beginIndex < 0) {
    return undefined;
  }
  const lines = normalized.slice(beginIndex).split("\n");
  if (lines[0]?.trim() !== "*** Begin Patch") {
    return undefined;
  }
  const patchLines: Array<string> = [];
  for (const line of lines) {
    patchLines.push(line);
    if (line.trim() === "*** End Patch") {
      break;
    }
  }
  if (patchLines.at(-1)?.trim() !== "*** End Patch") {
    return undefined;
  }
  const patch = patchLines.join("\n").trim();
  return patch.includes("\n*** Update File: ") ||
    patch.includes("\n*** Add File: ") ||
    patch.includes("\n*** Delete File: ") ||
    patch.includes("\n*** Move to: ")
    ? patch
    : undefined;
}

const SHELL_COMPLETION_CONTROL_LINE_PATTERN = /^<shellId: [^>]+ completed with exit code \d+>$/;

export function stripCopilotShellCompletionControlLines(detail: string): string {
  return detail
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line) => !SHELL_COMPLETION_CONTROL_LINE_PATTERN.test(line.trim()))
    .join("\n")
    .trim();
}

export function hasUnifiedDiffShape(detail: string): boolean {
  return (
    detail.includes("diff --git ") ||
    /(?:^|\n)--- [^\n]+\n\+\+\+ [^\n]+\n@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u.test(detail)
  );
}

export function hasPatchHeaderShape(detail: string): boolean {
  return /(?:^|\n)--- [^\n]+\n\+\+\+ [^\n]+/u.test(detail);
}
