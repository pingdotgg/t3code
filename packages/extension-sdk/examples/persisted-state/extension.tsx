import { defineExtension } from "@t3tools/extension-sdk/authoring";
import type { ClientHost } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { useState } from "react";
import {
  STATE_VERSION,
  persistedCounterSchema,
  readPersistedState,
  type PersistedCounterState,
} from "./state.ts";

const manifestId = "example.persisted-state";

/**
 * Restore is null-only by default and safe: a fresh view starts at 0, a
 * reopened view reads the shape stateSchema declared, and anything else is
 * rejected by the host before createView runs — the view never sees a save it
 * cannot interpret.
 */
function CounterView(props: { session: ViewSession }) {
  const { session } = props;
  const restored = readPersistedState(session.restoreState);
  const [count, setCount] = useState(restored?.count ?? 0);
  const increment = () => {
    const next: PersistedCounterState = { count: count + 1, label: "saved" };
    // save() throws with an actionable error if the value ever leaves the schema.
    session.save(next);
    setCount(next.count);
  };
  return (
    <section>
      <output aria-label="Count">{count}</output>
      <output aria-label="Restored">{restored === null ? "fresh" : "restored"}</output>
      <button type="button" onClick={increment}>
        Increment and save
      </button>
    </section>
  );
}

export default defineExtension({
  id: manifestId,
  version: "1.0.0",
  surfaces: [
    {
      name: "view",
      title: "Persisted counter",
      scope: "thread",
      stateVersion: STATE_VERSION,
      stateSchema: persistedCounterSchema,
      createView(_host: ClientHost, session: ViewSession) {
        return { renderer: () => <CounterView session={session} /> };
      },
    },
  ],
});
