const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const RAW_RUNNABLE_CODE_FENCE_LANGUAGES = new Set(["bash", "shell", "shellscript", "sh", "zsh"]);
const PROMPT_RUNNABLE_CODE_FENCE_LANGUAGES = new Set(["console", "shellsession", "terminal"]);

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? "text";
}

function normalizeShellCodeBlock(code: string): string {
  return code
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

function stripShellPromptPrefixes(code: string): string | null {
  const lines = normalizeShellCodeBlock(code).split("\n");
  let sawPrompt = false;
  const strippedLines = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return "";
    }
    if (line.startsWith("$ ")) {
      sawPrompt = true;
      return line.slice(2);
    }
    if (trimmed.startsWith("#")) {
      return line;
    }
    return null;
  });

  if (!sawPrompt || strippedLines.some((line) => line == null)) {
    return null;
  }

  return strippedLines.join("\n");
}

export function extractRunnableCommandFromCodeBlock(
  className: string | undefined,
  code: string,
): string | null {
  const language = extractFenceLanguage(className).toLowerCase();
  const normalizedCode = normalizeShellCodeBlock(code);
  if (normalizedCode.trim().length === 0) {
    return null;
  }

  const promptStripped = stripShellPromptPrefixes(normalizedCode);
  if (RAW_RUNNABLE_CODE_FENCE_LANGUAGES.has(language)) {
    return promptStripped ?? normalizedCode;
  }

  if (PROMPT_RUNNABLE_CODE_FENCE_LANGUAGES.has(language)) {
    return promptStripped;
  }

  if (language === "text") {
    return promptStripped;
  }

  return null;
}
