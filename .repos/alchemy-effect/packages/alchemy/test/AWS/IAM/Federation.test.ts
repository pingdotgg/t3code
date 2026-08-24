import * as AWS from "@/AWS";
import { OpenIDConnectProvider, Role, SAMLProvider } from "@/AWS/IAM";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  testOidcGithubHost,
  testOidcGithubUrl,
  testOidcThumbprintA,
  testOidcThumbprintB,
  testOidcUrl,
  testSamlMetadataDocument,
  testSamlMetadataDocumentUpdated,
  testSamlProviderName,
} from "./fixtures.ts";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.IAM federation resources", () => {
  test.provider(
    "create, update, and delete an OpenID Connect provider",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const provider = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* OpenIDConnectProvider("OidcProvider", {
              url: testOidcUrl,
              clientIDList: ["sts.amazonaws.com"],
              thumbprintList: [testOidcThumbprintA],
              tags: {
                env: "test",
              },
            });
          }),
        );

        const created = yield* IAM.getOpenIDConnectProvider({
          OpenIDConnectProviderArn: provider.openIDConnectProviderArn,
        });
        expect(created.Url).toBe(testOidcUrl.replace(/^https?:\/\//, ""));
        expect(created.ClientIDList ?? []).toContain("sts.amazonaws.com");

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* OpenIDConnectProvider("OidcProvider", {
              url: testOidcUrl,
              clientIDList: ["sts.amazonaws.com", "alchemy-client"],
              thumbprintList: [testOidcThumbprintB],
              tags: {
                env: "prod",
              },
            });
          }),
        );

        const updated = yield* IAM.getOpenIDConnectProvider({
          OpenIDConnectProviderArn: provider.openIDConnectProviderArn,
        });
        expect(updated.ClientIDList ?? []).toContain("alchemy-client");
        expect(updated.ThumbprintList).toEqual([testOidcThumbprintB]);

        const tags = yield* IAM.listOpenIDConnectProviderTags({
          OpenIDConnectProviderArn: provider.openIDConnectProviderArn,
        });
        expect(
          Object.fromEntries(
            (tags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
          ),
        ).toMatchObject({
          env: "prod",
        });

        yield* stack.destroy();

        const deleted = yield* IAM.getOpenIDConnectProvider({
          OpenIDConnectProviderArn: provider.openIDConnectProviderArn,
        }).pipe(Effect.option);
        expect(deleted._tag).toBe("None");
      }),
  );

  // The GitHub Actions federation flagship: an OIDC provider plus a Role
  // whose trust policy federates to it with a repo-scoped `sub` condition.
  // The issuer is a stand-in (see fixtures.ts) — the account's real
  // token.actions.githubusercontent.com provider belongs to CI and IAM
  // allows only one provider per issuer URL — but the trust mechanics
  // (Federated principal + AssumeRoleWithWebIdentity + aud/sub conditions)
  // are identical.
  test.provider(
    "federates a role to a GitHub-Actions-style OIDC provider",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const outputs = yield* stack.deploy(
          Effect.gen(function* () {
            const oidc = yield* OpenIDConnectProvider("GithubStyleOidc", {
              url: testOidcGithubUrl,
              clientIDList: ["sts.amazonaws.com"],
              thumbprintList: [testOidcThumbprintA],
            });
            const role = yield* Role("GithubDeployRole", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: {
                      Federated: oidc.openIDConnectProviderArn,
                    },
                    Action: ["sts:AssumeRoleWithWebIdentity"],
                    Condition: {
                      StringEquals: {
                        [`${testOidcGithubHost}:aud`]: "sts.amazonaws.com",
                      },
                      StringLike: {
                        [`${testOidcGithubHost}:sub`]:
                          "repo:sam-goodwin/alchemy:*",
                      },
                    },
                  },
                ],
              },
            });
            return {
              providerArn: oidc.openIDConnectProviderArn,
              roleName: role.roleName,
              roleArn: role.roleArn,
            };
          }),
        );

        // Assert the trust document out-of-band from the live role.
        const live = yield* IAM.getRole({ RoleName: outputs.roleName });
        const trust = JSON.parse(
          decodeURIComponent(live.Role?.AssumeRolePolicyDocument ?? ""),
        ) as {
          Statement: [
            {
              Effect: string;
              Principal: { Federated: string };
              // IAM normalizes a single-element array to a bare string in
              // the stored document.
              Action: string | string[];
              Condition: Record<string, Record<string, string>>;
            },
          ];
        };
        expect(trust.Statement).toHaveLength(1);
        expect(trust.Statement[0].Effect).toBe("Allow");
        expect(trust.Statement[0].Principal.Federated).toBe(
          outputs.providerArn,
        );
        expect([trust.Statement[0].Action].flat()).toEqual([
          "sts:AssumeRoleWithWebIdentity",
        ]);
        expect(
          trust.Statement[0].Condition.StringEquals[
            `${testOidcGithubHost}:aud`
          ],
        ).toBe("sts.amazonaws.com");
        expect(
          trust.Statement[0].Condition.StringLike[`${testOidcGithubHost}:sub`],
        ).toBe("repo:sam-goodwin/alchemy:*");

        yield* stack.destroy();

        const deletedRole = yield* IAM.getRole({
          RoleName: outputs.roleName,
        }).pipe(Effect.option);
        expect(deletedRole._tag).toBe("None");
        const deletedProvider = yield* IAM.getOpenIDConnectProvider({
          OpenIDConnectProviderArn: outputs.providerArn,
        }).pipe(Effect.option);
        expect(deletedProvider._tag).toBe("None");
      }),
    { timeout: 120_000 },
  );

  test.provider("create, update, and delete a SAML provider", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SAMLProvider("SamlProvider", {
            name: testSamlProviderName,
            samlMetadataDocument: testSamlMetadataDocument,
            tags: {
              env: "test",
            },
          });
        }),
      );

      const created = yield* IAM.getSAMLProvider({
        SAMLProviderArn: provider.samlProviderArn,
      });
      expect(created.SAMLMetadataDocument).toContain("urn:alchemy:test:idp");

      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* SAMLProvider("SamlProvider", {
            name: testSamlProviderName,
            samlMetadataDocument: testSamlMetadataDocumentUpdated,
            tags: {
              env: "prod",
            },
          });
        }),
      );

      const updated = yield* IAM.getSAMLProvider({
        SAMLProviderArn: provider.samlProviderArn,
      });
      expect(updated.SAMLMetadataDocument).toContain(
        "urn:alchemy:test:idp:updated",
      );

      const tags = yield* IAM.listSAMLProviderTags({
        SAMLProviderArn: provider.samlProviderArn,
      });
      expect(
        Object.fromEntries(
          (tags.Tags ?? []).map((tag) => [tag.Key, tag.Value]),
        ),
      ).toMatchObject({
        env: "prod",
      });

      yield* stack.destroy();

      const deleted = yield* IAM.getSAMLProvider({
        SAMLProviderArn: provider.samlProviderArn,
      }).pipe(Effect.option);
      expect(deleted._tag).toBe("None");
    }),
  );
});
