/**
 * AWS-managed CloudFront cache policy for dynamic origins.
 * Disables caching so requests always reach the origin.
 */
export const MANAGED_CACHING_DISABLED_POLICY_ID =
  "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" as const;

/**
 * AWS-managed CloudFront cache policy for immutable/static assets.
 */
export const MANAGED_CACHING_OPTIMIZED_POLICY_ID =
  "658327ea-f89d-4fab-a63d-7e88639e58f6" as const;

/**
 * AWS-managed CloudFront origin request policy that forwards all viewer values
 * except the `Host` header. This is the standard policy for proxying dynamic
 * origins behind CloudFront.
 */
export const MANAGED_ALL_VIEWER_EXCEPT_HOST_HEADER_POLICY_ID =
  "b689b0a8-53d0-40ab-baf2-68738e2966ac" as const;
