// A context plugin for PluginContextEnrichment.test.ts and the lane's live proof. A marker in
// the user's text picks the answer; without one it adds a codename the provider can only learn
// from this context.
export function activate(context) {
  context.proposed.handle("t3.transform.enrich", (input, { signal }) => {
    const text = input.message.text;
    if (text.includes("[wait]"))
      return new Promise((_resolve, reject) => {
        context.log.info("wait-started");
        signal.addEventListener("abort", () => reject(new Error("cancelled")));
      });
    if (text.includes("[fail]")) throw new Error("the notes index is offline");
    if (text.includes("[none]")) return null;
    if (text.includes("[bad]")) return { context: "not a list" };
    if (text.includes("[big]")) return { context: [{ title: "Big", text: "x".repeat(20_000) }] };
    if (text.includes("[echo]"))
      return { context: [{ title: "Input", text: JSON.stringify(input) }] };
    return {
      context: [{ title: "Project codename", text: "The project codename is PERIWINKLE-42." }],
    };
  });
}
