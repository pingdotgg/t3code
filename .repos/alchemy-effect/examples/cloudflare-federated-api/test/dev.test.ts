/**
 * `alchemy dev` end-to-end: the zone routes are emulated locally, so the
 * single `url` output federates the API across all four Workers exactly
 * like the deployed hostname does.
 */
import { afterAll, expect, test } from "bun:test";
import * as path from "node:path";
import { DevCli, fetchOk } from "@alchemy.run/test/DevCli";

const root = path.resolve(import.meta.dirname, "..");
const cli = new DevCli({ root, stage: "dev-cli-test" });

afterAll(async () => {
  await cli.stop();
  if (!process.env.NO_DESTROY) cli.destroy();
}, 120_000);

const json = async (response: Response) => (await response.json()) as any;

test("one local URL routes each path to its own Worker", async () => {
  cli.start();
  const url = await cli.outputUrlWhenReady("url", { tries: 120 });

  // Unclaimed paths fall through to the custom-domain Worker.
  expect((await json(await fetchOk(`${url}/`))).endpoints).toContain("GET /products");

  // `/admin/*` → Admin (catalog writes).
  const put = await fetchOk(`${url}/admin/products/widget`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Widget", price: 5 }),
  });
  expect(await json(put)).toEqual({ id: "widget", name: "Widget", price: 5 });

  // `/products*` → Products (catalog reads).
  expect(await json(await fetchOk(`${url}/products/widget`))).toEqual({
    id: "widget",
    name: "Widget",
    price: 5,
  });

  // `/orders*` → Orders (reads the catalog, writes orders).
  const order = await json(
    await fetchOk(`${url}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productId: "widget", quantity: 3 }),
    }),
  );
  expect(order.total).toBe(15);
  expect(await json(await fetchOk(`${url}/orders/${order.id}`))).toEqual(order);
}, 180_000);
