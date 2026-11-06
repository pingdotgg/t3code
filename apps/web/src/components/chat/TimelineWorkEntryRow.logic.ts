import type { PluggableList } from "unified";
import type { Root, RootContent } from "mdast";
import {
  resolveWorkEntryToolPresentation,
  toolGroupAction,
} from "@t3tools/client-runtime/work-log/presentation";
import { isJavaScriptReplTool } from "@t3tools/shared/toolActivity";
import { formatWorkspaceRelativePath } from "../../filePathDisplay";
import { type TimelineWorkEntry, type TimelineRow } from "./timelineRowContext";
import { type WorkEntryIconName } from "./TimelineToolActivityIcon";

export function toolGroupSummaryIconName(
  kind: Extract<TimelineRow, { kind: "work-toggle" }>["summaryKind"],
): WorkEntryIconName {
  switch (kind) {
    case "pull-request":
    case "link-pr":
    case "unlink-pr":
    case "list-prs":
    case "watch-pr":
    case "unwatch-pr":
      return "pull-request";
    case "read":
      return "eye";
    case "edit":
      return "square-pen";
    case "command":
      return "terminal";
    case "thread-create":
      return "t3-code";
    case "browser":
      return "browser";
    case "device":
      return "device";
    case "search":
      return "globe";
    case "code-search":
      return "search";
    case "other":
      return "wrench";
    case "dynamic-tool":
      return "hammer";
    case "reasoning":
      return "brain";
    case "agent-tool":
      return "bot";
    case "tone-tool":
      return "zap";
    case "update":
    case "mixed":
      return "hammer";
  }
}

export function workToneIcon(tone: TimelineWorkEntry["tone"]): {
  iconName: WorkEntryIconName;
  className: string;
} {
  if (tone === "error") {
    return {
      iconName: "circle-alert",
      className: "text-foreground/92",
    };
  }
  if (tone === "thinking") {
    return {
      iconName: "brain",
      className: "text-icon-muted",
    };
  }
  if (tone === "info") {
    return {
      iconName: "check",
      className: "text-muted-foreground",
    };
  }
  return {
    iconName: "zap",
    className: "text-foreground/92",
  };
}

export function workEntryRawCommand(
  workEntry: Pick<TimelineWorkEntry, "command" | "rawCommand">,
): string | null {
  const rawCommand = workEntry.rawCommand?.trim();
  if (!rawCommand || !workEntry.command) {
    return null;
  }
  return rawCommand === workEntry.command.trim() ? null : rawCommand;
}

export function buildToolCallExpandedBody(
  workEntry: TimelineWorkEntry,
  workspaceRoot: string | undefined,
  visibleLabel: string,
  viewedImagePath: string | null,
): string | null {
  const blocks: string[] = [];
  const seen = new Set<string>([visibleLabel.trim()]);
  const addBlock = (value: string | null | undefined) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    blocks.push(text);
  };
  if (workEntry.itemType === "dynamic_tool" && workEntry.toolData !== undefined) {
    const input =
      workEntry.structuredPayload?.type === "dynamic_tool"
        ? workEntry.structuredPayload.input
        : workEntry.toolData !== null &&
            typeof workEntry.toolData === "object" &&
            "input" in workEntry.toolData
          ? workEntry.toolData.input
          : undefined;
    if (input !== undefined) addBlock(`Tool input\n${JSON.stringify(input, null, 2)}`);
  }
  const command = workEntry.command?.trim();
  const raw = workEntryRawCommand(workEntry);
  if (command === visibleLabel.trim()) {
    seen.add(command);
  } else {
    addBlock(raw ?? command);
  }
  const detail = workEntry.detail?.trim();
  if (detail !== viewedImagePath?.trim()) {
    addBlock(detail);
  }
  const viewedImagePaths = new Set(
    viewedImagePath
      ? [viewedImagePath.trim(), formatWorkspaceRelativePath(viewedImagePath, workspaceRoot)]
      : [],
  );
  const changedFiles = (workEntry.changedFiles ?? []).flatMap((filePath) => {
    const formattedPath = formatWorkspaceRelativePath(filePath, workspaceRoot);
    return viewedImagePaths.has(filePath) ||
      viewedImagePaths.has(formattedPath) ||
      filePath.trim() === detail ||
      formattedPath === detail
      ? []
      : [formattedPath];
  });
  if (changedFiles.length > 0) {
    addBlock([...new Set(changedFiles)].join("\n"));
  }
  return blocks.length > 0 ? blocks.join("\n\n") : null;
}

export function workEntryIconName(workEntry: TimelineWorkEntry): WorkEntryIconName {
  if (workEntry.structuredPayload?.type === "notification") {
    if (workEntry.structuredPayload.outcome === "failed") return "circle-alert";
    const source = workEntry.structuredPayload.source;
    switch (source.kind) {
      case "subagent":
      case "delegated_task":
        return "bot";
      case "command":
        return "terminal";
      case "monitor":
        return "eye";
      case "background_task":
        return "zap";
      case "system":
        return "t3-code";
      default:
        source satisfies never;
        return "zap";
    }
  }
  if (workEntry.itemType === "user_input_request" || workEntry.itemType === "approval_request") {
    return "message-circle";
  }
  if (workEntry.itemType === "todo_list") return "list-todo";
  if (workEntry.toolSurface) return workEntry.toolSurface;
  if (
    workEntry.structuredPayload?.type === "dynamic_tool" &&
    isJavaScriptReplTool(workEntry.structuredPayload.toolName)
  )
    return "code";
  const toolPresentation = resolveWorkEntryToolPresentation(workEntry);
  if (toolPresentation) return toolPresentation.icon;
  const action = toolGroupAction(workEntry);
  if (action !== "other") return toolGroupSummaryIconName(action);

  switch (workEntry.itemType) {
    case "dynamic_tool":
      return "wrench";
    case "subagent":
      return "bot";
  }

  return workToneIcon(workEntry.tone).iconName;
}

/** Compact reasoning keeps formulas while flattening other Markdown into label text. */
export function remarkThoughtPreview(fallback: string) {
  return (tree: Root) => {
    const children: RootContent[] = [];
    const append = (value: string) => {
      const last = children.at(-1);
      const text = value.replace(/\s+/g, " ");
      if (last?.type === "text") last.value = (last.value + text).replace(/\s+/g, " ");
      else children.push({ type: "text", value: text });
    };
    const visit = (node: Root | RootContent) => {
      if (node.type === "html" || node.type === "definition") return;
      if (node.type === "math" || node.type === "inlineMath") {
        children.push({
          type: "inlineMath",
          value: node.value,
          position: node.position,
          data: {
            hName: "code",
            hProperties: { className: ["language-math", "math-inline"] },
            hChildren: [{ type: "text", value: node.value }],
          },
        });
      } else if ("alt" in node) append(node.alt ?? "");
      else if ("value" in node) append(node.value);
      else if ("children" in node) {
        node.children.forEach((child, index) => {
          if (
            index &&
            ["root", "blockquote", "list", "listItem", "table", "tableRow"].includes(node.type)
          )
            append(" ");
          visit(child);
        });
      } else if (node.type === "break") append(" ");
    };
    visit(tree);
    const first = children[0];
    const last = children.at(-1);
    if (first?.type === "text") first.value = first.value.trimStart();
    if (last?.type === "text") last.value = last.value.trimEnd();
    tree.children = children.some((child) => child.type !== "text" || child.value)
      ? children
      : [{ type: "text", value: fallback }];
  };
}

export const THOUGHT_PREVIEW_PLUGINS: PluggableList = [[remarkThoughtPreview, "Thought"]];
export const THINKING_PREVIEW_PLUGINS: PluggableList = [[remarkThoughtPreview, "Thinking"]];
