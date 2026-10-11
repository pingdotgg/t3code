import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import { cn } from "~/lib/utils";

import { PullRequestMarkdown } from "../PullRequestMarkdown";

/** Where the guide's prose renders from: the pull request's environment and checkout. */
export const GuideProseContext = createContext<{
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
} | null>(null);

/**
 * The guide's sentences, rendered as the pull request's own description is: inline code, and
 * `#123` linked to that pull request or issue, opening in the pull request panel like every other
 * pull request link in the app. Plain text inside a control, such as a question that opens a
 * thread, since a link cannot nest in a button.
 */
export function GuideProse({
  text,
  plain = false,
  className,
}: {
  text: string;
  plain?: boolean;
  className?: string;
}) {
  const context = useContext(GuideProseContext);
  if (plain || context === null) return text;
  return (
    <PullRequestMarkdown
      text={text}
      cwd={context.cwd}
      environmentId={context.environmentId}
      // The element around it sets size and colour; the description's spacing is for a page.
      className={cn("space-y-0 [&_.chat-markdown]:text-inherit", className)}
    />
  );
}
