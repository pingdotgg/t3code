import * as Layer from "effect/Layer";

import * as HandoffImport from "./HandoffImport.ts";
import * as ThreadHandoff from "./ThreadHandoff.ts";

/** For toolkit tests that never move a thread: the services its tools declare. */
export const layerUnused = Layer.merge(
  Layer.mock(ThreadHandoff.ThreadHandoff)({}),
  Layer.mock(HandoffImport.HandoffImport)({}),
);
