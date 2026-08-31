import * as Schema from "effect/Schema";

import { useLocalStorage } from "./hooks/useLocalStorage";

const STORAGE_KEY = "t3code:chat-warning-dismissals:v3";
const ChatWarningDismissals = Schema.Struct({
  temporary: Schema.Array(Schema.String),
  permanent: Schema.Array(Schema.String),
});
const EMPTY_DISMISSALS = {
  temporary: [],
  permanent: [],
} satisfies typeof ChatWarningDismissals.Type;

export function useChatWarningDismissals() {
  return useLocalStorage(STORAGE_KEY, EMPTY_DISMISSALS, ChatWarningDismissals);
}
