import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const EFFORTS = ["low", "medium", "high"] as const;
type AntigravityEffort = (typeof EFFORTS)[number];

interface DiscoveredVariant {
  readonly slug: string;
  readonly name: string;
  readonly baseName: string;
  readonly effort: AntigravityEffort | undefined;
}

function parseVariant(line: string): DiscoveredVariant | undefined {
  const [rawSlug, rawName] = line.split("\t", 2);
  const slug = rawSlug?.trim().replace(/^[-*]\s*/, "") ?? "";
  if (!slug || slug.endsWith(":")) return undefined;
  const name = rawName?.trim() || slug;
  const match = /^(.*?)\s+\((Low|Medium|High)\)$/i.exec(name);
  const effort = match?.[2]?.toLowerCase() as AntigravityEffort | undefined;
  return {
    slug,
    name,
    baseName: match?.[1]?.trim() || name,
    effort,
  };
}

function baseSlug(variants: ReadonlyArray<DiscoveredVariant>): string {
  const first = variants[0]!;
  if (variants.length < 2 || first.effort === undefined) return first.slug;
  const suffix = new RegExp(`-${first.effort}$`, "i");
  return first.slug.replace(suffix, "");
}

export function parseAntigravityModels(stdout: string): ReadonlyArray<ServerProviderModel> {
  const groups = new Map<string, Array<DiscoveredVariant>>();
  for (const line of stdout.split(/\r?\n/)) {
    const variant = parseVariant(line);
    if (variant === undefined) continue;
    const group = groups.get(variant.baseName) ?? [];
    if (!group.some((candidate) => candidate.slug === variant.slug)) group.push(variant);
    groups.set(variant.baseName, group);
  }

  return [...groups.values()].map((variants) => {
    const efforts = EFFORTS.filter((effort) =>
      variants.some((variant) => variant.effort === effort),
    );
    const capabilities =
      efforts.length > 1
        ? createModelCapabilities({
            optionDescriptors: [
              {
                id: "effort",
                type: "select",
                label: "Effort",
                currentValue: efforts.includes("medium") ? "medium" : efforts[0],
                options: efforts.map((effort) => ({
                  id: effort,
                  label: effort[0]!.toUpperCase() + effort.slice(1),
                  isDefault: effort === (efforts.includes("medium") ? "medium" : efforts[0]),
                })),
              },
            ],
          })
        : EMPTY_CAPABILITIES;
    return {
      slug: baseSlug(variants),
      name: variants.length > 1 ? variants[0]!.baseName : variants[0]!.name,
      isCustom: false,
      capabilities,
    };
  });
}

export function resolveAntigravityModel(selection: ModelSelection): string {
  const effort = getModelSelectionStringOptionValue(selection, "effort");
  if (!effort || !EFFORTS.includes(effort as AntigravityEffort)) {
    return /^gemini-3\.(?:5|6)-flash$/u.test(selection.model)
      ? `${selection.model}-medium`
      : selection.model;
  }
  return EFFORTS.some((candidate) => selection.model.endsWith(`-${candidate}`))
    ? selection.model
    : `${selection.model}-${effort}`;
}

export function buildAntigravityTurnArgs(input: {
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  readonly conversationId: string | undefined;
  readonly planMode: boolean;
  readonly addDirectories: ReadonlyArray<string>;
  readonly launchArgs: string;
}): ReadonlyArray<string> {
  return [
    "-p",
    input.prompt,
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--print-timeout",
    "24h",
    "--model",
    resolveAntigravityModel(input.modelSelection),
    ...(input.conversationId ? ["--conversation", input.conversationId] : ["--new-project"]),
    ...(input.planMode ? ["--mode", "plan"] : []),
    ...input.addDirectories.flatMap((directory) => ["--add-dir", directory]),
    ...tokenizeCliArgs(input.launchArgs),
  ];
}

const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  thinking_tokens: Schema.optional(Schema.Number),
  cache_read_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
});

const StepUpdate = Schema.Struct({
  conversation_id: Schema.optional(Schema.String),
  step_index: Schema.Number,
  state: Schema.String,
  step_type: Schema.String,
  text_delta: Schema.optional(Schema.String),
  tool_name: Schema.optional(Schema.String),
  tool_info: Schema.optional(
    Schema.Struct({
      name: Schema.optional(Schema.String),
      parameters: Schema.optional(Schema.Unknown),
      output: Schema.optional(Schema.String),
    }),
  ),
  subagent_info: Schema.optional(Schema.Unknown),
  usage: Schema.optional(Usage),
});

export const AntigravityStreamEvent = Schema.Union([
  Schema.Struct({
    event: Schema.Literal("init"),
    conversation_id: Schema.optional(Schema.String),
    init: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({ event: Schema.Literal("step_update"), step_update: StepUpdate }),
  Schema.Struct({
    event: Schema.Literal("result"),
    result: Schema.Struct({
      conversation_id: Schema.optional(Schema.String),
      status: Schema.optional(Schema.String),
      response: Schema.optional(Schema.String),
      error: Schema.optional(Schema.String),
      usage: Schema.optional(Usage),
    }),
  }),
]);
export type AntigravityStreamEvent = typeof AntigravityStreamEvent.Type;

const isStreamEvent = Schema.is(AntigravityStreamEvent);

export function decodeAntigravityLine(line: string): AntigravityStreamEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isStreamEvent(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function normalizeAntigravityConversationId(value: string | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function antigravityTerminalStatus(status: string | undefined) {
  switch (status?.toUpperCase()) {
    case "SUCCESS":
      return "completed" as const;
    case "CANCELLED":
    case "CANCELED":
      return "cancelled" as const;
    default:
      return "failed" as const;
  }
}
