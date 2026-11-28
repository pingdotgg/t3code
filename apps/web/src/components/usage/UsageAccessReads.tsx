import type { ProviderDriverKind } from "@t3tools/contracts";
import { T } from "gt-react";

/** What turning on usage access lets T3 Code read for this agent. Keep in step with its usage reader. */
export function UsageAccessReads({ driver }: { readonly driver: ProviderDriverKind }) {
  switch (driver) {
    case "claudeAgent":
      return (
        <T>
          Reads its session history, and its sign-in to match limits to your account and ask
          Anthropic for your reset credits.
        </T>
      );
    case "grok":
      return <T>Reads its session history, and its sign-in to ask xAI for your credits.</T>;
    case "opencode":
      return <T>Reads its usage database, and its Go key to ask OpenCode for your Go limits.</T>;
    case "antigravity":
      return <T>Reads its conversation history.</T>;
    case "cursor":
      return <T>Asks Cursor for your account's usage, using the API key you gave T3 Code.</T>;
    default:
      return <T>Reads its session history.</T>;
  }
}
