import type { Html, HtmlBuilder } from "foldkit/html";

// A plain Foldkit view function styled with Tailwind utility classes.
export const card = <Message>(
  h: HtmlBuilder<Message>,
  props: { title: string; body: string },
): Html =>
  h.div(
    [
      h.Class(
        "mt-6 max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm",
      ),
    ],
    [
      h.h2([h.Class("text-lg font-semibold")], [props.title]),
      h.p([h.Class("mt-2 text-slate-600")], [props.body]),
    ],
  );
