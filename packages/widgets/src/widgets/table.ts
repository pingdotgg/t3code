import { card, h, start, t } from "../runtime.ts";

const asNumber = (value: string) => {
  const number = Number(value.replace(/[\s %]/g, "").replace(",", "."));
  return value.trim() === "" || Number.isNaN(number) ? undefined : number;
};

const compare = (left: string, right: string) => {
  const a = asNumber(left);
  const b = asNumber(right);
  return a !== undefined && b !== undefined
    ? a - b
    : left.localeCompare(right, undefined, { numeric: true });
};

void start<{
  readonly title: string;
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}>((table, root) => {
  let sorted: { readonly column: number; readonly descending: boolean } | undefined;
  let filter = "";
  const body = h("tbody");
  const head = h("tr");

  const draw = () => {
    const needle = filter.toLocaleLowerCase();
    const rows = table.rows.filter((row) =>
      row.some((cell) => cell.toLocaleLowerCase().includes(needle)),
    );
    const order = sorted;
    const shown =
      order === undefined
        ? rows
        : rows.toSorted(
            (a, b) =>
              compare(a[order.column] ?? "", b[order.column] ?? "") * (order.descending ? -1 : 1),
          );
    head.replaceChildren(
      ...table.columns.map((name, column) =>
        h(
          "th",
          {
            scope: "col",
            ariaSort:
              order?.column === column ? (order.descending ? "descending" : "ascending") : "none",
          },
          h(
            "button",
            {
              type: "button",
              onclick: () => {
                sorted = { column, descending: order?.column === column && !order.descending };
                draw();
              },
            },
            `${name}${order?.column === column ? (order.descending ? " ↓" : " ↑") : ""}`,
          ),
        ),
      ),
    );
    body.replaceChildren(
      ...shown.map((row) =>
        h("tr", {}, ...table.columns.map((_, at) => h("td", {}, row[at] ?? ""))),
      ),
    );
  };

  const search = h("input", {
    type: "search",
    placeholder: t("Filter", "Filtruj"),
    ariaLabel: t("Filter", "Filtruj"),
    oninput: () => {
      filter = search.value;
      draw();
    },
  });
  root.append(
    card(
      table.title,
      [
        table.rows.length > 6 && h("div", { style: "margin-bottom:10px" }, search),
        h("div", { class: "scroll" }, h("table", {}, h("thead", {}, head), body)),
      ],
      { ask: `${t("About the table", "O tabeli")} "${table.title}": ` },
    ),
  );
  draw();
});
