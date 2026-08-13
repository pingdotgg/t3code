import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MessageId, SkillReadFileResult, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { skillEnvironment } from "~/state/skills";

export function useSkillFileQuery(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly skillName: string;
  readonly relativePath: string;
}): {
  readonly data: SkillReadFileResult | null;
  readonly error: string | null;
  readonly refresh: () => void;
} {
  const atom = skillEnvironment.readFile({
    environmentId: input.environmentId,
    input: {
      threadId: input.threadId,
      messageId: input.messageId,
      skillName: input.skillName,
      relativePath: input.relativePath,
    },
  });
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  const cause = result._tag === "Failure" ? Cause.squash(result.cause) : null;
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error:
      cause === null
        ? null
        : cause instanceof Error
          ? cause.message
          : "This skill file is no longer available.",
    refresh,
  };
}
