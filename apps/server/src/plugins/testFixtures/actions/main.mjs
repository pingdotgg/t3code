// Action handlers for PluginActions.test.ts and the lane's live proof.
export function activate(context) {
  const handle = context.proposed.handle;
  handle("action:echo-target", ({ target }) => ({
    message: `${target.kind} ${target.threadId} in ${target.cwd}`,
  }));
  handle("action:say-hello", () => ({ message: `Hello from ${context.plugin.id}` }));
  handle("action:fail", () => {
    throw new Error("The fixture failed on purpose.");
  });
  handle(
    "action:wait",
    (_input, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled")));
      }),
  );
}
