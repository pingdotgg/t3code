const { randomUUID } = require("node:crypto");

/** @type {import("@t3tools/plugin-sdk/server").PluginDefinition<import("./rpc.ts").QuickNotesRpc>} */
module.exports = {
  activate(api) {
    /** @typedef {import("./rpc.ts").Note} Note */
    /** @returns {Promise<ReadonlyArray<Note>>} */
    const read = async () => {
      const notes = await api.storage.get("notes");
      return Array.isArray(notes) ? notes : [];
    };
    // Each change waits for the one before it, so two quick adds never drop a note.
    /** @type {Promise<unknown>} */
    let changing = Promise.resolve();
    /** @param {(notes: ReadonlyArray<Note>) => ReadonlyArray<Note>} update */
    const change = (update) => {
      const changed = changing.then(async () => {
        const notes = update(await read());
        await api.storage.set("notes", notes);
        api.rpc.publish("notes", notes);
        return notes;
      });
      changing = changed.catch(() => undefined);
      return changed;
    };
    api.rpc.register("list", read, { access: "read" });
    api.rpc.register(
      "add",
      async (input) => {
        const text = typeof input?.text === "string" ? input.text.trim().slice(0, 500) : "";
        if (text === "") return read();
        const note = { id: randomUUID(), text };
        return change((notes) => [...notes, note].slice(-200));
      },
      { access: "write" },
    );
    api.rpc.register(
      "remove",
      async (input) => change((notes) => notes.filter((note) => note.id !== input?.id)),
      { access: "write" },
    );
  },
};
