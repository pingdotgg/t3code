import { button, card, failure, h, sendMessage, start } from "../runtime.ts";

void start<{ readonly question: string; readonly options: ReadonlyArray<string> }>((data, root) => {
  const options = h("div", { class: "row" });
  const buttons = data.options.map((option, at) => {
    const element = button(
      option,
      () => {
        for (const other of buttons) other.disabled = true;
        sendMessage(option).catch((error: unknown) => {
          for (const other of buttons) other.disabled = false;
          options.after(failure(error));
        });
      },
      at === 0 ? "primary" : "plain",
    );
    return element;
  });
  options.append(...buttons);
  root.append(card(data.question, [options], { fullscreen: false }));
});
