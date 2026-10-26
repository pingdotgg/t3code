import * as Base64Url from "effect/encoding/Base64Url";
import { CheckpointRef, type ThreadId } from "@t3tools/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/turn/${turnCount}`,
  );
}
