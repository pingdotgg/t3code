import { sha256Hex } from "@t3tools/shared/sha256Hex";

export function chatGptWorkspaceScope(workspace: string) {
  return `openai:${sha256Hex(workspace)}`;
}
