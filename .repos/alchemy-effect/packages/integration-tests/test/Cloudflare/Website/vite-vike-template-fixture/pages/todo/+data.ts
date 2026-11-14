// https://vike.dev/data

import type { PageContextServer } from "vike/types";

export type Data = Awaited<ReturnType<typeof data>>;

export async function data(_pageContext: PageContextServer) {
  const todoItemsInitial = [{ text: "Buy milk" }, { text: "Buy strawberries" }];
  return { todoItemsInitial };
}
