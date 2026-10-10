// A views plugin: the `board` view calls the `view:board:*` handlers below.
export function activate(context) {
  context.proposed.handle("ping", () => "not reachable from views");
  context.proposed.handle("view:board:echo", (input) => ({ echo: input }));
  context.proposed.handle("view:board:big", () => "x".repeat(70 * 1024));
  context.proposed.handle(
    "view:board:hang",
    (_input, { signal }) =>
      new Promise((resolve) => signal.addEventListener("abort", () => resolve(null))),
  );
}
