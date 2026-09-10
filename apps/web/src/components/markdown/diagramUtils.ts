export type DiagramType = "mermaid" | "likec4";

export function isMermaidLanguage(language: string | undefined | null): boolean {
  if (!language) return false;
  return language.trim().toLowerCase() === "mermaid";
}

export function isLikeC4Language(language: string | undefined | null): boolean {
  if (!language) return false;
  const lang = language.trim().toLowerCase();
  return lang === "likec4" || lang === "like-c4" || lang === "c4";
}

export function isDiagramLanguage(language: string | undefined | null): boolean {
  return isMermaidLanguage(language) || isLikeC4Language(language);
}

export function getDiagramType(language: string | undefined | null): DiagramType | null {
  if (isMermaidLanguage(language)) return "mermaid";
  if (isLikeC4Language(language)) return "likec4";
  return null;
}

export function getDiagramDisplayName(language: string | undefined | null): string {
  if (isMermaidLanguage(language)) return "Mermaid Diagram";
  if (isLikeC4Language(language)) return "LikeC4 Diagram";
  return language || "Diagram";
}
