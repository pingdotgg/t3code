import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { expect } from "e2e";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { T3_HOME } from "../e2e.config.ts";
import { SECOND_HOME, startSecondServer } from "./second-server.ts";
import { makeState, rpcClient, runPromise, test, WEB } from "./t3.ts";

// A shell keeps an environment's 25 newest settled threads; older ones come from search.
const NEWER_SETTLED = 25;

const uuid = Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4());
const decodePairing = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);

const settle = Effect.fn("scenario.settle")(
  function* (home: string, origin: string, threadIds: ReadonlyArray<string>) {
    const client = yield* rpcClient(home, origin);
    for (const threadId of threadIds) {
      yield* client["orchestration.dispatchCommand"]({
        type: "thread.settle",
        commandId: CommandId.make(yield* uuid),
        threadId: ThreadId.make(threadId),
      });
    }
  },
  Effect.scoped,
  Effect.provide(NodeCrypto.layer),
);

/** Turns the Linked environments beta on for both servers and links the first to the second. */
const linkEnvironments = Effect.fn("scenario.linkEnvironments")(function* (
  primaryOrigin: string,
  secondOrigin: string,
) {
  const primary = yield* rpcClient(T3_HOME, primaryOrigin);
  const second = yield* rpcClient(SECOND_HOME, secondOrigin);
  for (const client of [primary, second]) {
    yield* client["server.updateSettings"]({ patch: { linkedEnvironmentsEnabled: true } });
  }
  const pairing = yield* makeState(SECOND_HOME).cli(["auth", "pairing", "create", "--json"]);
  const { credential } = yield* decodePairing(pairing.stdout);
  yield* primary["peerLinks.link"]({
    url: secondOrigin,
    pairingCode: credential,
    access: "approval-required",
  });
}, Effect.scoped);

test(
  "The @ picker finds an older settled thread on a linked machine",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("primary");
    const current = await t3.thread({ project, title: "Current work", messages: ["first"] });
    const server = startSecondServer(app.baseUrl ?? "");
    try {
      const { host, token } = await server.ready;
      await runPromise(linkEnvironments(app.baseUrl ?? "", host));
      const second = makeState(SECOND_HOME).state;
      const linkedProject = await second.project("linked");
      // Settled first, so the newer ones push it out of the linked machine's shell.
      const titles = [
        "Ancient design notes",
        ...Array.from({ length: NEWER_SETTLED }, (_, index) => `Newer ${index + 1}`),
      ];
      const threadIds: Array<string> = [];
      for (const title of titles) {
        threadIds.push(
          (await second.thread({ project: linkedProject, title, messages: ["first"] })).threadId,
        );
      }
      await runPromise(settle(SECOND_HOME, host, threadIds));

      await t3.open("/settings/connections");
      await screen.getByRole("button", "Add environment").tap();
      const dialog = screen.getByRole("dialog");
      await dialog.getByPlaceholder("backend.example.com").fill(host);
      await dialog.getByPlaceholder("PAIRCODE").fill(token);
      await dialog.getByRole("button", "Add environment").tap();
      await expect(screen.getByRole("button", "More actions for Scenario")).toBeVisible({
        timeout: 60_000,
      });

      await t3.open(current);
      await screen.getByRole("textbox").fill("@Ancient");
      try {
        await expect(
          screen.getByRole("option", "Ancient design notes Thread on Scenario", { exact: false }),
        ).toBeVisible();
      } finally {
        await app.screenshot("ancient-mention");
      }
    } finally {
      await server.stop();
    }
  },
);
