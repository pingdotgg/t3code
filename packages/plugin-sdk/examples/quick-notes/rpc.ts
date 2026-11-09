export type Note = { readonly id: string; readonly text: string };

/** The server half's methods and channel. Both halves name it, so their calls are checked. */
export type QuickNotesRpc = {
  methods: {
    list: { input: undefined; output: ReadonlyArray<Note> };
    add: { input: { text: string }; output: ReadonlyArray<Note> };
    remove: { input: { id: string }; output: ReadonlyArray<Note> };
  };
  channels: { notes: ReadonlyArray<Note> };
};
