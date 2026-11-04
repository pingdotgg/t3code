"use agent";
import { useModel } from "@flue/runtime";

// Model traffic goes through the Workers AI binding (`env.AI`), so the agent
// needs no provider API key.
export function Assistant() {
  useModel("cloudflare/@cf/moonshotai/kimi-k2.6");
  return "You are a terse assistant. Follow the user's formatting instructions exactly.";
}
