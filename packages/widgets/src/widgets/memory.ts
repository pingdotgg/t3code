import { button, callTool, failure, h, start, t } from "../runtime.ts";

interface MemoryNote {
  readonly id: string;
  readonly text: string;
  readonly status: "saved" | "proposed" | "removed";
  readonly action: "add" | "patch" | "remove";
}

void start<MemoryNote>((note, root) => {
  const draw = (status: string) => {
    const run = (name: string, args: Record<string, unknown>, next: string) => () =>
      void callTool(name, args).then(
        () => draw(next),
        (error: unknown) => root.append(failure(error)),
      );
    const label = {
      saved: t("Remembered", "Zapamiętano"),
      proposed:
        note.action === "remove"
          ? t("Forget this?", "Zapomnieć to?")
          : t("Remember this?", "Zapamiętać to?"),
      removed: t("Forgotten", "Zapomniano"),
    }[status];
    root.replaceChildren(
      h(
        "div",
        { class: "pill" },
        h("span", {}, h("b", {}, `${label}: `), note.text),
        h(
          "div",
          { class: "row", style: "flex-wrap:nowrap" },
          status === "saved" &&
            note.action === "add" &&
            button(t("Undo", "Cofnij"), run("memory_remove", { id: note.id }, "removed")),
          status === "proposed" &&
            button(
              t("Save", "Zapisz"),
              run(
                "memory_resolve",
                { id: note.id, approve: true },
                note.action === "remove" ? "removed" : "saved",
              ),
              "primary",
            ),
          status === "proposed" &&
            button(
              t("Reject", "Odrzuć"),
              run("memory_resolve", { id: note.id, approve: false }, "removed"),
            ),
        ),
      ),
    );
  };
  draw(note.status);
  // It may have been approved, undone or edited elsewhere since.
  if (note.status !== "removed") {
    callTool("memory_state", { id: note.id }).then(
      ({ status }) => {
        if (status !== note.status) draw(String(status));
      },
      () => {},
    );
  }
});
