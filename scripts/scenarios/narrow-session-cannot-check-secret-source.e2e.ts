/// <reference lib="dom" />
import {
  AuthProvidersManageScope,
  AuthStandardClientScopes,
  SecretProviderId,
  SecretProviderKind,
} from "@t3tools/contracts";
import { expect } from "e2e";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { environmentId, makeState, rpcClient, runPromise, signIn, test, WEB } from "./t3.ts";

const PROVIDER = SecretProviderId.make("scenario");
const UI_REFERENCE = "op://Scenario/GitHub/ui";
// Named only in the direct call, so a read of it can come from nothing else.
const RPC_REFERENCE = "op://Scenario/GitHub/rpc";
const OP_CALLS = `${T3_HOME}/op-calls.txt`;
const OP_BIN = `${T3_HOME}/bin/op`;
const NARROW_SCOPES = AuthStandardClientScopes.filter(
  (scope) => scope !== AuthProvidersManageScope,
);

const decodePairing = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);

const opCalls = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.exists(OP_CALLS)) ? yield* fs.readFileString(OP_CALLS) : "";
});

/** Browser cookies for a pairing credential holding every standard scope but providers:manage. */
const narrowBrowserCookies = Effect.fn("scenario.narrowBrowserCookies")(function* (
  baseUrl: string,
) {
  const issued = yield* makeState(T3_HOME).cli([
    "auth",
    "pairing",
    "create",
    "--json",
    "--label",
    "narrow",
    ...NARROW_SCOPES.flatMap((scope) => ["--scope", scope]),
  ]);
  const { credential } = yield* decodePairing(issued.stdout);
  return yield* signIn(baseUrl, credential);
});

/** `server.checkSecretSource` sent over a WebSocket signed in with the narrow scopes. */
const narrowCheck = Effect.fn("scenario.narrowCheck")(function* (origin: string) {
  const client = yield* rpcClient(T3_HOME, origin, NARROW_SCOPES);
  return yield* client["server.checkSecretSource"]({
    source: { provider: PROVIDER, reference: RPC_REFERENCE },
  }).pipe(
    Effect.map((result) => `answered ${result._tag}`),
    Effect.catch((error) =>
      Effect.succeed(
        error._tag === "EnvironmentAuthorizationError"
          ? `refused: needs ${error.requiredPermission ?? error.requiredScope}`
          : `failed: ${String(error)}`,
      ),
    ),
  );
});

test(
  "A session without providers:manage cannot check a secret source",
  WEB,
  async ({ app, browser, screen }) => {
    const origin = app.baseUrl ?? "";
    const environment = await runPromise(environmentId(origin));
    const before = await runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The home outlives an attempt; a retry must not see the last attempt's reads.
        yield* fs.remove(OP_CALLS, { force: true });
        const op = (yield* fs.exists(OP_BIN)) ? yield* fs.readFile(OP_BIN) : undefined;
        yield* fs.writeFileString(
          OP_BIN,
          `#!/bin/sh\necho "$*" >> "${OP_CALLS}"\nprintf scenario-secret\n`,
        );
        yield* fs.chmod(OP_BIN, 0o755);
        const client = yield* rpcClient(T3_HOME, origin);
        const settings = yield* client["server.getSettings"]({});
        yield* client["server.updateSettings"]({
          patch: {
            secretProviders: {
              [PROVIDER]: {
                kind: SecretProviderKind.make("one_password"),
                label: "Scenario",
                config: { account: "scenario" },
              },
            },
            sourceControlHosts: {
              github: {
                tokens: { "github.com": { provider: PROVIDER, reference: UI_REFERENCE } },
              },
            },
          },
        });
        return {
          op,
          provider: settings.secretProviders[PROVIDER],
          githubTokens: settings.sourceControlHosts.github?.tokens,
        };
      }).pipe(Effect.scoped),
    );
    // The server and home outlive this test, so the next one gets them back as they were.
    const restore = () =>
      runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(OP_CALLS, { force: true });
          if (before.op === undefined) {
            yield* fs.remove(OP_BIN, { force: true });
          } else {
            yield* fs.writeFile(OP_BIN, before.op);
          }
          const client = yield* rpcClient(T3_HOME, origin);
          yield* client["server.updateSettings"]({
            patch: {
              sourceControlHosts: { github: { tokens: before.githubTokens ?? {} } },
              secretProviders: { [PROVIDER]: before.provider ?? null },
            },
          });
        }).pipe(Effect.scoped),
      );
    try {
      // The server is the boundary: ask it directly with the narrow session.
      const direct = await runPromise(narrowCheck(origin).pipe(Effect.scoped));
      const readByDirectCall = (await runPromise(opCalls)).includes(RPC_REFERENCE);

      await browser.setCookies(await runPromise(narrowBrowserCookies(origin)));
      await app.open(`/settings/source-control?machine=${encodeURIComponent(environment)}`);
      // Enabled only once the session has loaded with settings:write, so a disabled check
      // below means the missing providers:manage, not a session still loading. A cold
      // machine's first source control scan can outlast the default wait.
      await expect(
        screen.getByRole("switch", "Offer GitHub when adding or publishing a project", {
          exact: true,
        }),
      ).toBeEnabled({ timeout: 60_000 });
      await screen.getByRole("button", "Toggle GitHub details", { exact: true }).tap();
      const check = screen.getByRole("button", "Check GitHub token", { exact: true });
      await expect(check).toBeVisible();
      const uiReads = async () =>
        (await runPromise(opCalls)).split("\n").filter((line) => line.includes(UI_REFERENCE))
          .length;
      const readsBefore = await uiReads();
      const checkable = await check.isEnabled();
      if (checkable) {
        await check.tap();
        await expect(browser.locator('[aria-label^="Check GitHub token "]')).toBeVisible();
      }
      await browser.evaluate(() => {
        document
          .querySelector('[aria-label="Toggle GitHub details"]')
          ?.scrollIntoView({ block: "start" });
        return null;
      });
      await app.screenshot("check-button-narrow-session");
      const readsByButton = (await uiReads()) - readsBefore;

      expect(
        readByDirectCall,
        `The narrow session's direct check never ran op (op calls: ${await runPromise(opCalls)})`,
      ).toBe(false);
      expect(direct, "The server refuses the narrow session's check").toBe(
        "refused: needs providers:manage",
      );
      expect(
        checkable,
        `The check button is disabled for the narrow session (its click ran op ${readsByButton} times)`,
      ).toBe(false);
    } finally {
      await restore();
    }
  },
);
