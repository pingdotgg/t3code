/**
 * The routing rules, pinned under local emulation (`Test.make({ dev: true })`
 * runs the same local providers as `alchemy dev`). Every request goes to the
 * one `url` output — the custom-domain Worker's local URL — and must reach
 * the Worker whose zone route claims its path.
 */
import { expect } from "bun:test";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Test from "@alchemy.run/test/Bun";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import * as HttpClient from "effect/http/HttpClient";
import Stack from "../alchemy.run.ts";
import { StoreApi } from "../src/Api.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
  state: Alchemy.localState(),
  dev: true,
});

const stack = beforeAll(deploy(Stack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

const homePage = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(url);
    expect(response.status).toBe(200);
    return (yield* response.json) as { endpoints: string[] };
  });

test(
  "the url is a local URL",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect(url).toMatch(/^http:\/\/localhost:\d+$/);
  }),
);

test(
  "paths no route claims fall through to the custom-domain Worker",
  Effect.gen(function* () {
    const { url } = yield* stack;
    expect((yield* homePage(`${url}/`)).endpoints).toContain("GET /products");
    expect((yield* homePage(`${url}/about`)).endpoints).toContain("GET /products");
  }),
);

test(
  "each route reaches its own Worker through the one URL",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpApiClient.make(StoreApi, { baseUrl: url });

    // `/admin/*` → Admin, the only Worker that can write the catalog.
    yield* client.admin.putProduct({
      params: { id: "gadget" },
      payload: { name: "Gadget", price: 4 },
    });

    // `/products*` → Products, which reads what Admin wrote. `/products`
    // itself matches too: the trailing `*` covers the empty suffix.
    const product = yield* client.products.get({ params: { id: "gadget" } });
    expect(product).toMatchObject({ id: "gadget", name: "Gadget", price: 4 });
    const products = yield* client.products.list();
    expect(products.map((p) => p.id)).toContain("gadget");

    // `/orders*` → Orders, which reads the catalog and writes orders.
    const order = yield* client.orders.create({
      payload: { productId: "gadget", quantity: 2 },
    });
    expect(order.total).toBe(8);
    expect(yield* client.orders.get({ params: { id: order.id } })).toEqual(order);
  }),
);

test(
  "a routed Worker's typed errors reach the client",
  Effect.gen(function* () {
    const { url } = yield* stack;
    const client = yield* HttpApiClient.make(StoreApi, { baseUrl: url });
    const missing = yield* client.products.get({ params: { id: "missing" } }).pipe(Effect.flip);
    expect(missing._tag).toBe("ProductNotFound");
  }),
);
