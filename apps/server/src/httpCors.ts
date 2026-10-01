export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  "x-t3-client-instance",
] as const;
// Response headers that clients decode from cross-origin responses (desktop renderer
// `t3code://app`, remote web clients). Browsers hide non-safelisted headers unless exposed.
// `x-content-type-options` is part of the `/api/extensions/asset` success contract.
export const browserApiCorsExposedHeaders = ["x-content-type-options"] as const;
