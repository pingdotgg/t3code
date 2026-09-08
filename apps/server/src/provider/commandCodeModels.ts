/**
 * commandCodeModels — parse `command-code --list-models` output into the
 * snapshot's model list.
 *
 * Command Code owns its own model routing (plan catalog plus BYOK providers,
 * some of which are other vendors' models), so T3 never hardcodes a catalog:
 * whatever the local CLI can select is what the snapshot advertises.
 *
 * `--list-models` prints a human table:
 *
 * ```
 * Available models  ·  69 models
 *
 * Open Source
 *
 * deepseek/deepseek-v4-flash   fast hybrid-attention reasoning (default)
 * ...
 * ```
 *
 * @module provider/commandCodeModels
 */
import type { ServerProviderModel } from "@t3tools/contracts";

const ANSI_ESCAPE_REGEX = /\u001b\[[0-9;]*m/g;

/** Slug charset: letters, digits, and the separators real ids use (`/`, `:`, `.`, `-`, `_`, `+`). */
const MODEL_SLUG_REGEX = /^[A-Za-z0-9][A-Za-z0-9._:+@/-]*$/;

function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_REGEX, "");
}

/**
 * True for the plain category headers (`Open Source`, `Anthropic`, …) that
 * would otherwise be misread as a one-token slug row.
 */
function isCategoryHeader(slug: string, note: string | undefined): boolean {
  if (note !== undefined) return false;
  // Real slugs are lowercase or qualified (provider/model). Headers are
  // capitalized single words with no qualifier.
  return /^[A-Z]/.test(slug) && !slug.includes("/") && !slug.includes(":");
}

export function parseCommandCodeModelList(output: string): ReadonlyArray<ServerProviderModel> {
  const rows: Array<{ readonly slug: string; readonly note: string | undefined }> = [];
  const seen = new Set<string>();

  for (const rawLine of output.split(/\r?\n/)) {
    const line = stripAnsi(rawLine).trimEnd();
    if (line.length === 0 || /^available models/i.test(line)) {
      continue;
    }
    const match = line.match(/^(\S+)(?:\s{2,}(.*))?$/);
    if (!match) continue;
    const slug = match[1]!;
    const note = match[2]?.trim() || undefined;
    if (!MODEL_SLUG_REGEX.test(slug) || isCategoryHeader(slug, note) || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    rows.push({ slug, note });
  }

  const hasExplicitDefault = rows.some((row) => /\(default\)/i.test(row.note ?? ""));
  return rows.map((row, index) => {
    const isDefault =
      row.note !== undefined && /\(default\)/i.test(row.note)
        ? true
        : !hasExplicitDefault && index === 0;
    return {
      slug: row.slug,
      // Keep the slug as the display name: descriptions are free-form
      // capability prose, and the picker searches both fields anyway.
      name: row.slug,
      isCustom: false,
      ...(isDefault ? { isDefault: true } : {}),
    };
  });
}
