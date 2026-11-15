import {
  type ComposerContextRecord,
  type OrchestrationV2ConversationMessage,
  parseGoalCommand,
} from "@t3tools/contracts";
import { PSTACK_SKILL_PREFIX } from "@t3tools/pstack";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";

type ComposerMessage = Pick<
  OrchestrationV2ConversationMessage,
  "createdBy" | "notification" | "delegatedCompletion"
>;

const isUserAuthored = (message: ComposerMessage) =>
  message.createdBy === "user" &&
  message.notification === undefined &&
  message.delegatedCompletion === undefined;

function hasPstackComposerInvocation(
  input: { readonly text: string; readonly records: ReadonlyArray<ComposerContextRecord> },
  message: ComposerMessage,
): boolean {
  if (!isUserAuthored(message)) return false;
  if (
    input.records.some(
      (record) =>
        record.kind === "skill" && "name" in record && record.name.startsWith(PSTACK_SKILL_PREFIX),
    )
  )
    return true;
  if (/^\s*\/?pstack:[a-zA-Z0-9:_-]+(?=\s|$)/.test(input.text)) return true;
  for (const match of input.text.matchAll(SKILL_MENTION_PATTERN)) {
    if (match[2]?.startsWith(PSTACK_SKILL_PREFIX)) return true;
  }
  return false;
}

export function planPstackComposer(
  input: {
    readonly text: string;
    readonly records: ReadonlyArray<ComposerContextRecord>;
  },
  message: ComposerMessage,
) {
  if (!hasPstackComposerInvocation(input, message)) return undefined;
  const mentions = [...input.text.matchAll(SKILL_MENTION_PATTERN)]
    .filter((match) => match[2]?.startsWith(PSTACK_SKILL_PREFIX))
    .map((match) => ({
      name: match[2]!,
      start: match.index + (match[1]?.length ?? 0),
      end: match.index + match[0].length,
    }));
  const leading = /^(\s*)\/?(pstack:[a-zA-Z0-9:_-]+)(?=\s|$)/.exec(input.text);
  if (leading)
    mentions.unshift({
      name: leading[2]!,
      start: leading[1]!.length,
      end: leading[0].length,
    });
  const referenced = new Set(
    collectComposerContextReferences(input.text).map((ref) => ref.contextId),
  );
  const consumed = input.records.filter(
    (record) =>
      record.kind === "skill" &&
      "name" in record &&
      record.name.startsWith(PSTACK_SKILL_PREFIX) &&
      referenced.has(record.contextId),
  );
  const recordsById = new Map(
    consumed.flatMap((record) =>
      "name" in record ? [[record.contextId, record.name] as const] : [],
    ),
  );
  const skillNames = [
    ...new Set([...mentions.map((mention) => mention.name), ...recordsById.values()]),
  ];
  if (skillNames.length === 0) return undefined;
  return {
    skillNames,
    apply(names: ReadonlySet<string>, expansion: string) {
      let text = input.text;
      for (const mention of mentions.toReversed()) {
        const { name, start, end } = mention;
        if (!names.has(name)) continue;
        text = `${text.slice(0, start)}${name}${text.slice(end)}`;
      }
      const consumedIds = new Map([...recordsById].filter(([, name]) => names.has(name)));
      text = replaceComposerContextReferences(
        text,
        (ref) => consumedIds.get(ref.contextId) ?? text.slice(ref.start, ref.end),
      );
      return {
        text: `${text.trimEnd()}\n\n${expansion}`,
        records: input.records.filter((record) => !consumedIds.has(record.contextId)),
      };
    },
  };
}

/** An invocation, or a user naming pstack without one, for example "use pstack principles". */
export function referencesPstack(
  input: { readonly text: string; readonly records: ReadonlyArray<ComposerContextRecord> },
  message: ComposerMessage,
): boolean {
  return (
    hasPstackComposerInvocation(input, message) ||
    (isUserAuthored(message) &&
      /\bpstack\b/i.test(input.text) &&
      // A native goal's text becomes its objective, so it carries no locator.
      parseGoalCommand(input) === null)
  );
}
