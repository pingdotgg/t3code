import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Schema from "effect/Schema";

/**
 * One API, defined once. Each group is served by its own Worker (see
 * `alchemy.run.ts`); clients only ever see `StoreApi` at a single URL.
 */

export class Product extends Schema.Class<Product>("Product")({
  id: Schema.String,
  name: Schema.String,
  price: Schema.Number,
}) {}

export class Order extends Schema.Class<Order>("Order")({
  id: Schema.String,
  productId: Schema.String,
  quantity: Schema.Number,
  total: Schema.Number,
}) {}

export class ProductNotFound extends Schema.TaggedError<ProductNotFound>()(
  "ProductNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

export class OrderNotFound extends Schema.TaggedError<OrderNotFound>()(
  "OrderNotFound",
  { id: Schema.String },
  { httpApiStatus: 404 },
) {}

const Id = Schema.Struct({ id: Schema.String });

/** `GET /products/*` — read-only catalog. */
export class ProductsGroup extends HttpApiGroup.make("products")
  .add(HttpApiEndpoint.get("list", "/", { success: Schema.Array(Product) }))
  .add(HttpApiEndpoint.get("get", "/:id", { params: Id, success: Product, error: ProductNotFound }))
  .prefix("/products") {}

/** `/orders/*` — places orders against the catalog. */
export class OrdersGroup extends HttpApiGroup.make("orders")
  .add(
    HttpApiEndpoint.post("create", "/", {
      payload: Schema.Struct({ productId: Schema.String, quantity: Schema.Number }),
      success: Order,
      error: ProductNotFound,
    }),
  )
  .add(HttpApiEndpoint.get("get", "/:id", { params: Id, success: Order, error: OrderNotFound }))
  .prefix("/orders") {}

/** `/admin/*` — catalog writes. */
export class AdminGroup extends HttpApiGroup.make("admin")
  .add(
    HttpApiEndpoint.put("putProduct", "/products/:id", {
      params: Id,
      payload: Schema.Struct({ name: Schema.String, price: Schema.Number }),
      success: Product,
    }),
  )
  .prefix("/admin") {}

/** The public surface — what a client sees at the one URL. */
export class StoreApi extends HttpApi.make("StoreApi")
  .add(ProductsGroup)
  .add(OrdersGroup)
  .add(AdminGroup) {}

/** Each Worker serves exactly one group. */
export class ProductsApi extends HttpApi.make("ProductsApi").add(ProductsGroup) {}
export class OrdersApi extends HttpApi.make("OrdersApi").add(OrdersGroup) {}
export class AdminApi extends HttpApi.make("AdminApi").add(AdminGroup) {}
