// Cloudflare diagnostics service.
//
// Resources:
// - EndpointHealthcheck — Magic Transit / Magic WAN ICMP probe of an
//   on-net IP address.
//
// Not applicable as a resource:
// - Traceroute (`createTraceroute`) — a one-shot diagnostic action that
//   runs traceroutes from Cloudflare colos and returns hop data
//   synchronously. It persists no state, so it is a data-API operation,
//   not an IaC resource.
export * from "./EndpointHealthcheck.ts";
