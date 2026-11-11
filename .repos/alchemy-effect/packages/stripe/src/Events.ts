/**
 * Stripe webhook event classes. Each class is both the subscribe key
 * (`events: [CustomerCreated]`) and the value the handler receives.
 */
import type {
  Account,
  CheckoutSession,
  Customer,
  Invoice,
  PaymentIntent,
  Subscription,
} from "@distilled.cloud/stripe/stripe";

export interface StripeEventClass<Type extends string = string, Object = unknown> {
  readonly type: Type;
  new (object: any): StripeEventInstance<Type, Object>;
}

export interface StripeEventInstance<Type extends string = string, Object = unknown> {
  readonly type: Type;
  readonly object: Object;
}

export class CustomerCreated {
  static readonly type = "customer.created" as const;
  readonly type = "customer.created" as const;
  constructor(readonly object: Customer) {}
}
export class CustomerUpdated {
  static readonly type = "customer.updated" as const;
  readonly type = "customer.updated" as const;
  constructor(readonly object: Customer) {}
}
export class CustomerDeleted {
  static readonly type = "customer.deleted" as const;
  readonly type = "customer.deleted" as const;
  constructor(readonly object: Customer) {}
}
export class InvoicePaid {
  static readonly type = "invoice.paid" as const;
  readonly type = "invoice.paid" as const;
  constructor(readonly object: Invoice) {}
}
export class InvoicePaymentFailed {
  static readonly type = "invoice.payment_failed" as const;
  readonly type = "invoice.payment_failed" as const;
  constructor(readonly object: Invoice) {}
}
export class CheckoutSessionCompleted {
  static readonly type = "checkout.session.completed" as const;
  readonly type = "checkout.session.completed" as const;
  constructor(readonly object: CheckoutSession) {}
}
export class PaymentIntentSucceeded {
  static readonly type = "payment_intent.succeeded" as const;
  readonly type = "payment_intent.succeeded" as const;
  constructor(readonly object: PaymentIntent) {}
}
export class PaymentIntentFailed {
  static readonly type = "payment_intent.payment_failed" as const;
  readonly type = "payment_intent.payment_failed" as const;
  constructor(readonly object: PaymentIntent) {}
}
export class CustomerSubscriptionCreated {
  static readonly type = "customer.subscription.created" as const;
  readonly type = "customer.subscription.created" as const;
  constructor(readonly object: Subscription) {}
}
export class CustomerSubscriptionUpdated {
  static readonly type = "customer.subscription.updated" as const;
  readonly type = "customer.subscription.updated" as const;
  constructor(readonly object: Subscription) {}
}
export class CustomerSubscriptionDeleted {
  static readonly type = "customer.subscription.deleted" as const;
  readonly type = "customer.subscription.deleted" as const;
  constructor(readonly object: Subscription) {}
}
/**
 * Fires whenever a Connect account changes — most usefully when a merchant
 * finishes hosted onboarding and `charges_enabled` / `payouts_enabled`
 * flip to `true`.
 */
export class AccountUpdated {
  static readonly type = "account.updated" as const;
  readonly type = "account.updated" as const;
  constructor(readonly object: Account) {}
}
