import type { ProviderDriverKind } from "@t3tools/contracts";
import { T, Var } from "gt-react";
import { Fragment } from "react";

/** What turning on usage access lets T3 Code read for this agent. Keep in step with its usage reader. */
export function UsageAccessReads({
  driver,
  paths = [],
}: {
  readonly driver: ProviderDriverKind;
  readonly paths?: readonly string[];
}) {
  if (paths.length === 0 || driver === "cursor") {
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
  const location = paths.map((path, index) => (
    <Fragment key={path}>
      {index > 0 ? ", " : null}
      <code className="font-mono break-all">{path}</code>
    </Fragment>
  ));
  switch (driver) {
    case "claudeAgent":
      return (
        <T>
          Reads its session history at <Var>{location}</Var>, and its sign-in to match limits to
          your account and ask Anthropic for your reset credits.
        </T>
      );
    case "grok":
      return (
        <T>
          Reads its session history at <Var>{location}</Var>, and its sign-in to ask xAI for your
          credits.
        </T>
      );
    case "opencode":
      return (
        <T>
          Reads its usage database at <Var>{location}</Var>, and its Go key to ask OpenCode for your
          Go limits.
        </T>
      );
    case "antigravity":
      return (
        <T>
          Reads its conversation history at <Var>{location}</Var>.
        </T>
      );
    default:
      return (
        <T>
          Reads its session history at <Var>{location}</Var>.
        </T>
      );
  }
}
