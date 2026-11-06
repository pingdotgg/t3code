# @alchemy.run/acme

ACME certificates for [Alchemy](https://alchemy.run). Issue and renew TLS certificates from Let's Encrypt, ZeroSSL, Google Trust Services, or any ACME CA, independently of where you host, at deploy time or from inside an application.

```sh
npm install alchemy @alchemy.run/acme @alchemy.run/cloudflare effect
```

An account and a certificate validated through a Cloudflare DNS zone:

```typescript
// alchemy.run.ts
import * as Alchemy from "alchemy";
import * as ACME from "@alchemy.run/acme";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export default Alchemy.Stack(
  "Certificates",
  {
    providers: Layer.mergeAll(ACME.providers(), Cloudflare.providers()),
    state: Alchemy.localState(),
  },
  Effect.gen(function* () {
    const account = yield* ACME.Account("Issuer", {
      ca: ACME.LetsEncryptStaging,
      contact: ["mailto:ops@example.com"],
      termsOfServiceAgreed: true,
    });

    const certificate = yield* ACME.Certificate("Site", {
      account,
      identifiers: ["example.com"],
      solver: Cloudflare.ACME.ZoneSolver({
        zoneId: Config.String("CLOUDFLARE_ZONE_ID"),
      }),
    });

    return { serial: certificate.serial, expires: certificate.notAfter };
  }),
);
```

Each deploy checks the certificate and renews it once it enters its renewal window. There is no background timer, so redeploy on a schedule.

## Learn more

- [ACME on alchemy.run](https://alchemy.run/acme)
- [Getting started](https://alchemy.run/acme/getting-started)
- [Certificate authorities](https://alchemy.run/acme/certificate-authorities)
- [Renewal](https://alchemy.run/acme/renewal)
