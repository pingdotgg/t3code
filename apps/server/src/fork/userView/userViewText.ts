import {
  type ChatAttachment,
  type OrchestrationV2TurnItem,
  THREAD_USER_VIEW_TOOL_NAME,
} from "@t3tools/contracts";
import { collectAssistantCitations } from "@t3tools/shared/assistantCitations";
import { isAttachmentOnlyBootstrapPrompt } from "@t3tools/shared/composerContextReferences";
import {
  type DisplayEvent,
  type DisplayMode,
  foldCores,
  type VisibleCore,
} from "@t3tools/shared/displayModes";
import * as DateTime from "effect/DateTime";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { composerContextTextForReader } from "./composerContextReader.ts";

/** Claude Code saves an MCP result over about 25k tokens to a file, as for t3_thread_read. */
export const USER_VIEW_MAX_BYTES = 30_000;

const INTRO =
  "The user's screen in this thread, word for word. Each message is a label line, then its lines indented two spaces. [user]: the user's messages. [guest Name]: a guest's messages. [agent]: the thread agent's send_to_user messages.";
const SHA_DIGITS = 16;

export type UserViewSelection =
  | {
      readonly view: "main";
      readonly main: number;
      readonly through?: string | undefined;
    }
  | {
      readonly view: "subThread";
      readonly subThread: string;
      readonly main: number;
      readonly through?: string | undefined;
    };

export type UserViewResult =
  /** `body` is the text that the view's sha256 covers; `withSha` gives the whole view. */
  | {
      readonly type: "text";
      readonly body: string;
      readonly withSha: (sha256: string) => string;
    }
  /** A selected message or the asked count lies before the rows read; read further back. */
  | { readonly type: "more" }
  | { readonly type: "refused"; readonly reason: string };

/** A shown row: the item and what it shows. */
export interface UserViewRow {
  readonly item: OrchestrationV2TurnItem;
  readonly event: DisplayEvent;
}

/** One message as the screen shows it: the time beside it, its body, and a guest's name. */
interface ShownMessage {
  readonly at: string;
  readonly body: string;
  readonly guest?: string | undefined;
}

/** The latest shown messages of a thread, folded. */
export interface UserViewTail {
  readonly mode: DisplayMode;
  readonly cores: ReadonlyArray<VisibleCore>;
  /** By core id. */
  readonly shown: ReadonlyMap<string, ShownMessage>;
  /** Whether the rows reach the start of the thread's history. */
  readonly complete: boolean;
}

export const selectionOf = (input: {
  readonly subThread?: string | undefined;
  readonly main?: number | undefined;
  readonly through?: string | undefined;
}): UserViewSelection =>
  input.subThread === undefined
    ? { view: "main", main: Math.max(1, input.main ?? 20), through: input.through }
    : {
        view: "subThread",
        subThread: input.subThread,
        main: input.main ?? 3,
        through: input.through,
      };

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");
const rowTime = (item: OrchestrationV2TurnItem) =>
  DateTime.formatIso(item.startedAt ?? item.updatedAt);

/** Each citation as `> ` lines and its comment, on lines of their own. */
function quotedCitations(text: string): string {
  let result = "";
  let cursor = 0;
  for (const { citation, start, end } of collectAssistantCitations(text)) {
    result += text.slice(cursor, start);
    if (result !== "" && !result.endsWith("\n")) result += "\n";
    result += [
      "> Assistant quote:",
      ...citation.text.split("\n").map((line) => `> ${line}`),
      // A comment's later lines stay indented under it, so none reads as typed text.
      ...(citation.comment === undefined
        ? []
        : citation.comment
            .split("\n")
            .map((line, index) => `${index === 0 ? "Comment: " : "  "}${line}`)),
    ].join("\n");
    // A blank line ends the block, so a comment's later lines do not run into the typed text.
    if (end < text.length)
      result += text.startsWith("\n\n", end) ? "" : text[end] === "\n" ? "\n" : "\n\n";
    cursor = end;
  }
  return result + text.slice(cursor);
}

function attachmentLine(attachment: ChatAttachment, attachmentsDir: string): string {
  const path = resolveAttachmentPath({ attachmentsDir, attachment });
  return `[${attachment.type}: ${attachment.name}${path === null ? "" : `, ${path}`}]`;
}

/** The text the screen shows for a user message, chips as readable text, then its attachments. */
function userBody(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }>,
  attachmentsDir: string,
): string {
  const shown =
    item.context?.guest?.text ?? (isAttachmentOnlyBootstrapPrompt(item.text) ? "" : item.text);
  const text = composerContextTextForReader({
    text: quotedCitations(shown),
    records: item.context?.records ?? [],
  });
  const attachments = (item.attachments ?? []).map((attachment) =>
    attachmentLine(attachment, attachmentsDir),
  );
  return [...(text === "" ? [] : [text]), ...attachments].join("\n");
}

/** Folds `rows`, oldest first, and reads each message's time and body from its row. */
export function userViewTail(input: {
  readonly mode: DisplayMode;
  readonly rows: ReadonlyArray<UserViewRow>;
  readonly complete: boolean;
  readonly attachmentsDir: string;
}): UserViewTail {
  const cores = foldCores(input.rows.map((row) => row.event));
  const items = new Map(
    input.rows.flatMap((row) => (row.event.type === "other" ? [] : [[row.event.id, row.item]])),
  );
  const shown = new Map<string, ShownMessage>();
  for (const core of cores) {
    const item = items.get(core.id);
    if (item === undefined) continue;
    // The web shows an edited message at the time its latest rewrite completed.
    const edit = core.editedBy === undefined ? undefined : items.get(core.editedBy);
    shown.set(core.id, {
      at:
        edit === undefined
          ? rowTime(item)
          : edit.completedAt === null
            ? rowTime(edit)
            : DateTime.formatIso(edit.completedAt),
      body: item.type === "user_message" ? userBody(item, input.attachmentsDir) : core.text,
      guest: item.type === "user_message" ? item.context?.guest?.name : undefined,
    });
  }
  return { mode: input.mode, cores, shown, complete: input.complete };
}

type NotShown = Exclude<UserViewResult, { readonly type: "text" }>;
const isCore = (value: VisibleCore | NotShown): value is VisibleCore => !("type" in value);
const refused = (reason: string): NotShown => ({ type: "refused", reason });

const guestLabel = (name: string | undefined) =>
  name === undefined ? "user" : `guest ${name.replace(/[[\]\r\n]/g, " ")}`;

const indent = (body: string) =>
  body
    .split("\n")
    .map((line) => (line === "" || line === "\r" ? line : `  ${line}`))
    .join("\n");

interface Block {
  readonly core: VisibleCore;
  readonly label: string;
  readonly body: string;
  readonly inSubThread: boolean;
}

const blockText = (block: Block) =>
  block.body === "" ? block.label : `${block.label}\n${indent(block.body)}`;

/**
 * The stretch of `tail` that `selection` names, as the user's screen shows it, at most
 * USER_VIEW_MAX_BYTES from its open tag on. Its last line is the call that shows it again.
 */
export function userViewText(input: {
  readonly threadId: string;
  readonly environmentId: string;
  readonly tail: UserViewTail;
  readonly selection: UserViewSelection;
  readonly expect?: string | undefined;
}): UserViewResult {
  const { tail, selection } = input;
  const { mode, cores, complete } = tail;
  const list = cores.filter((core) => !core.reply);

  /** Full ids win over short ids; a short id of two messages is refused. Null names none. */
  const lookup = (id: string): VisibleCore | NotShown | null => {
    const full = cores.find((core) => core.id === id);
    if (full !== undefined) return full;
    const named = cores.filter((core) => core.shortId === id);
    return named.length > 1
      ? refused(
          `"${id}" names ${named.length} messages: ${named.map((core) => core.id).join(", ")}. Pass one of these full ids.`,
        )
      : (named[0] ?? null);
  };
  const notLoaded = (id: string): NotShown =>
    complete ? refused(`no message "${id}" is on this thread's screen`) : { type: "more" };

  let stretch: ReadonlyArray<VisibleCore>;
  let root: VisibleCore | undefined;
  if (selection.view === "main") {
    const through =
      selection.through === undefined
        ? list.at(-1)
        : (lookup(selection.through) ?? notLoaded(selection.through));
    if (through === undefined)
      return complete ? refused("this thread shows the user no messages yet") : { type: "more" };
    if (!isCore(through)) return through;
    const end = list.indexOf(through);
    if (end === -1)
      return refused(
        `through "${selection.through}" is not in the main list; pass a sub-thread as subThread`,
      );
    const start = end + 1 - selection.main;
    // The message before the stretch names the Earlier call.
    if (start <= 0 && !complete) return { type: "more" };
    stretch = list.slice(Math.max(0, start), end + 1);
  } else {
    const named = lookup(selection.subThread) ?? notLoaded(selection.subThread);
    if (!isCore(named)) return named;
    const found = rootOf(cores, named, selection.subThread, complete);
    if (!isCore(found)) return found;
    root = found;
    const at = list.indexOf(found);
    if (at < selection.main && !complete) return { type: "more" };
    const replies = cores.filter((core) => core.reply && core.first === found.id);
    const whole = [...list.slice(Math.max(0, at - selection.main), at), found, ...replies];
    let end = whole.length - 1;
    if (selection.through !== undefined) {
      const through = lookup(selection.through);
      if (through !== null && !isCore(through)) return through;
      end = through === null ? -1 : whole.indexOf(through);
      if (end === -1)
        return refused(
          `through "${selection.through}" is not in this sub-thread or the ${selection.main} main-list messages before it`,
        );
    }
    stretch = whole.slice(0, end + 1);
  }

  const replyCounts = new Map<string, number>();
  if (selection.view === "main")
    for (const core of cores)
      if (core.reply && core.first !== null)
        replyCounts.set(core.first, (replyCounts.get(core.first) ?? 0) + 1);
  const label = (core: VisibleCore) => {
    const count = replyCounts.get(core.id) ?? 0;
    return `[${[
      core.from === "user"
        ? `${guestLabel(tail.shown.get(core.id)?.guest)} ${core.shortId}`
        : core.replyTo === undefined
          ? `agent ${core.shortId}`
          : `agent, answer to ${core.replyTo}`,
      tail.shown.get(core.id)?.at,
      ...(core.editedBy === undefined ? [] : ["edited"]),
      ...(count === 0 ? [] : [count === 1 ? "1 reply" : `${count} replies`]),
    ].join(", ")}]`;
  };
  const blocks: ReadonlyArray<Block> = stretch.map((core) => ({
    core,
    label: label(core),
    body: tail.shown.get(core.id)?.body ?? core.text,
    inSubThread: root !== undefined && core.reply,
  }));
  const hasReplies =
    root !== undefined && cores.some((core) => core.reply && core.first === root.id);

  const call = (through: string, expect?: string) =>
    `${THREAD_USER_VIEW_TOOL_NAME} ${JSON.stringify({
      environmentId: input.environmentId,
      threadId: input.threadId,
      ...(root === undefined ? {} : { subThread: root.id }),
      main: selection.main,
      through,
      ...(expect === undefined ? {} : { expect }),
    })}`;
  const pinnedThrough = stretch.at(-1)!.id;

  /** The view from block `start` on, with `lastBody` as the newest block's body when given. */
  const render = (start: number, sha: string, lastBody?: string) => {
    const shown = blocks
      .slice(start)
      .map((block, index, all) =>
        lastBody !== undefined && index === all.length - 1 ? { ...block, body: lastBody } : block,
      );
    const lines = [INTRO];
    const section = (header: string, items: ReadonlyArray<string>) => {
      lines.push("", header);
      for (const item of items) lines.push("", item);
    };
    const mainBlocks = shown.filter((block) => !block.inSubThread);
    const subBlocks = shown.filter((block) => block.inSubThread);
    if (mainBlocks.length > 0) section("Main list:", mainBlocks.map(blockText));
    if (
      root !== undefined &&
      (subBlocks.length > 0 || (!hasReplies && shown.some((block) => block.core === root)))
    )
      section(
        `Sub-thread under ${label(root)}:`,
        subBlocks.length > 0 ? subBlocks.map(blockText) : ["(no replies)"],
      );
    const inner = lines.join("\n");
    const oldest = shown[0]!.core;
    const earlier =
      selection.view === "main"
        ? list[list.indexOf(oldest) - 1]
        : start > 0
          ? stretch[start - 1]
          : undefined;
    const view = [
      `<t3-user-view thread="${input.threadId}" mode="${mode.label}" sha256="${sha}">`,
      inner,
      "</t3-user-view>",
      ...(earlier === undefined ? [] : [`Earlier: ${call(earlier.id)}`]),
      `Pinned: ${call(pinnedThrough, sha)}`,
    ].join("\n");
    return { inner, view };
  };
  const fits = (start: number, lastBody?: string) =>
    utf8Bytes(render(start, "0".repeat(SHA_DIGITS), lastBody).view) <= USER_VIEW_MAX_BYTES;

  let start = 0;
  let blockBytes = blocks.reduce((sum, block) => sum + utf8Bytes(blockText(block)), 0);
  while (start < blocks.length - 1 && blockBytes > USER_VIEW_MAX_BYTES)
    blockBytes -= utf8Bytes(blockText(blocks[start++]!));
  while (start < blocks.length - 1 && !fits(start)) start++;
  let lastBody: string | undefined;
  if (!fits(start)) {
    const characters = Array.from(blocks.at(-1)!.body);
    const cut = (kept: number) =>
      `${characters.slice(0, kept).join("")}…[cut: ${utf8Bytes(characters.slice(kept).join(""))} more bytes; t3_thread_read shows the whole message]`;
    let low = 0;
    let high = characters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (fits(start, cut(middle))) low = middle;
      else high = middle - 1;
    }
    lastBody = cut(low);
  }

  return {
    type: "text",
    body: render(start, "", lastBody).inner,
    withSha: (sha256) => {
      const sha = sha256.slice(0, SHA_DIGITS);
      const { view } = render(start, sha, lastBody);
      return input.expect === undefined || input.expect === sha
        ? view
        : `Changed since it was pinned: the pinned view had sha256 ${input.expect}; the text below is the thread's current view.\n${view}`;
    },
  };
}

/**
 * The first message of the sub-thread that `named` stands for: the first message of the sub-thread
 * it is a reply in, itself when it has replies or is the agent's, or for a main-list user message,
 * the answer to it that has replies, else its latest answer.
 */
function rootOf(
  cores: ReadonlyArray<VisibleCore>,
  named: VisibleCore,
  id: string,
  complete: boolean,
): VisibleCore | NotShown {
  const nowhere = refused(`message "${id}" shows nowhere on the user's screen`);
  if (named.reply) {
    if (named.first === null) return nowhere;
    const first = cores.find((core) => core.id === named.first);
    if (first === undefined) return complete ? nowhere : { type: "more" };
    return first.reply ? nowhere : first;
  }
  // Threads from before answers moved in place have replies under the user's own messages.
  if (named.from === "agent" || cores.some((core) => core.reply && core.first === named.id))
    return named;
  const answers = cores.filter(
    (core) => core.from === "agent" && !core.reply && core.replyTo === named.shortId,
  );
  return (
    answers.findLast((answer) => cores.some((core) => core.reply && core.first === answer.id)) ??
    answers.at(-1) ??
    refused(`message "${id}" has no answer in the main list, so it has no sub-thread`)
  );
}
