import { msg, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { BookTextIcon } from "lucide-react";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { ConversationSummariesDialog } from "../conversationSummaries/ConversationSummariesDialog";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";

/** Opens this thread's conversation summaries; nothing is fetched until it is opened. */
export function ThreadConversationSummariesRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
}) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  if (config?.environment.capabilities.conversationSummaries !== true) return null;
  return (
    <>
      <ThreadDetailsControl onClick={() => setOpen(true)}>
        <BookTextIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <span className={`min-w-0 flex-1 truncate ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>
          {m(msg("Conversation summaries"))}
        </span>
      </ThreadDetailsControl>
      <ConversationSummariesDialog {...props} open={open} onOpenChange={setOpen} />
    </>
  );
}
