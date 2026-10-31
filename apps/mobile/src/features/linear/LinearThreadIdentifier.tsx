import { useAtomValue } from "@effect/atom-react";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { linearThreadIdentifierFamily } from "../../state/linear";
import { THREAD_LIST_V2_MONO_FONT } from "../threads/thread-list-v2-row-appearance";
import { linearThreadKey } from "./linearEnvironment";

/** The Linear issue a thread was launched from, muted and monospaced in thread-list rows. */
export function LinearThreadIdentifier(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly className?: string;
}) {
  const identifier = useAtomValue(
    linearThreadIdentifierFamily(linearThreadKey(props.environmentId, props.threadId)),
  );
  if (identifier === null) return null;
  return (
    <Text
      accessibilityLabel={`Linear issue ${identifier}`}
      className={cn("shrink-0 text-xs", props.className)}
      style={{ fontFamily: THREAD_LIST_V2_MONO_FONT }}
      numberOfLines={1}
    >
      {identifier}
    </Text>
  );
}
