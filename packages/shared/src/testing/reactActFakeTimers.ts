// Vitest's default vi.useFakeTimers() fakes every clock-ish global it can
// find, including setImmediate/clearImmediate. React's Scheduler uses the
// real Node setImmediate (there is no MessageChannel-based path outside a DOM
// environment) to flush work queued during a render or effect, so faking it
// makes any react-test-renderer act(async () => ...) call hang forever: the
// scheduled flush never fires because nothing ever advances the fake
// setImmediate queue. Pass this to vi.useFakeTimers() wherever a test also
// renders through react-test-renderer to keep setImmediate real while still
// faking setTimeout/setInterval/Date for the rest of the suite.
export const REACT_ACT_SAFE_FAKE_TIMER_METHODS = [
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "Date",
  "hrtime",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "requestIdleCallback",
  "cancelIdleCallback",
  "performance",
] as const;
