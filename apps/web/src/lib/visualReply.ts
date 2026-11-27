import * as Schema from "effect/Schema";

import { readLocalStorageValue, useLocalStorage } from "../hooks/useLocalStorage";

// One switch per device: it stays on across threads until the sender turns it off.
const STORAGE_KEY = "t3code:visual-reply:v1";

export const useVisualReply = () => useLocalStorage(STORAGE_KEY, false, Schema.Boolean);

export const readVisualReply = (): boolean =>
  readLocalStorageValue(STORAGE_KEY, false, Schema.Boolean);
