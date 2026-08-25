import {
  Config,
  type InferZarazEcommerceEvents,
  type InferZarazEvents,
  type HttpEventsPayload,
  type Track,
  type WebApi,
} from "@/Cloudflare/Zaraz";
import { expect, test } from "alchemy-test";

const checkZarazEventTypes = () => {
  const zaraz = Config.events<{
    Login: { method: "google" | "email" | "email-link" };
    "Button Clicked": { button_label: string; context?: string };
    __zarazSPA: undefined;
  }>();

  const zarazWithEcommerce = Config.events<{
    Login: { method: "google" | "email" | "email-link" };
    "Button Clicked": { button_label: string; context?: string };
    __zarazSPA: undefined;
  }>({ ecommerce: true });

  type Events = InferZarazEvents<typeof zaraz>;
  type DisabledEcommerceEvents = InferZarazEcommerceEvents<typeof zaraz>;
  type EcommerceEvents = InferZarazEcommerceEvents<typeof zarazWithEcommerce>;

  const standardEcommerceEvents = {
    "Product List Viewed": true,
    "Products Searched": true,
    "Product Clicked": true,
    "Product Added": true,
    "Product Added to Wishlist": true,
    "Product Removed": true,
    "Product Viewed": true,
    "Cart Viewed": true,
    "Checkout Started": true,
    "Checkout Step Viewed": true,
    "Checkout Step Completed": true,
    "Payment Info Entered": true,
    "Order Completed": true,
    "Order Updated": true,
    "Order Refunded": true,
    "Order Cancelled": true,
    "Clicked Promotion": true,
    "Viewed Promotion": true,
    "Shipping Info Entered": true,
  } satisfies Record<keyof EcommerceEvents, true>;

  void standardEcommerceEvents;

  const track = undefined as unknown as Track<Events>;

  track("Login", { method: "google" });
  track("__zarazSPA");
  track("__zarazSPA", undefined);
  track("Button Clicked", { button_label: "Save" });
  track("Button Clicked", { button_label: "Save", context: "toolbar" });

  // @ts-expect-error event name must exist in the contract
  track("Missing", {});

  // @ts-expect-error event properties are checked per event name
  track("Login", { method: "github" });

  // @ts-expect-error events with undefined properties do not accept an object
  track("__zarazSPA", {});

  // @ts-expect-error required event properties must be present
  track("Button Clicked", {});

  const browser = undefined as unknown as WebApi<Events, EcommerceEvents>;
  const browserWithoutEcommerce = undefined as unknown as WebApi<
    Events,
    DisabledEcommerceEvents
  >;

  browser.track("Login", { method: "email-link" });
  browser.ecommerce("Product Viewed", { product_id: "product-1", price: 12 });
  browser.ecommerce("Products Searched", { query: "shirts" });
  browser.ecommerce("Checkout Step Viewed", { step: 1 });
  browser.ecommerce("Order Completed", {
    order_id: "order-1",
    total: 24,
    currency: "USD",
    products: [{ product_id: "product-1", quantity: 2 }],
  });

  // @ts-expect-error ecommerce events are disabled unless the contract opts in
  browserWithoutEcommerce.ecommerce("Product Viewed", {
    product_id: "product-1",
  });

  // @ts-expect-error ecommerce events use the ecommerce contract
  browser.ecommerce("Login", { method: "google" });

  // @ts-expect-error ecommerce payloads are checked
  browser.ecommerce("Product Viewed", { invalid: "product-1" });

  // @ts-expect-error ecommerce events require at least one supported property
  browser.ecommerce("Product Viewed", {});

  const payload = {
    events: [
      {
        client: {
          __zarazTrack: "Login",
          method: "email",
        },
        system: {
          page: {
            title: "Login",
            url: "https://example.com/login",
          },
        },
      },
    ],
  } satisfies HttpEventsPayload<Events>;

  void payload;

  const emptyPayload = {
    events: [
      {
        client: {
          __zarazTrack: "__zarazSPA",
        },
      },
    ],
  } satisfies HttpEventsPayload<Events>;

  void emptyPayload;

  const invalidPayload = {
    events: [
      {
        client: {
          __zarazTrack: "Login",
          // @ts-expect-error HTTP event payloads validate discriminated event properties
          method: "github",
        },
      },
    ],
  } satisfies HttpEventsPayload<Events>;

  void invalidPayload;
};

void checkZarazEventTypes;

test("Zaraz event contracts are type-only", () => {
  expect(Config.events<{}>()).toEqual({});
});
