import type { EnvironmentId, PullRequestDetailView, PullRequestRef } from "@t3tools/contracts";
import { createContext } from "react";

export const PullRequestAttachmentContext = createContext<{
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  provider: PullRequestDetailView["provider"] | undefined;
  cwd: string;
  url: string | undefined;
  capabilities: PullRequestDetailView["capabilities"]["attachments"];
  upload: (attachmentId: string, file: File) => Promise<string>;
} | null>(null);
