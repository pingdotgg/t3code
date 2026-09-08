import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as NodeFs from "node:fs";
import * as NodeTls from "node:tls";
import type * as Config from "../workerd/Config.ts";

export class Internet extends Context.Service<Internet, Config.Service>()(
  "cloudflare-runtime/Internet",
) {}

/**
 * Extra trusted CAs from `NODE_EXTRA_CA_CERTS`, read FRESH on each call.
 *
 * This deliberately does NOT match Node's read-once-at-startup semantics:
 * this layer is built once per long-lived sidecar process, but the file the
 * env var points at may not exist yet when the sidecar starts — `alchemy
 * dev` points it at the local emulator's self-signed CA
 * (`~/.floci/ca.pem`), which is minted while the FIRST apply is already
 * deploying workers in parallel. Reading at every workerd config build
 * means the first worker (re)start after the CA lands trusts it, instead
 * of the whole sidecar being stuck with an empty store for its lifetime.
 */
const extraTrustedCertificates = (): string[] => {
  const bundlePath = process.env.NODE_EXTRA_CA_CERTS;
  if (bundlePath === undefined) return [];
  let pem: string;
  try {
    pem = NodeFs.readFileSync(bundlePath, "utf8");
  } catch {
    return [];
  }
  // Split the bundle into individual certificates and add each individually:
  // https://github.com/cloudflare/miniflare/pull/587/files#r1271579671
  return (
    pem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    ) ?? []
  );
};

export const InternetLive = Layer.sync(Internet, () => {
  // `workerd`'s `trustBrowserCas` should probably be named `trustSystemCas`.
  // Rather than using a bundled CA store like Node, it uses
  // `SSL_CTX_set_default_verify_paths()` to use the system CA store:
  // https://github.com/capnproto/capnproto/blob/6e26d260d1d91e0465ca12bbb5230a1dfa28f00d/c%2B%2B/src/kj/compat/tls.c%2B%2B#L745
  // Unfortunately, this doesn't work on Windows. Luckily, Node exposes its own
  // bundled CA store's certificates, so we just use those.
  const baseCertificates =
    process.platform === "win32" ? Array.from(NodeTls.rootCertificates) : [];
  return {
    name: "internet",
    get network() {
      return {
        // Allow access to private/public addresses:
        // https://github.com/cloudflare/miniflare/issues/412
        allow: ["public", "private", "240.0.0.0/4"],
        deny: [],
        tlsOptions: {
          trustBrowserCas: true,
          trustedCertificates: [
            ...baseCertificates,
            ...extraTrustedCertificates(),
          ],
        },
      };
    },
  };
});
