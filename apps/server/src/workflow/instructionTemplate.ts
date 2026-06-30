/**
 * Ticket-context placeholders usable inside agent step instructions.
 *
 * Only `{{ticket.<field>}}` tokens participate in templating; any other
 * `{{...}}` text is left untouched so instructions can freely contain
 * handlebars-style examples. Unknown `ticket.*` fields are left literal at
 * runtime and surfaced as lint errors at save time.
 */
export const TICKET_TEMPLATE_FIELDS = [
  "title",
  "description",
  "id",
  "baseRef",
  "discussion",
] as const;
export type TicketTemplateField = (typeof TICKET_TEMPLATE_FIELDS)[number];

export type TicketTemplateVars = Readonly<Record<TicketTemplateField, string>>;

const PLACEHOLDER_PATTERN = /\{\{\s*ticket\.([A-Za-z0-9_.]+)\s*\}\}/g;

const isTemplateField = (field: string): field is TicketTemplateField =>
  (TICKET_TEMPLATE_FIELDS as ReadonlyArray<string>).includes(field);

export const applyInstructionTemplate = (instruction: string, vars: TicketTemplateVars): string =>
  instruction.replace(PLACEHOLDER_PATTERN, (match, field: string) =>
    isTemplateField(field) ? vars[field] : match,
  );

/**
 * Like {@link applyInstructionTemplate} but leaves the placeholders of any
 * `exclude`d fields literal, and tolerates a partial `vars` map (a placeholder
 * whose value is `undefined` is left literal). Used to substitute the short
 * ticket fields while deferring `{{ticket.description}}` for a budget-aware
 * spill decision.
 */
export const applyInstructionTemplateExcept = (
  instruction: string,
  vars: Partial<TicketTemplateVars>,
  exclude: ReadonlyArray<TicketTemplateField>,
): string =>
  instruction.replace(PLACEHOLDER_PATTERN, (match, field: string) =>
    isTemplateField(field) && !exclude.includes(field) && vars[field] !== undefined
      ? vars[field]!
      : match,
  );

export interface DiscussionMessage {
  readonly author: "agent" | "user";
  readonly body: string;
  readonly createdAt: string;
  readonly attachmentCount: number;
}

export const DISCUSSION_MESSAGE_CAP = 30;
const DISCUSSION_CHAR_BUDGET = 12_000;
const DISCUSSION_TRUNCATION_NOTE = "_(earlier messages omitted)_";

const renderDiscussionMessage = (message: DiscussionMessage): string => {
  const author = message.author === "user" ? "User" : "Agent";
  const attachmentNote =
    message.attachmentCount > 0
      ? `\n[${message.attachmentCount} attachment${message.attachmentCount === 1 ? "" : "s"} omitted]`
      : "";
  return `### ${author} — ${message.createdAt}\n${message.body}${attachmentNote}`;
};

/**
 * Render a ticket's message thread as a markdown transcript for agent
 * instructions. Keeps the newest messages within a message count and
 * character budget; attachments are noted, never inlined (they are data
 * URLs). Returns the empty string when there is nothing to show.
 */
export const renderTicketDiscussion = (messages: ReadonlyArray<DiscussionMessage>): string => {
  if (messages.length === 0) {
    return "";
  }
  const kept: string[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const source = messages[index];
    const entry = source === undefined ? "" : renderDiscussionMessage(source);
    if (
      kept.length >= DISCUSSION_MESSAGE_CAP ||
      (kept.length > 0 && used + entry.length > DISCUSSION_CHAR_BUDGET)
    ) {
      kept.unshift(DISCUSSION_TRUNCATION_NOTE);
      break;
    }
    kept.unshift(entry);
    used += entry.length + 2;
  }
  return kept.join("\n\n");
};

export const hasDiscussionPlaceholder = (instruction: string): boolean =>
  /\{\{\s*ticket\.discussion\s*\}\}/.test(instruction);

// ---------------------------------------------------------------------------
// Inter-agent handoff placeholders: {{prev.output}} / {{step.<key>.output}}
// ---------------------------------------------------------------------------

/** Marker substituted for a forward handoff reference with nothing captured yet. */
export const NO_PRIOR_OUTPUT_NOTE = "(no prior output yet)";

// The global schema cap on a single turn's input chars (`provider.ts:69-71`).
const PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000;
// Reserve room on the FINAL assembled instruction for the capture-output suffix
// the executor may append (only for capture steps), so an inlined body never
// blows the provider input cap. This is a per-render reserve, not a per-output cap.
const CAPTURE_OUTPUT_SUFFIX_RESERVE = 512;

/**
 * The active provider's per-turn input budget: the adapter's declared
 * `maxInputChars` clamped to the global 120k schema cap, or the cap itself when
 * the adapter declares no tighter limit.
 */
export const providerInputBudget = (maxInputChars: number | undefined): number =>
  Math.min(maxInputChars ?? PROVIDER_SEND_TURN_MAX_INPUT_CHARS, PROVIDER_SEND_TURN_MAX_INPUT_CHARS);

/**
 * Room for the instruction BODY (template text + inlined description + inlined
 * handoff), reserving the EXACT trailing blocks appended after the body: the
 * discussion block and (only for capture steps) the capture suffix. Floored at 0
 * so the math never underflows on a tight provider.
 */
export const instructionBodyBudget = (
  providerBudget: number,
  appendedDiscussionBlockLength: number,
  capturesOutput: boolean,
): number =>
  Math.max(
    0,
    providerBudget -
      appendedDiscussionBlockLength -
      (capturesOutput ? CAPTURE_OUTPUT_SUFFIX_RESERVE : 0),
  );

// `{{prev.output}}` or `{{step.<key>.output}}`. The step key allows the full
// trimmed-non-empty step-key alphabet (keys are NOT restricted to path-safe).
const HANDOFF_PLACEHOLDER_PATTERN = /\{\{\s*(?:prev\.output|step\.([^.{}]+?)\.output)\s*\}\}/g;

export interface HandoffReference {
  /** The exact placeholder text to replace, e.g. `{{ step.review.output }}`. */
  readonly raw: string;
  readonly kind: "prev" | "step";
  /** Present only for `step.<key>.output` references. */
  readonly stepKey: string | undefined;
}

/** Parse all `{{prev.output}}` / `{{step.<key>.output}}` placeholders in order. */
export const findHandoffReferences = (instruction: string): ReadonlyArray<HandoffReference> => {
  const refs: HandoffReference[] = [];
  for (const match of instruction.matchAll(HANDOFF_PLACEHOLDER_PATTERN)) {
    const stepKey = match[1];
    refs.push(
      stepKey === undefined
        ? { raw: match[0], kind: "prev", stepKey: undefined }
        : { raw: match[0], kind: "step", stepKey },
    );
  }
  return refs;
};

const PATH_SAFE_STEP_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * A filename-safe form of a step key for the spill path. Path-safe keys pass
 * through unchanged; anything else is base64url-encoded (deterministic,
 * collision-free, and matching `[A-Za-z0-9_-]+`) so it never smuggles path
 * segments into the scratch tree.
 */
export const safeStepKey = (stepKey: string): string =>
  PATH_SAFE_STEP_KEY.test(stepKey) ? stepKey : Buffer.from(stepKey, "utf8").toString("base64url");

/** Render a handoff output value as text for inlining or spilling. */
export const stringifyHandoffOutput = (output: unknown): string =>
  typeof output === "string" ? output : JSON.stringify(output);

const PATH_SAFE_TICKET_ID = /^[A-Za-z0-9_-]+$/;

/**
 * The worktree-relative per-ticket scratch directory `.t3/ticket/<id>` that
 * holds all pipeline scratch (description spill, handoff outputs, design docs).
 * Validates the ticket id against a path-safe pattern so it can never smuggle
 * path segments into the scratch tree.
 */
export const ticketScratchDir = (ticketId: string): string => {
  if (!PATH_SAFE_TICKET_ID.test(ticketId)) {
    throw new Error(`unsafe ticket id for scratch path: ${ticketId}`);
  }
  return `.t3/ticket/${ticketId}`;
};

/** The worktree-relative scratch path a spilled handoff output is written to. */
export const handoffSpillPath = (ticketId: string, stepKey: string): string =>
  `${ticketScratchDir(ticketId)}/handoff/${safeStepKey(stepKey)}.md`;

/** The placeholder replacement pointing an agent at a spilled handoff file. */
export const handoffSpillReference = (spillPath: string): string =>
  `the prior step's full output is in \`${spillPath}\` — read that file`;

/** The worktree-relative scratch path a spilled ticket description is written to. */
export const descriptionSpillPath = (ticketId: string): string =>
  `${ticketScratchDir(ticketId)}/DESCRIPTION.md`;

/** The placeholder replacement pointing an agent at a spilled description file. */
export const descriptionSpillReference = (spillPath: string): string =>
  `The full ticket description is in \`${spillPath}\` — read that file before starting.`;

export const unknownTicketPlaceholders = (instruction: string): ReadonlyArray<string> => {
  const unknown = new Set<string>();
  for (const match of instruction.matchAll(PLACEHOLDER_PATTERN)) {
    const field = match[1];
    if (field !== undefined && !isTemplateField(field)) {
      unknown.add(field);
    }
  }
  return [...unknown];
};
