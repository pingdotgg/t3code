import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export default {
  /** @param {import('../../../packages/extension-sdk/src/index.ts').ExtensionContext} context */
  async activate(context) {
    const notesPath = NodePath.join(context.storagePath, "notes.jsonl");
    const read = async () => {
      let text;
      try {
        text = await NodeFSP.readFile(notesPath, "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        text = "";
      }
      return {
        heading: context.settings.heading,
        notes: text
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      };
    };
    context.registerCommand("read", async () => ({
      ...(await read()),
      projects: await context.callT3("projects.list", {}),
    }));
    context.registerTool("read-notes", read);
    context.registerCommand("save", async (input, invocation) => {
      await NodeFSP.appendFile(
        notesPath,
        `${JSON.stringify({ text: input.text, threadId: invocation.threadId ?? null })}\n`,
      );
      return read();
    });
    context.onEvent(async (event) => {
      await NodeFSP.appendFile(
        NodePath.join(context.storagePath, "events.jsonl"),
        `${JSON.stringify(event)}\n`,
      );
    });
  },
};
