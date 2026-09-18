import type { StripeOpError } from "@distilled.cloud/stripe";

/**
 * Stripe retrieve/delete often returns `InvalidRequestError` with
 * `code: "resource_missing"` instead of a typed NotFound. HTTP 5xx errors
 * carry a numeric `code`, so this predicate must accept the full
 * {@link StripeOpError} union (not `{ code?: string }`).
 */
export const isMissingStripeResource = (error: StripeOpError): boolean => {
  if (error._tag === "NotFound") {
    return true;
  }
  return (
    error._tag === "InvalidRequestError" && error.code === "resource_missing"
  );
};
