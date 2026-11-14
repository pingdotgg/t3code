import * as Schema from "effect/Schema";
import { useLocalStorage } from "~/hooks/useLocalStorage";
const citationDestinationSchema = Schema.Literals(["inline", "tray"]);
export function useCitationDestination() {
  return useLocalStorage("t3code:citation-destination", "inline", citationDestinationSchema);
}
