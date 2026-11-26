// Start off until the saved connection-traces preference loads.
let sending = false;
let changedSinceLoad = false;

export const connectionTracesEnabled = () => sending;
export function setConnectionTracesEnabled(enabled: boolean): void {
  changedSinceLoad = true;
  sending = enabled;
}

// Imported lazily so the persistence graph never runs ahead of the imports `index.ts` orders first.
void import("../../persistence/imperative")
  .then(({ loadPreferences }) => loadPreferences())
  .then((preferences) => {
    if (!changedSinceLoad) sending = preferences.connectionTracesEnabled === true;
  })
  .catch((error: unknown) => {
    console.warn("[tracing] could not read the connection traces setting", error);
  });
