import { readMessage } from "../../env.ts";

/**
 * Dynamic route with a path param: waku's fs-router passes the `[id]` segment
 * as the `id` prop. Rendered by the worker at request time.
 */
export default async function ItemPage({ id }: { id: string }) {
  return (
    <div>
      <div data-testid="item-marker">ITEM_MARKER id={id}</div>
      <div data-testid="item-env">MESSAGE={await readMessage()}</div>
    </div>
  );
}

export const getConfig = async () => ({ render: "dynamic" }) as const;
