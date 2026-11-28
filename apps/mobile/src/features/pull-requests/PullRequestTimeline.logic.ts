import { splitsSurrogatePair } from "@t3tools/shared/assistantCitations";

export function collapsedTimelineCommentMarkdown(body: string) {
  return body.slice(0, splitsSurrogatePair(body, 1200) ? 1199 : 1200);
}
