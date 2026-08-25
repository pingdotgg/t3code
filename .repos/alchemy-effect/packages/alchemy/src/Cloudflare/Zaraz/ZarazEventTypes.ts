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
export type EventMap = Record<string, object | undefined>;

type RequireAtLeastOne<T extends object> = {
  readonly [K in keyof T]-?: Required<Pick<T, K>> & Partial<Omit<T, K>>;
}[keyof T];

/**
 * Product properties supported by Cloudflare Zaraz ecommerce events.
 */
export type EcommerceProduct = {
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
export type EcommerceOrder = {
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
  readonly products?: readonly EcommerceProduct[];
};

export type EcommercePromotion = {
  readonly creative?: string;
};

export type EcommerceSearch = {
  readonly query?: string;
};

export type EcommerceCheckoutStep = {
  readonly step?: number;
};

export type EcommercePayment = {
  readonly payment_type?: string;
};

export type EcommerceRefund = {
  readonly amount?: number;
  readonly amount_refunded?: number;
  readonly currency?: string;
  readonly refund_reason?: string;
};

/**
 * Standard ecommerce events supported by Cloudflare's `zaraz.ecommerce()` API.
 */
export type EcommerceEvents = {
  readonly "Product List Viewed": RequireAtLeastOne<
    Pick<EcommerceOrder, "products">
  >;
  readonly "Products Searched": RequireAtLeastOne<EcommerceSearch>;
  readonly "Product Clicked": RequireAtLeastOne<EcommerceProduct>;
  readonly "Product Added": RequireAtLeastOne<EcommerceProduct>;
  readonly "Product Added to Wishlist": RequireAtLeastOne<EcommerceProduct>;
  readonly "Product Removed": RequireAtLeastOne<EcommerceProduct>;
  readonly "Product Viewed": RequireAtLeastOne<EcommerceProduct>;
  readonly "Cart Viewed": RequireAtLeastOne<EcommerceOrder>;
  readonly "Checkout Started": RequireAtLeastOne<EcommerceOrder>;
  readonly "Checkout Step Viewed": RequireAtLeastOne<EcommerceCheckoutStep>;
  readonly "Checkout Step Completed": RequireAtLeastOne<EcommerceCheckoutStep>;
  readonly "Payment Info Entered": RequireAtLeastOne<EcommercePayment>;
  readonly "Order Completed": RequireAtLeastOne<EcommerceOrder>;
  readonly "Order Updated": RequireAtLeastOne<EcommerceOrder>;
  readonly "Order Refunded": RequireAtLeastOne<
    EcommerceOrder & EcommerceRefund
  >;
  readonly "Order Cancelled": RequireAtLeastOne<EcommerceOrder>;
  readonly "Clicked Promotion": RequireAtLeastOne<EcommercePromotion>;
  readonly "Viewed Promotion": RequireAtLeastOne<EcommercePromotion>;
  readonly "Shipping Info Entered": RequireAtLeastOne<EcommerceOrder>;
};

declare const ZarazEventContractTypeId: unique symbol;

/**
 * Type-only contract for an application's Zaraz events.
 *
 * The runtime value is intentionally empty. Application browser code should
 * import derived types and call Cloudflare's injected `window.zaraz` API rather
 * than importing Alchemy runtime code into the client bundle.
 */
export type EventContract<
  Events extends EventMap,
  EcommerceEvents extends EventMap = {},
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
 * const zaraz = Cloudflare.Config.events<{
 *   Login: { method: "google" | "email" | "email-link" };
 *   "Button Clicked": { button_label: string; context?: string };
 * }>();
 *
 * const zarazWithEcommerce = Cloudflare.Config.events<{
 *   Login: { method: "google" | "email" | "email-link" };
 * }>({ ecommerce: true });
 *
 * export type AppZarazEvents = Cloudflare.Zaraz.InferZarazEvents<typeof zaraz>;
 * ```
 */
export function defineZarazEvents<const Events extends EventMap>(options: {
  readonly ecommerce: true;
}): EventContract<Events, EcommerceEvents>;
export function defineZarazEvents<const Events extends EventMap>(options?: {
  readonly ecommerce?: false;
}): EventContract<Events, {}>;
export function defineZarazEvents<const Events extends EventMap>(_options?: {
  readonly ecommerce?: boolean;
}): EventContract<Events, EventMap> {
  return {} as EventContract<Events, {}>;
}

export type InferZarazEvents<Contract> =
  Contract extends EventContract<infer Events, EventMap> ? Events : never;

export type InferZarazEcommerceEvents<Contract> =
  Contract extends EventContract<EventMap, infer EcommerceEvents>
    ? EcommerceEvents
    : never;

export type EventName<Events extends EventMap> = Extract<keyof Events, string>;

export type EventProperties<
  Events extends EventMap,
  Name extends EventName<Events>,
> = Events[Name];

type ZarazEventPropertiesArgs<Properties> = [Properties] extends [undefined]
  ? [properties?: undefined]
  : undefined extends Properties
    ? [properties?: Exclude<Properties, undefined>]
    : [properties: Properties];

/**
 * Type for Cloudflare's injected `window.zaraz.track` function.
 */
export type Track<Events extends EventMap> = <
  const Name extends EventName<Events>,
>(
  eventName: Name,
  ...args: ZarazEventPropertiesArgs<Events[Name]>
) => Promise<void>;

/**
 * Type for Cloudflare's injected `window.zaraz.ecommerce` function.
 */
export type Ecommerce<Events extends EventMap> = Track<Events>;

export type SetScope = "page" | "session" | "persist";

/**
 * Type for Cloudflare's injected browser-side Zaraz API.
 */
export type WebApi<
  Events extends EventMap,
  EcommerceEvents extends EventMap = {},
> = {
  set: (name: string, value: unknown, options?: { scope?: SetScope }) => void;
  track: Track<Events>;
  ecommerce: Ecommerce<EcommerceEvents>;
  preview: (debugKey: string) => Promise<void>;
  debug: (debugKey: string) => Promise<void>;
  showConsentModal: () => Promise<void>;
  pageVariables: Record<string, unknown>;
};

export type System = {
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

export type ClientProperties<
  Events extends EventMap,
  Name extends EventName<Events> = EventName<Events>,
> =
  Name extends EventName<Events>
    ? Events[Name] extends undefined
      ? { readonly __zarazTrack: Name }
      : Simplify<Events[Name] & { readonly __zarazTrack: Name }>
    : never;

export type HttpEvent<Events extends EventMap> = {
  readonly client: ClientProperties<Events>;
  readonly system?: System;
};

export type HttpEventsPayload<Events extends EventMap> = {
  readonly events: readonly HttpEvent<Events>[];
};
