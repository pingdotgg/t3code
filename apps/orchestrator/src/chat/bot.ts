import { Chat } from "chat";
import { createLinearAdapter } from "@chat-adapter/linear";

import { createLocalChatStateAdapter } from "./state.ts";

export function createOrchestratorBot() {
  // Phase 1 keeps the bot shell local; the durable Convex-backed adapter lands in a later slice.
  const linearAdapter = createLinearAdapter();
  return new Chat({
    userName: process.env.LINEAR_BOT_USERNAME?.trim() || "linear-bot",
    adapters: {
      linear: linearAdapter as Omit<typeof linearAdapter, "botUserId">,
    },
    state: createLocalChatStateAdapter(),
  });
}
