// A tool plugin for PluginTools.test.ts. Its tools are declared in
// t3-plugin.json; activate only registers their handlers.
export function activate(context) {
  const { handle } = context.proposed;
  context.log.info("activated");
  handle("t3.tool.word_count", ({ input }) => ({
    words: input.text.split(/\s+/).filter(Boolean).length,
  }));
  handle("t3.tool.echo_context", (call) => call);
  handle(
    "t3.tool.wait_for_cancel",
    (_call, { signal }) =>
      new Promise((_resolve, reject) => {
        context.log.info("wait-started");
        signal.addEventListener("abort", () => reject(new Error("cancelled")));
      }),
  );
  handle("t3.tool.big_result", ({ input }) => "x".repeat(input.length));
}
