import type { MemoryVaultAccess, MemoryVaultDetailLevel } from "@t3tools/contracts";

export const DEFAULT_VAULT_FILES: ReadonlyArray<readonly [string, string]> = [
  ["PROJECT.md", "# Project\n\nWhat this project is, who it is for, and its current goals.\n"],
  [
    "ARCHITECTURE.md",
    "# Architecture\n\nMain components, how they connect, and where code lives.\n",
  ],
  ["DECISIONS.md", "# Decisions\n\nImportant technical decisions and why they were made.\n"],
  ["TASKS.md", "# Tasks\n\n## In progress\n\n## Done\n"],
  [
    "BUGS_AND_FIXES.md",
    "# Bugs and fixes\n\nSignificant errors, their causes, and how they were fixed.\n",
  ],
  ["DEVELOPMENT_HISTORY.md", "# Development history\n\nNotable changes, newest first.\n"],
  [
    "USER_PREFERENCES.md",
    "# User preferences\n\nHow the user likes to work: style, tools, conventions.\n",
  ],
];

export function slugifyVaultName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug === "" ? "vault" : slug;
}

export interface VaultSection {
  readonly path: string;
  readonly heading: string;
  readonly text: string;
}

/** Splits Markdown into sections at headings, keeping each heading with its body. */
export function splitSections(path: string, content: string): ReadonlyArray<VaultSection> {
  const sections: Array<VaultSection> = [];
  let heading = path;
  let lines: Array<string> = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text !== "") sections.push({ path, heading, text });
  };
  for (const line of content.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (match) {
      flush();
      heading = match[1]!;
      lines = [line];
    } else {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

const STOP_WORDS = new Set(
  "a an and are as at be but by can do for from has have how i in is it its me my of on or our so that the this to was we what when where which who why will with you your please make add use".split(
    " ",
  ),
);

function terms(text: string): ReadonlyArray<string> {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((term) => term.length > 2 && !STOP_WORDS.has(term));
}

/** Term overlap weighted by rarity across sections, with a boost for heading matches. */
export function rankSections(
  sections: ReadonlyArray<VaultSection>,
  query: string,
): ReadonlyArray<{ readonly section: VaultSection; readonly score: number }> {
  const queryTerms = new Set(terms(query));
  if (queryTerms.size === 0) return [];
  const sectionTerms = sections.map((section) => new Set(terms(section.text)));
  const documentFrequency = new Map<string, number>();
  for (const set of sectionTerms) {
    for (const term of queryTerms) {
      if (set.has(term)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  return sections
    .map((section, index) => {
      let score = 0;
      const heading = section.heading.toLowerCase();
      for (const term of queryTerms) {
        if (!sectionTerms[index]!.has(term)) continue;
        score += Math.log(1 + sections.length / (documentFrequency.get(term) ?? 1));
        if (heading.includes(term)) score += 1;
      }
      return { section, score };
    })
    .filter((ranked) => ranked.score > 0)
    .toSorted((left, right) => right.score - left.score);
}

/** Template files a vault starts with carry no knowledge yet. */
function isTemplateOnly(section: VaultSection): boolean {
  return DEFAULT_VAULT_FILES.some(([path, content]) => {
    if (path !== section.path) return false;
    return content.includes(section.text);
  });
}

const FULL_VAULT_REQUEST =
  /\b(?:read|load|use|review)\b[^.\n]{0,40}\b(?:whole|entire|full|complete|all of the)\b[^.\n]{0,20}\b(?:memory|vault)/i;

export function asksForWholeVault(userText: string): boolean {
  return FULL_VAULT_REQUEST.test(userText);
}

const WRITE_GUIDANCE: Record<MemoryVaultDetailLevel, string> = {
  concise: "Record only decisions, fixed bugs, and finished features, one or two lines each.",
  standard:
    "Record architecture and technical decisions, finished and remaining tasks, significant bugs with their fixes, and the user's stated preferences. Keep entries short and update existing entries instead of repeating them.",
  detailed:
    "Record architecture, decisions with their reasons, task progress, bugs and fixes, dependencies and configuration, and user preferences. Include file paths and commands a future agent would need. Update existing entries instead of repeating them.",
};

/** The block of vault context that precedes the user's message for one turn. */
export function renderVaultContext(input: {
  readonly vaultName: string;
  readonly access: MemoryVaultAccess;
  readonly autoUpdate: boolean;
  readonly detailLevel: MemoryVaultDetailLevel;
  readonly files: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<VaultSection>;
  readonly omittedSections: number;
}): string {
  const lines = [
    `Project memory vault "${input.vaultName}" (selected by the user; it is separate from the current workspace and may describe a different project).`,
    `Files: ${input.files.join(", ") || "none yet"}.`,
  ];
  if (input.sections.length > 0) {
    lines.push("Relevant notes:");
    for (const section of input.sections)
      lines.push(`--- ${section.path} › ${section.heading}\n${section.text}`);
  } else {
    lines.push("No notes match this request.");
  }
  if (input.omittedSections > 0) {
    lines.push(
      `${input.omittedSections} more sections were left out. Use continuum_memory_search or continuum_memory_read when you need them.`,
    );
  }
  if (input.access === "read-write" && input.autoUpdate) {
    lines.push(
      `Keep this vault current with continuum_memory_update after meaningful progress (a finished feature, a fixed bug, a decision). ${WRITE_GUIDANCE[input.detailLevel]} Never record credentials or secrets. Do not write vault notes into the workspace.`,
    );
  } else if (input.access !== "read-write") {
    lines.push("The vault is read-only for this thread; do not try to update it.");
  }
  return lines.join("\n");
}

/** Picks sections for a turn: the best matches first, within the character budget. */
export function selectVaultSections(input: {
  readonly sections: ReadonlyArray<VaultSection>;
  readonly userText: string;
  readonly budgetChars: number;
  readonly full: boolean;
}): { readonly sections: ReadonlyArray<VaultSection>; readonly omitted: number } {
  const useful = input.sections.filter((section) => !isTemplateOnly(section));
  const ordered = input.full
    ? useful
    : (() => {
        const ranked = rankSections(useful, input.userText).map((entry) => entry.section);
        // The project overview orients an agent even when nothing else matches.
        const overview = useful.find((section) => section.path === "PROJECT.md");
        return overview && !ranked.includes(overview) ? [overview, ...ranked] : ranked;
      })();
  const selected: Array<VaultSection> = [];
  let used = 0;
  for (const section of ordered) {
    const text =
      section.text.length > input.budgetChars / 2
        ? `${section.text.slice(0, Math.floor(input.budgetChars / 2))}\n[section truncated]`
        : section.text;
    if (used + text.length > input.budgetChars) continue;
    selected.push({ ...section, text });
    used += text.length;
  }
  return { sections: selected, omitted: useful.length - selected.length };
}
