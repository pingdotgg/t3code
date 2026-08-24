import * as AWS from "@/AWS";
import { SecurityConfig } from "@/AWS/OpenSearchServerless";
import * as Test from "@/Test/Alchemy";
import * as aoss from "@distilled.cloud/aws/opensearchserverless";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const CONFIG_NAME = "alchemy-test-saml";

// Self-signed X.509 certificate generated once with openssl and checked in as
// a constant (per the fixture convention — never generated at test time).
const SAML_CERT =
  "MIICyjCCAbICCQCxJOzsFl758TANBgkqhkiG9w0BAQsFADAnMSUwIwYDVQQDDBxhbGNoZW15LXRlc3QtaWRwLmV4YW1wbGUuY29tMB4XDTI2MDcxNTE5MTUwMVoXDTM2MDcxMjE5MTUwMVowJzElMCMGA1UEAwwcYWxjaGVteS10ZXN0LWlkcC5leGFtcGxlLmNvbTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBAKH+HmxWlUHl6UusNhnk7Jhd7fmMgOLsE2J4cBIL7sGssnrq6yfkMiIboYs2OMPXMFP4FxxgLAOzBzOE+pNCXbIvq/seIvo/P1Mr3cuHRG88PuXOYizzzbVqa18CnyYZe5I9NDSxp+W96gkMVAY4rQ9ILrHyrF2/rTb5uCj6gcwsUPKWpBZUxWN3PCIWOY2kWchFqxBvxyJcXJ53a5h6kGWfaRID7YYTO6bvTPmDNOgLANTMW0GsfqTdzm7N6xfZWQB9E4WxTP+B84mprddITJRZiFxGn2mJB9If6/JbxqilLd7VgWZCFUuH+mfhUMivwgMz76uo+6cEetfKhxoUe8sCAwEAATANBgkqhkiG9w0BAQsFAAOCAQEAHqSFxKJRPdQVwrLvnAgO3UBvRkm8I2twcCWyHKVwL2YhbUdVJoqnr10Q56PkQ+XiC11OBicqbxdYXEoWySFZhvLLuf5ynEmVRqUHbnaqrMyqvtU1dHqjoq8Rptd80WWLZbRpOp+4WFGkV+qHp97e4Sd67Lclgnryos2svy54EBZAiBvEFecDqhrrVqRlR6VjgHOqrEy1FLsQeqGpsmzgW8EEobxEXc5Qkvz6+tgJDc5C6iYs+TNRryCObtnIxSEDoWPuYmu+mGDn5jntch3zGPjvhK9jgLufplcFgub/au3C2FyItkcf9UlxpIAVAxTx120sC809bkSZ3FtPmgBt7A==";

const SAML_METADATA = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://alchemy-test-idp.example.com/saml">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data>
          <ds:X509Certificate>${SAML_CERT}</ds:X509Certificate>
        </ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:2.0:nameid-format:transient</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://alchemy-test-idp.example.com/sso"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://alchemy-test-idp.example.com/sso"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

const assertGone = (configId: string) =>
  aoss.getSecurityConfig({ id: configId }).pipe(
    Effect.flip,
    Effect.map((e) => expect(e._tag).toBe("ResourceNotFoundException")),
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
    }),
  );

// Security configs are free and provision instantly, so the full lifecycle
// runs ungated: create a SAML config (with a Duration-typed sessionTimeout),
// no-op, update the description (config version bump), destroy, verify gone.
test.provider(
  "saml security config lifecycle: create, no-op, update, destroy, verify gone",
  (stack) =>
    Effect.gen(function* () {
      // Clean slate in case a previous run died mid-flight.
      yield* stack.destroy();

      const deployConfig = (
        description: string,
        sessionTimeout: "2 hours" | "3 hours" = "2 hours",
      ) =>
        stack.deploy(
          Effect.gen(function* () {
            const config = yield* SecurityConfig("Saml", {
              configName: CONFIG_NAME,
              type: "saml",
              description,
              samlOptions: {
                metadata: SAML_METADATA,
                groupAttribute: "groups",
                // Duration.Input — converted to wire minutes.
                sessionTimeout,
              },
            });
            return { config };
          }),
        );

      // Create.
      const created = yield* deployConfig("alchemy test saml config");
      expect(created.config.configName).toBe(CONFIG_NAME);
      expect(created.config.type).toBe("saml");
      expect(created.config.configId).toContain(`saml/`);
      expect(created.config.configId).toContain(`/${CONFIG_NAME}`);
      const initialVersion = created.config.configVersion;

      // Out-of-band verification via distilled — including the wire unit of
      // the Duration-typed sessionTimeout (minutes).
      const observed = yield* aoss.getSecurityConfig({
        id: created.config.configId,
      });
      expect(observed.securityConfigDetail?.type).toBe("saml");
      expect(observed.securityConfigDetail?.samlOptions?.sessionTimeout).toBe(
        120,
      );
      expect(observed.securityConfigDetail?.samlOptions?.groupAttribute).toBe(
        "groups",
      );

      // No-op redeploy: version must not change.
      const noop = yield* deployConfig("alchemy test saml config");
      expect(noop.config.configVersion).toBe(initialVersion);

      // Update the SAML session timeout (a samlOptions change is what bumps
      // the config version — description-only updates keep it, verified
      // against the live API) and the description.
      const updated = yield* deployConfig(
        "alchemy test saml config v2",
        "3 hours",
      );
      expect(updated.config.configVersion).not.toBe(initialVersion);
      expect(updated.config.description).toBe("alchemy test saml config v2");
      const observedUpdated = yield* aoss.getSecurityConfig({
        id: updated.config.configId,
      });
      expect(
        observedUpdated.securityConfigDetail?.samlOptions?.sessionTimeout,
      ).toBe(180);

      // Destroy and verify deletion out-of-band.
      const configId = created.config.configId;
      yield* stack.destroy();
      yield* assertGone(configId);
    }),
  { timeout: 120_000 },
);
