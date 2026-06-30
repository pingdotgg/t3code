// The board-stream reducer now lives in client-runtime so the workflow atom
// factory (packages/client-runtime/src/state/workflow.ts) can fold the
// subscribeBoard stream with it. Re-exported here so existing web consumers
// keep importing from "../workflow/boardState".
export {
  type BoardState,
  emptyBoardState,
  applyBoardStreamItem,
} from "@t3tools/client-runtime/state/board-state";
