import type { Simplify } from "effect/Types";

/**
 * Type-only helpers for Cloudflare Zaraz events.
 *
 * These declarations are not an Alchemy EventSource resource and do not send
 * events at runtime. They only model the browser-side `window.zaraz` API and
 * Zaraz HTTP event payloads so application code can share an event contract
 * with infrastructure code.
 */

/**
 * A map of Zaraz event names to the properties accepted by each event.
 *
 * Use `undefined` for events that do not accept custom properties.
 */
export type ZarazEventMap = Record<string, object | undefined>;

type RequireAtLeastOne<T extends object> = {
  readonly [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

/**
 * Product properties supported by Cloudflare Zaraz ecommerce events.
 */
export type ZarazEcommerceProduct = {
  readonly product_id?: string;
  readonly sku?: string;
  readonly category?: string;
  readonly name?: string;
  readonly brand?: string;
  readonly variant?: string;
  readonly price?: number;
  readonly currency?: string;
  readonly value?: number;
  readonly quantity?: number;
  readonly coupon?: string;
  readonly position?: number;
};

/**
 * Order and checkout properties supported by Cloudflare Zaraz ecommerce events.
 */
export type ZarazEcommerceOrder = {
  readonly checkout_id?: string;
  readonly order_id?: string;
  readonly affiliation?: string;
  readonly total?: number;
  readonly revenue?: number;
  readonly shipping?: number;
  readonly tax?: number;
  readonly discount?: number;
  readonly coupon?: string;
  readonly currency?: string;
  readonly products?: readonly ZarazEcommerceProduct[];
};

export type ZarazEcommercePromotion = {
  readonly creative?: string;
};

export type ZarazEcommerceSearch = {
  readonly query?: string;
};

export type ZarazEcommerceCheckoutStep = {
  readonly step?: number;
};

export type ZarazEcommercePayment = {
  readonly payment_type?: string;
};

export type ZarazEcommerceRefund = {
  readonly amount?: number;
  readonly amount_refunded?: number;
  readonly currency?: string;
  readonly refund_reason?: string;
};

/**
 * Standard ecommerce events supported by Cloudflare's `zaraz.ecommerce()` API.
 */
export type ZarazEcommerceEvents = {
  readonly "Product List Viewed": RequireAtLeastOne<
    Pick<ZarazEcommerceOrder, "products">
  >;
  readonly "Products Searched": RequireAtLeastOne<ZarazEcommerceSearch>;
  readonly "Product Clicked": RequireAtLeastOne<ZarazEcommerceProduct>;
  readonly "Product Added": RequireAtLeastOne<ZarazEcommerceProduct>;
  readonly "Product Added to Wishlist": RequireAtLeastOne<ZarazEcommerceProduct>;
  readonly "Product Removed": RequireAtLeastOne<ZarazEcommerceProduct>;
  readonly "Product Viewed": RequireAtLeastOne<ZarazEcommerceProduct>;
  readonly "Cart Viewed": RequireAtLeastOne<ZarazEcommerceOrder>;
  readonly "Checkout Started": RequireAtLeastOne<ZarazEcommerceOrder>;
  readonly "Checkout Step Viewed": RequireAtLeastOne<ZarazEcommerceCheckoutStep>;
  readonly "Checkout Step Completed": RequireAtLeastOne<ZarazEcommerceCheckoutStep>;
  readonly "Payment Info Entered": RequireAtLeastOne<ZarazEcommercePayment>;
  readonly "Order Completed": RequireAtLeastOne<ZarazEcommerceOrder>;
  readonly "Order Updated": RequireAtLeastOne<ZarazEcommerceOrder>;
  readonly "Order Refunded": RequireAtLeastOne<
    ZarazEcommerceOrder & ZarazEcommerceRefund
  >;
  readonly "Order Cancelled": RequireAtLeastOne<ZarazEcommerceOrder>;
  readonly "Clicked Promotion": RequireAtLeastOne<ZarazEcommercePromotion>;
  readonly "Viewed Promotion": RequireAtLeastOne<ZarazEcommercePromotion>;
  readonly "Shipping Info Entered": RequireAtLeastOne<ZarazEcommerceOrder>;
};

declare const ZarazEventContractTypeId: unique symbol;

/**
 * Type-only contract for an application's Zaraz events.
 *
 * The runtime value is intentionally empty. Application browser code should
 * import derived types and call Cloudflare's injected `window.zaraz` API rather
 * than importing Alchemy runtime code into the client bundle.
 */
export type ZarazEventContract<
  Events extends ZarazEventMap,
  EcommerceEvents extends ZarazEventMap = {},
> = {
  readonly [ZarazEventContractTypeId]: {
    readonly events: Events;
    readonly ecommerceEvents: EcommerceEvents;
  };
};

/**
 * Define an application's Zaraz event contract.
 *
 * @example
 * ```typescript
 * const zaraz = Cloudflare.ZarazConfig.events<{
 *   Login: { method: "google" | "email" | "email-link" };
 *   "Button Clicked": { button_label: string; context?: string };
 * }>();
 *
 * const zarazWithEcommerce = Cloudflare.ZarazConfig.events<{
 *   Login: { method: "google" | "email" | "email-link" };
 * }>({ ecommerce: true });
 *
 * export type AppZarazEvents = Cloudflare.InferZarazEvents<typeof zaraz>;
 * ```
 */
export function defineZarazEvents<const Events extends ZarazEventMap>(options: {
  readonly ecommerce: true;
}): ZarazEventContract<Events, ZarazEcommerceEvents>;
export function defineZarazEvents<
  const Events extends ZarazEventMap,
>(options?: { readonly ecommerce?: false }): ZarazEventContract<Events, {}>;
export function defineZarazEvents<
  const Events extends ZarazEventMap,
>(_options?: {
  readonly ecommerce?: boolean;
}): ZarazEventContract<Events, ZarazEventMap> {
  return {} as ZarazEventContract<Events, {}>;
}

export type InferZarazEvents<Contract> =
  Contract extends ZarazEventContract<infer Events, ZarazEventMap>
    ? Events
    : never;

export type InferZarazEcommerceEvents<Contract> =
  Contract extends ZarazEventContract<ZarazEventMap, infer EcommerceEvents>
    ? EcommerceEvents
    : never;

export type ZarazEventName<Events extends ZarazEventMap> = Extract<
  keyof Events,
  string
>;

export type ZarazEventProperties<
  Events extends ZarazEventMap,
  Name extends ZarazEventName<Events>,
> = Events[Name];

type ZarazEventPropertiesArgs<Properties> = [Properties] extends [undefined]
  ? [properties?: undefined]
  : undefined extends Properties
    ? [properties?: Exclude<Properties, undefined>]
    : [properties: Properties];

/**
 * Type for Cloudflare's injected `window.zaraz.track` function.
 */
export type ZarazTrack<Events extends ZarazEventMap> = <
  const Name extends ZarazEventName<Events>,
>(
  eventName: Name,
  ...args: ZarazEventPropertiesArgs<Events[Name]>
) => Promise<void>;

/**
 * Type for Cloudflare's injected `window.zaraz.ecommerce` function.
 */
export type ZarazEcommerce<Events extends ZarazEventMap> = ZarazTrack<Events>;

export type ZarazSetScope = "page" | "session" | "persist";

/**
 * Type for Cloudflare's injected browser-side Zaraz API.
 */
export type ZarazWebApi<
  Events extends ZarazEventMap,
  EcommerceEvents extends ZarazEventMap = {},
> = {
  set: (
    name: string,
    value: unknown,
    options?: { scope?: ZarazSetScope },
  ) => void;
  track: ZarazTrack<Events>;
  ecommerce: ZarazEcommerce<EcommerceEvents>;
  preview: (debugKey: string) => Promise<void>;
  debug: (debugKey: string) => Promise<void>;
  showConsentModal: () => Promise<void>;
  pageVariables: Record<string, unknown>;
};

export type ZarazSystem = {
  cookies?: Record<string, unknown>;
  device?: {
    ip?: string;
    resolution?: string;
    viewport?: string;
    language?: string;
    "user-agent"?: string;
  };
  page?: {
    title?: string;
    url?: string;
    referrer?: string;
    encoding?: string;
  };
};

export type ZarazClientProperties<
  Events extends ZarazEventMap,
  Name extends ZarazEventName<Events> = ZarazEventName<Events>,
> =
  Name extends ZarazEventName<Events>
    ? Events[Name] extends undefined
      ? { readonly __zarazTrack: Name }
      : Simplify<Events[Name] & { readonly __zarazTrack: Name }>
    : never;

export type ZarazHttpEvent<Events extends ZarazEventMap> = {
  readonly client: ZarazClientProperties<Events>;
  readonly system?: ZarazSystem;
};

export type ZarazHttpEventsPayload<Events extends ZarazEventMap> = {
  readonly events: readonly ZarazHttpEvent<Events>[];
};
