import type { EnvironmentId } from "@t3tools/contracts";
import { createContext, useContext } from "react";

import { cn } from "~/lib/utils";

import { PullRequestMarkdown, PullRequestMarkdownContext } from "../PullRequestMarkdown";

export const GuideProseContext = createContext<{
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
} | null>(null);

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
  const markdownContext = useContext(PullRequestMarkdownContext);
  if (plain || context === null) return text;
  return (
    // The agent writes the guide about the checkout, so its relative links name workspace files.
    <PullRequestMarkdownContext
      value={markdownContext === null ? null : { ...markdownContext, resolveUrl: null }}
    >
      <PullRequestMarkdown
        text={text}
        cwd={context.cwd}
        environmentId={context.environmentId}
        className={cn("space-y-0 [&_.chat-markdown]:text-inherit", className)}
      />
    </PullRequestMarkdownContext>
  );
}
