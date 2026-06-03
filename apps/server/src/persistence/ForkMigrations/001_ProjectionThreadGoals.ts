import * as Effect from "effect/Effect";

import { ensureGoalTable } from "../GoalTable.ts";

export default Effect.gen(function* () {
  yield* ensureGoalTable();
});
