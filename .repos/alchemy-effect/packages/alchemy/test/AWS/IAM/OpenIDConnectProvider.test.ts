import * as AWS from "@/AWS";
import { OpenIDConnectProvider } from "@/AWS/IAM";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as IAM from "@distilled.cloud/aws/iam";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { testOidcListUrl, testOidcThumbprintA } from "./fixtures.ts";

const { test } = Test.make({ providers: AWS.providers() });

// A distinct issuer URL for the #736 recovery test — the OIDC provider ARN is
// deterministic from the URL, so sharing a URL with another test would make
// two tests provision (and tear down) the same physical provider.
const testOidcWedgedUrl = "https://example.com/alchemy-oidc-wedged";

describe("AWS.IAM.OpenIDConnectProvider", () => {
  test.provider(
    "list enumerates the deployed OpenID Connect provider",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* OpenIDConnectProvider("ListOidcProvider", {
              url: testOidcListUrl,
              clientIDList: ["sts.amazonaws.com"],
              thumbprintList: [testOidcThumbprintA],
              tags: {
                env: "test",
              },
            });
          }),
        );

        const provider = yield* Provider.findProvider(OpenIDConnectProvider);
        const all = yield* provider.list();

        expect(
          all.some(
            (p) =>
              p.openIDConnectProviderArn === deployed.openIDConnectProviderArn,
          ),
        ).toBe(true);

        const found = all.find(
          (p) =>
            p.openIDConnectProviderArn === deployed.openIDConnectProviderArn,
        );
        expect(found?.url).toBe(testOidcListUrl.replace(/^https?:\/\//, ""));
        expect(found?.clientIDList ?? []).toContain("sts.amazonaws.com");

        yield* stack.destroy();

        const deleted = yield* IAM.getOpenIDConnectProvider({
          OpenIDConnectProviderArn: deployed.openIDConnectProviderArn,
        }).pipe(Effect.option);
        expect(deleted._tag).toBe("None");
      }),
  );

  test.provider(
    "recovers a half-created provider whose creating-state lost Output-valued props (#736)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployProvider = () =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* OpenIDConnectProvider("WedgedOidcProvider", {
                url: testOidcWedgedUrl,
                clientIDList: ["sts.amazonaws.com"],
                thumbprintList: [testOidcThumbprintA],
              });
            }),
          );

        const created = yield* deployProvider();

        // Rewrite the provider's persisted row into the wedged shape an
        // interrupted deploy leaves behind: `creating`, no attributes, and
        // the Output-valued `url` prop lost in the round-trip.
        const state = yield* yield* State;
        const stage = "test"; // scratch stacks default to the "test" stage
        const fqns = yield* state.list({ stack: stack.name, stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state
            .get({ stack: stack.name, stage, fqn })
            .pipe(Effect.map((row) => ({ fqn, row }))),
        );
        const wedged = rows.find(
          (r): r is { fqn: string; row: ResourceState } =>
            isResourceState(r.row) &&
            r.row.resourceType === "AWS.IAM.OpenIDConnectProvider",
        );
        if (!wedged) {
          return yield* Effect.die(
            new Error(
              "no AWS.IAM.OpenIDConnectProvider state row found after deploy",
            ),
          );
        }
        yield* state.set({
          stack: stack.name,
          stage,
          fqn: wedged.fqn,
          value: {
            ...wedged.row,
            status: "creating",
            attr: undefined,
            props: {
              ...wedged.row.props,
              url: undefined,
            },
          },
        });

        // Before the fix this crashed in `read` with
        // `TypeError: undefined is not an object (evaluating 'url.replace')`.
        const recovered = yield* deployProvider();
        expect(recovered.openIDConnectProviderArn).toEqual(
          created.openIDConnectProviderArn,
        );
        expect(recovered.url).toEqual(created.url);

        yield* stack.destroy();

        const deleted = yield* IAM.getOpenIDConnectProvider({
          OpenIDConnectProviderArn: created.openIDConnectProviderArn,
        }).pipe(Effect.option);
        expect(deleted._tag).toBe("None");
      }),
    { timeout: 240_000 },
  );
});
