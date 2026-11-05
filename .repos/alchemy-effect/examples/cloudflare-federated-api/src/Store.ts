import * as Cloudflare from "@alchemy.run/cloudflare";

/**
 * The KV namespaces behind the API. Each Worker binds only the access it
 * needs: Products reads the catalog, Admin writes it, Orders reads the
 * catalog and owns the orders.
 */
export const Catalog = Cloudflare.KV.Namespace("Catalog");
export const OrderBook = Cloudflare.KV.Namespace("OrderBook");

/**
 * The public hostname. Every Worker below is served under it — the custom
 * domain owns the hostname (DNS + TLS) and zone routes peel off paths.
 */
export const HOSTNAME = process.env.API_HOSTNAME ?? "api.example.com";
