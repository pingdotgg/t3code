// Finishes activating only once deactivation has begun, then holds the
// process open, so a late Ready can race the server's disable.
export function activate(context) {
  context.proposed.handle("ping", (input) => ({ pid: process.pid, input }));
  context.log.info("activating");
  return new Promise((resolve) => context.signal.addEventListener("abort", () => resolve()));
}

export function deactivate() {
  return new Promise(() => {});
}
