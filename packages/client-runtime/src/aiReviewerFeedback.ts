import { isBotBadgeImage } from "./botBadgeImages.ts";

export type AiReviewerFeedback = {
  readonly severity: string | null;
  readonly category: string | null;
  readonly summary: string;
  readonly agentPrompt: string | null;
  readonly suggestion: string | null;
};

type DetailsBlock = {
  readonly summary: string;
  readonly content: string;
  readonly start: number;
  readonly end: number;
};

const DETAILS_OPEN = /<details\b[^>]*>/giu;
const DETAILS_CLOSE = /<\/details\s*>/giu;
const SUMMARY_TAG = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/iu;
const HTML_COMMENT = /<!--[\s\S]*?-->/gu;
const FENCE = /^```(?:\w+)?\r?\n([\s\S]*?)^```\s*$/mu;
const SUGGESTION_FENCE = /^```suggestion\r?\n([\s\S]*?)^```/mu;
const BADGE_IMAGE_LINE =
  /^\s*(?:!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)|<img\b[^>]*\bsrc=["'](https?:\/\/[^"']+)["'][^>]*>)\s*$/imu;
const CODERABBIT_HEADER = /^[ \t]*_(?:[^_\n|]+?)_\s*\|\s*_(?:[^_\n]+?)_[ \t]*$/mu;
const MACROSCOPE_SEVERITY = /^[ \t]*[🟢🟡🟠🔴⚪]\s*\*\*(Low|Medium|High|Critical)\*\*[ \t]*$/mu;
const BUGBOT_SEVERITY = /^[ \t]*\*\*(Critical|High|Medium|Low)\s+Severity\*\*[ \t]*$/mu;
const DEVIN_TITLE = /^[ \t]*([🟢🟡🟠🔴⚪🔵])\s*\*\*(.+?)\*\*[ \t]*$/mu;
const GEMINI_SEVERITY_LINE =
  /^[ \t]*(?:\*\*)?\[severity:\s*(critical|high|medium|low)\](?:\*\*)?(?:\s+(.+))?$/imu;
const GEMINI_BADGE_LINE =
  /^[ \t]*!\[(critical|high|medium|low|high-priority)\]\((https?:\/\/[^)\s]*gstatic\.com\/codereviewagent\/[^)\s]+)\)[ \t]*$/imu;
const AGENT_PROMPT_SUMMARY = /prompt\s+for\s+ai/iu;
const COMMITTABLE_SUMMARY = /committable\s+suggestion/iu;
const SUGGESTION_SUMMARY =
  /proposed\s+fix|suggested\s+(?:fix|tweak|diff|cleanup|change|direction|assertion)|example\s+formatting/iu;
const ADDRESSED_FOOTER = /^[ \t]*✅\s*Addressed\b.*$/gmu;
const GREPTILE_CONTEXT = /\*\*Context Used:\*\*/u;
const GREPTILE_REMEMBER =
  /<sub>\s*Note:\s*If this suggestion doesn't match your team's coding style[\s\S]*?<\/sub>/iu;
const BUGBOT_FIX_CHROME =
  /<p>\s*<a\b[^>]*href=["']https?:\/\/(?:www\.)?cursor\.com\/[^"']*["'][\s\S]*?<\/p>/giu;
const DEVIN_BADGE_CHROME =
  /<!--\s*devin-review-badge-begin\s*-->[\s\S]*?<!--\s*devin-review-badge-end\s*-->/giu;
const PICTURE_OR_ANCHOR_CHROME = /<(?:picture|a)\b[\s\S]*?<\/(?:picture|a)\s*>/giu;
const SEVERITY_FROM_EMOJI: Record<string, string> = {
  "🟢": "Low",
  "🟡": "Medium",
  "🟠": "High",
  "🔴": "Critical",
  "⚪": "Info",
  "🔵": "Info",
};

const AI_REVIEWER_MARKER =
  /coderabbit|devin-review-comment|devin-review-badge|fingerprinting:phantom|macroscope|BUGBOT_BUG_ID|DESCRIPTION START|LOCATIONS START|cursor\.com\/(?:open|assets\/images\/fix-in)|app\.greptile\.com|greptile-static-assets|gstatic\.com\/codereviewagent|gemini-code-assist|graphite\.dev\/|cubic\.dev\/buttons|qodo\.ai\/|agents-vade-review\.vercel\.sh|vercel-agent-view-suggestion|copilot-code-review\//iu;

function stripHtmlComments(text: string): string {
  return text.replace(HTML_COMMENT, "");
}

function unwrapFence(text: string): string {
  const trimmed = text.trim();
  const match = FENCE.exec(trimmed);
  return match?.[1]?.replace(/\s+$/u, "") ?? trimmed;
}

function plainSummary(raw: string): string {
  return stripHtmlComments(raw)
    .replace(/<\/?[^>]+>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function extractDetails(body: string): ReadonlyArray<DetailsBlock> {
  const blocks: DetailsBlock[] = [];
  let depth = 0;
  let blockStart = -1;
  let cursor = 0;
  const open = new RegExp(DETAILS_OPEN.source, "giu");
  const close = new RegExp(DETAILS_CLOSE.source, "giu");

  while (cursor < body.length) {
    open.lastIndex = cursor;
    close.lastIndex = cursor;
    const nextOpen = open.exec(body);
    const nextClose = close.exec(body);
    if (nextOpen === null && nextClose === null) break;

    const openAt = nextOpen?.index ?? Number.POSITIVE_INFINITY;
    const closeAt = nextClose?.index ?? Number.POSITIVE_INFINITY;
    if (openAt < closeAt && nextOpen) {
      if (depth === 0) blockStart = nextOpen.index;
      depth += 1;
      cursor = nextOpen.index + nextOpen[0].length;
      continue;
    }
    if (nextClose === null) break;
    if (depth === 0) {
      cursor = nextClose.index + nextClose[0].length;
      continue;
    }
    depth -= 1;
    cursor = nextClose.index + nextClose[0].length;
    if (depth !== 0 || blockStart < 0) continue;
    const full = body.slice(blockStart, cursor);
    const innerStart = full.search(/>/u) + 1;
    const inner = full.slice(innerStart, full.length - nextClose[0].length);
    const summaryMatch = SUMMARY_TAG.exec(inner);
    blocks.push({
      summary: plainSummary(summaryMatch?.[1] ?? "Details"),
      content: (summaryMatch
        ? inner.slice(summaryMatch.index + summaryMatch[0].length)
        : inner
      ).trim(),
      start: blockStart,
      end: cursor,
    });
    blockStart = -1;
  }
  return blocks;
}

function parseHeader(prologue: string): {
  severity: string | null;
  category: string | null;
  rest: string;
  title: string | null;
} {
  const lines = prologue.replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === "") index += 1;
  if (index >= lines.length) {
    return { severity: null, category: null, rest: prologue.trim(), title: null };
  }

  const first = lines[index]!.trim();
  const rabbit = /^_(.+?)_\s*\|\s*_(.+?)_$/u.exec(first);
  if (rabbit) {
    return {
      category: rabbit[1]!.replace(/^[^\p{L}\p{N}]+/u, "").trim() || rabbit[1]!.trim(),
      severity: rabbit[2]!.replace(/^[^\p{L}\p{N}]+/u, "").trim() || rabbit[2]!.trim(),
      rest: lines
        .slice(index + 1)
        .join("\n")
        .trim(),
      title: null,
    };
  }

  const macro = /^[🟢🟡🟠🔴⚪]\s*\*\*(Low|Medium|High|Critical)\*\*$/u.exec(first);
  if (macro) {
    return {
      severity: macro[1]!,
      category: null,
      rest: lines
        .slice(index + 1)
        .join("\n")
        .trim(),
      title: null,
    };
  }

  // Bugbot: ### Title, then **Medium Severity**
  const bugbotTitle = /^#{1,6}\s+(.+)$/u.exec(first);
  if (bugbotTitle) {
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor]!.trim() === "") cursor += 1;
    const severityLine = cursor < lines.length ? lines[cursor]!.trim() : "";
    const severity = BUGBOT_SEVERITY.exec(severityLine)?.[1] ?? null;
    if (severity !== null) {
      return {
        severity,
        category: null,
        title: bugbotTitle[1]!.trim(),
        rest: lines
          .slice(cursor + 1)
          .join("\n")
          .trim(),
      };
    }
  }

  // Devin-style: 🟡 **Finding title**
  const devin = DEVIN_TITLE.exec(first);
  if (devin) {
    return {
      severity: SEVERITY_FROM_EMOJI[devin[1]!] ?? null,
      category: null,
      title: devin[2]!.trim(),
      rest: lines
        .slice(index + 1)
        .join("\n")
        .trim(),
    };
  }

  // Gemini: **[severity: medium]** category: description  OR badge image line
  const gemini = GEMINI_SEVERITY_LINE.exec(first);
  if (gemini) {
    const severity = gemini[1]![0]!.toUpperCase() + gemini[1]!.slice(1).toLowerCase();
    const remainder = (gemini[2] ?? "").trim();
    return {
      severity,
      category: null,
      title: remainder === "" ? null : remainder,
      rest: lines
        .slice(index + 1)
        .join("\n")
        .trim(),
    };
  }
  const geminiBadge = GEMINI_BADGE_LINE.exec(first);
  if (geminiBadge) {
    const raw = geminiBadge[1]!.toLowerCase().replace(/-priority$/u, "");
    const severity = raw[0]!.toUpperCase() + raw.slice(1);
    return {
      severity,
      category: null,
      title: null,
      rest: lines
        .slice(index + 1)
        .join("\n")
        .trim(),
    };
  }

  // Greptile / others: lone **Title** on the first line
  const boldTitle = /^\*\*([^*]+)\*\*$/u.exec(first);
  if (boldTitle && lines.slice(index + 1).some((line) => line.trim() !== "")) {
    return {
      severity: null,
      category: null,
      title: boldTitle[1]!.trim(),
      rest: lines
        .slice(index + 1)
        .join("\n")
        .trim(),
    };
  }

  return { severity: null, category: null, rest: prologue.trim(), title: null };
}

function dropBadgeLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const match = BADGE_IMAGE_LINE.exec(line);
      if (match === null) return true;
      const href = match[1] ?? match[2];
      return href === undefined || !isBotBadgeImage(href);
    })
    .join("\n");
}

function stripReviewerChrome(text: string): string {
  return text
    .replace(DEVIN_BADGE_CHROME, "")
    .replace(BUGBOT_FIX_CHROME, "")
    .replace(GREPTILE_REMEMBER, "")
    .replace(GREPTILE_CONTEXT, "")
    .replace(/\(?(?:\[source\]\()?https?:\/\/(?:www\.)?app\.greptile\.com\/[^\s)]+\)?/giu, "")
    .replace(PICTURE_OR_ANCHOR_CHROME, "")
    .replace(/<\/?p\b[^>]*>/giu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function extractSuggestionFence(text: string): {
  readonly body: string;
  readonly suggestion: string | null;
} {
  const match = SUGGESTION_FENCE.exec(text);
  if (match === null) return { body: text, suggestion: null };
  const suggestion = `\`\`\`suggestion\n${match[1]!.replace(/\s+$/u, "")}\n\`\`\``;
  const body = `${text.slice(0, match.index)}${text.slice(match.index + match[0].length)}`.trim();
  return { body, suggestion };
}

function isAiReviewerSignal(
  body: string,
  details: ReadonlyArray<DetailsBlock>,
  header: {
    severity: string | null;
    category: string | null;
    title: string | null;
  },
): boolean {
  if (header.severity !== null || header.category !== null) return true;
  if (details.some((block) => AGENT_PROMPT_SUMMARY.test(block.summary))) return true;
  if (details.some((block) => COMMITTABLE_SUMMARY.test(block.summary))) return true;
  if (AI_REVIEWER_MARKER.test(body)) return true;
  if (CODERABBIT_HEADER.test(body) || MACROSCOPE_SEVERITY.test(body)) return true;
  if (
    BUGBOT_SEVERITY.test(body) ||
    GEMINI_SEVERITY_LINE.test(body) ||
    GEMINI_BADGE_LINE.test(body)
  ) {
    return true;
  }
  // Bold-title-only findings need a bot-specific marker so ordinary markdown stays plain.
  if (header.title !== null && (GREPTILE_CONTEXT.test(body) || AI_REVIEWER_MARKER.test(body))) {
    return true;
  }
  return false;
}

/**
 * Structured feedback from CodeRabbit, Macroscope, Bugbot, Devin, Greptile, Gemini, and similar
 * AI reviewers. Null for ordinary human comments so their bodies keep rendering as written.
 */
export function parseAiReviewerFeedback(body: string): AiReviewerFeedback | null {
  const normalized = body.replace(/\r\n?/gu, "\n");
  const details = extractDetails(normalized);
  const hasMarker =
    AI_REVIEWER_MARKER.test(normalized) ||
    CODERABBIT_HEADER.test(normalized) ||
    MACROSCOPE_SEVERITY.test(normalized) ||
    BUGBOT_SEVERITY.test(normalized) ||
    GEMINI_SEVERITY_LINE.test(normalized) ||
    GEMINI_BADGE_LINE.test(normalized);

  if (details.length === 0 && !hasMarker) return null;

  const firstDetailsStart = details[0]?.start ?? normalized.length;
  const prologue = stripReviewerChrome(
    stripHtmlComments(normalized.slice(0, firstDetailsStart)).replace(ADDRESSED_FOOTER, "").trim(),
  );
  const header = parseHeader(dropBadgeLines(prologue));
  if (!isAiReviewerSignal(normalized, details, header)) return null;

  const agentPromptBlock =
    details.find((block) => AGENT_PROMPT_SUMMARY.test(block.summary))?.content ?? null;
  const detailsSuggestion =
    details.find((block) => COMMITTABLE_SUMMARY.test(block.summary))?.content ??
    details.find((block) => SUGGESTION_SUMMARY.test(block.summary))?.content ??
    null;

  // Devin and Greptile often put ```suggestion after <details>, outside the prologue.
  const outsideDetails = details
    .reduceRight(
      (text, block) => `${text.slice(0, block.start)}${text.slice(block.end)}`,
      normalized,
    )
    .trim();
  const outsideSuggestion = extractSuggestionFence(
    stripReviewerChrome(stripHtmlComments(outsideDetails).replace(ADDRESSED_FOOTER, "")),
  );

  const cleanedRest = stripReviewerChrome(header.rest.replace(ADDRESSED_FOOTER, "").trim());
  const fenced = extractSuggestionFence(cleanedRest);
  const summaryParts = [
    header.title === null ? null : `**${header.title}**`,
    fenced.body === "" ? null : fenced.body,
  ].filter((part): part is string => part !== null && part.trim() !== "");
  let summary = summaryParts.join("\n\n").trim();

  if (summary === "" && agentPromptBlock !== null) {
    summary = unwrapFence(agentPromptBlock);
  }

  const suggestion = detailsSuggestion ?? fenced.suggestion ?? outsideSuggestion.suggestion;

  // Bugbot and similar ship the finding prose without a "Prompt for AI" block; treat that prose as
  // the Easy fix payload when no explicit agent prompt exists.
  const agentPrompt =
    agentPromptBlock === null
      ? /BUGBOT_BUG_ID|DESCRIPTION START/iu.test(normalized) && summary !== ""
        ? summary
        : null
      : unwrapFence(agentPromptBlock);

  if (summary === "" && agentPrompt === null && suggestion === null) return null;

  return {
    severity: header.severity,
    category: header.category,
    summary: summary === "" && agentPrompt !== null ? agentPrompt : summary,
    agentPrompt,
    suggestion:
      suggestion === null
        ? null
        : stripHtmlComments(suggestion)
            .replace(/^>\s*.*(IMPORTANT|Carefully review)[\s\S]*?(?=```|$)/imu, "")
            .trim(),
  };
}

/** One-line list label: severity and the finding title, for a collapsed row. */
export function aiReviewerOneLine(feedback: AiReviewerFeedback): string {
  const summary = feedback.summary.trim();
  const bold = /^\*\*(.+?)\*\*/u.exec(summary);
  let title = (bold?.[1] ?? summary.split(/\n+/u)[0] ?? "")
    .replace(/[*`]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (title.length > 140) title = `${title.slice(0, 137)}...`;
  const lead = feedback.severity ?? feedback.category;
  if (lead !== null && title !== "") return `${lead} · ${title}`;
  return lead ?? title;
}

/** Compact markdown for the PR panel: finding first, optional suggestion, no analysis chrome. */
export function aiReviewerDisplayBody(feedback: AiReviewerFeedback): string {
  const parts: string[] = [];
  if (feedback.category !== null || feedback.severity !== null) {
    const bits = [feedback.category, feedback.severity].filter((part) => part !== null);
    parts.push(`**${bits.join(" · ")}**`);
  }
  if (feedback.summary.trim() !== "") parts.push(feedback.summary.trim());
  if (feedback.suggestion !== null && feedback.suggestion.trim() !== "") {
    parts.push(
      `<details>\n<summary>Suggested change</summary>\n\n${feedback.suggestion.trim()}\n\n</details>`,
    );
  }
  return parts.join("\n\n");
}

/** Text handed to the agent for Easy fix; prompt preferred over the prose finding. */
export function aiReviewerFixText(feedback: AiReviewerFeedback): string {
  return (feedback.agentPrompt ?? feedback.summary).trim();
}

export function hasAiReviewerEasyFix(body: string): boolean {
  return parseAiReviewerFeedback(body)?.agentPrompt != null;
}
