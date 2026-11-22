import * as Context from "../../Context.ts"
import { constFalse } from "../../Function.ts"

/** @internal */
export const RetriesDisabled = Context.Reference<boolean>("effect/chat/Chat/RetriesDisabled", {
  defaultValue: constFalse
})
