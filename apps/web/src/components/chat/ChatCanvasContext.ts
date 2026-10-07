import { createContext, useContext } from "react";
import type { ChatCanvasDetailsCard, resolveChatCanvasLayout } from "./chatCanvasLayout";

export const ChatCanvasContext = createContext<{
  container: { width: number; height: number };
  lane: { padding: number; minChatWidth: number };
  layout: ReturnType<typeof resolveChatCanvasLayout>;
  registerTimeline: (element: HTMLElement | null) => void;
  reportDetailsCard: (card: ChatCanvasDetailsCard | null) => void;
} | null>(null);

export const useChatCanvas = () => useContext(ChatCanvasContext);
