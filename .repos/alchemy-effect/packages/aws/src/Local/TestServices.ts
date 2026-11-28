import type { TestServices } from "alchemy/Contributions";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { DEFAULT_LOCAL_ENDPOINT } from "../AuthProvider.ts";
import * as Floci from "./Floci.ts";
import { flociServices } from "./FlociServices.ts";

/**
 * Floci serves virtual-host data planes on the gateway when the Host
 * header is the AWS hostname (`{bucket}.s3-website-{region}.amazonaws.com`,
 * `{apiId}.appsync-api.{region}.amazonaws.com`,
 * `{apiId}.execute-api.{region}.amazonaws.com`,
 * `{distributionId}.cloudfront.net`). Live tests GET those hosts; under
 * `ALCHEMY_TEST_DEV` rewrite the URL to the emulator and keep the Host so
 * the virtual-host filter still fires.
 */
const rewriteVirtualHostToFloci = (
  request: HttpClientRequest.HttpClientRequest,
): HttpClientRequest.HttpClientRequest => {
  if (!URL.canParse(request.url)) return request;
  const url = new URL(request.url);
  if (
    !/\.s3-website-[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
    !/\.appsync-api\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
    !/\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/i.test(url.hostname) &&
    !/\.cloudfront\.net$/i.test(url.hostname)
  ) {
    return request;
  }
  const rewritten = new URL(url.href);
  const endpoint = new URL(DEFAULT_LOCAL_ENDPOINT);
  rewritten.protocol = endpoint.protocol;
  rewritten.hostname = endpoint.hostname;
  rewritten.port = endpoint.port;
  return request.pipe(
    HttpClientRequest.setUrl(rewritten.toString()),
    HttpClientRequest.setHeader("host", url.hostname),
  );
};

/** Tests under `ALCHEMY_TEST_DEV` run their AWS clients against Floci. */
export const testServices = (): TestServices => ({
  layer: flociServices(),
  mapRequest: rewriteVirtualHostToFloci,
  // Local workerd trusts no self-signed certs and ignores
  // NODE_TLS_REJECT_UNAUTHORIZED (it's C++, not Node). Its runtime DOES fold
  // `NODE_EXTRA_CA_CERTS` into workerd's outbound `trustedCertificates` (see
  // cloudflare-runtime Internet.ts), so point it at the emulator CA bundle
  // that `ensureFloci` refreshes on every health check.
  env: { NODE_EXTRA_CA_CERTS: Floci.FLOCI_CA_PATH },
});
