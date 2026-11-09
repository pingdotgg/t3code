import * as Atom from "@t3tools/plugin-sdk/atom";
import { useAtomValue } from "@t3tools/plugin-sdk/atom-react";
import { Button, Input } from "@t3tools/plugin-sdk/ui";
import { defineWebPlugin } from "@t3tools/plugin-sdk/web";
import { useState } from "react";

import type { Note, QuickNotesRpc } from "./rpc.ts";

const css = `
.quick-notes-panel { display: flex; flex-direction: column; gap: 1rem; padding: 1rem; }
.quick-notes-list { display: flex; flex-direction: column; gap: 0.25rem; }
.quick-notes-item { display: flex; align-items: center; gap: 0.5rem; font-size: 0.8125rem; }
.quick-notes-item span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.quick-notes-form { display: flex; gap: 0.5rem; }
`;

export default defineWebPlugin<QuickNotesRpc>({
  activate(api) {
    api.injectStyles(css);
    // A read-only client, for one, is refused; say so instead of leaving the draft as it was.
    const showFailure = (title: string) => (error: unknown) =>
      api.toast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : String(error),
      });

    // One list for every open panel, following the server's channel while one shows.
    const notesAtom = Atom.make((get): ReadonlyArray<Note> => {
      // Subscribed first, so a change published before the list arrives isn't overwritten by it.
      let changed = false;
      get.addFinalizer(
        api.rpc.subscribe("notes", (notes) => {
          changed = true;
          get.setSelf(notes);
        }),
      );
      void api.rpc.invoke("list").then((notes) => {
        if (!changed) get.setSelf(notes);
      }, showFailure("Quick notes couldn't load your notes"));
      return [];
    });

    api.rightPanel.register({
      name: "notes",
      title: "Quick notes",
      component: function QuickNotesPanel() {
        const notes = useAtomValue(notesAtom);
        const [draft, setDraft] = useState("");
        return (
          <div className="quick-notes-panel">
            <form
              className="quick-notes-form"
              onSubmit={(event) => {
                event.preventDefault();
                void api.rpc
                  .invoke("add", { text: draft })
                  .then(() => setDraft(""), showFailure("Quick notes couldn't save that"));
              }}
            >
              <Input
                aria-label="New note"
                placeholder="Write a note"
                value={draft}
                onChange={(event) => setDraft(event.currentTarget.value)}
              />
              <Button type="submit">Add</Button>
            </form>
            <div className="quick-notes-list">
              {notes.toReversed().map((note) => (
                <div key={note.id} className="quick-notes-item">
                  <span>{note.text}</span>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void api.rpc
                        .invoke("remove", { id: note.id })
                        .catch(showFailure("Quick notes couldn't remove that"))
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          </div>
        );
      },
    });
  },
});
