import * as AWS from "@/AWS";
import { Role } from "@/AWS/IAM/Role.ts";
import { Bot, BotAlias, BotLocale, Intent, SlotType } from "@/AWS/LexV2";
import * as Test from "@/Test/Alchemy";
import * as lexm from "@distilled.cloud/aws/lex-models-v2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag the provider's read/observe paths depend on. Runs in every
// CI pass at near-zero cost.
test.provider(
  "describeBot on a nonexistent bot fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        lexm.describeBot({ botId: "BOGUSBOT01" }),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
);

const lexBotRole = Role("LexBotRole", {
  assumeRolePolicyDocument: {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: "lexv2.amazonaws.com" },
        Action: ["sts:AssumeRole"],
      },
    ],
  },
});

/** Deletion is asynchronous — verify the bot is fully gone out-of-band. */
const assertBotGone = (botId: string) =>
  Effect.gen(function* () {
    const status = yield* lexm.describeBot({ botId }).pipe(
      Effect.map((bot) => bot.botStatus ?? "unknown"),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed("gone" as const),
      ),
    );
    if (status !== "gone") {
      return yield* Effect.fail(
        new Error(`bot '${botId}' still exists (status: ${status})`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([
        Schedule.fixed("5 seconds"),
        Schedule.recurs(24),
      ]),
    }),
  );

test.provider(
  "bot + locale + slot type + intent + alias lifecycle (create, update, destroy)",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // ---- create ----
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* lexBotRole;
          const bot = yield* Bot("TestBot", {
            roleArn: role.roleArn,
            description: "alchemy lex test bot",
            idleSessionTTL: "300 seconds",
            tags: { fixture: "lexv2-bot" },
          });
          const locale = yield* BotLocale("En", {
            botId: bot.botId,
            localeId: "en_US",
            nluIntentConfidenceThreshold: 0.4,
          });
          const size = yield* SlotType("Size", {
            botId: locale.botId,
            localeId: locale.localeId,
            slotTypeValues: [
              { value: "small", synonyms: ["tiny"] },
              { value: "large", synonyms: ["big"] },
            ],
            resolutionStrategy: "TopResolution",
          });
          const greet = yield* Intent("Greet", {
            botId: size.botId,
            localeId: size.localeId,
            sampleUtterances: ["hello", "hi"],
            description: "greets the user",
          });
          const alias = yield* BotAlias("Staging", {
            botId: greet.botId,
            description: "unassociated staging alias",
            tags: { fixture: "lexv2-alias" },
          });
          return { bot, locale, size, greet, alias };
        }),
      );

      expect(created.bot.botId).toBeDefined();
      expect(created.bot.botArn).toContain(":bot/");
      expect(created.bot.botStatus).toBe("Available");
      expect(created.locale.localeId).toBe("en_US");
      expect(created.locale.botVersion).toBe("DRAFT");
      expect(created.size.slotTypeId).toBeDefined();
      expect(created.greet.intentId).toBeDefined();
      expect(created.alias.botAliasId).toBeDefined();
      expect(created.alias.botAliasArn).toContain(":bot-alias/");
      expect(created.alias.botAliasStatus).toBe("Available");

      // Out-of-band verification via distilled.
      const bot = yield* lexm.describeBot({ botId: created.bot.botId });
      expect(bot.botStatus).toBe("Available");
      expect(bot.description).toBe("alchemy lex test bot");
      const intent = yield* lexm.describeIntent({
        botId: created.bot.botId,
        botVersion: "DRAFT",
        localeId: "en_US",
        intentId: created.greet.intentId,
      });
      expect(
        (intent.sampleUtterances ?? []).map((u) => u.utterance).sort(),
      ).toEqual(["hello", "hi"]);
      const slotType = yield* lexm.describeSlotType({
        botId: created.bot.botId,
        botVersion: "DRAFT",
        localeId: "en_US",
        slotTypeId: created.size.slotTypeId,
      });
      expect(slotType.valueSelectionSetting?.resolutionStrategy).toBe(
        "TopResolution",
      );
      const tags = yield* lexm.listTagsForResource({
        resourceARN: created.bot.botArn,
      });
      expect(tags.tags?.fixture).toBe("lexv2-bot");
      expect(tags.tags?.["alchemy::id"]).toBe("TestBot");

      // ---- update in place (same identities) ----
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const role = yield* lexBotRole;
          const bot = yield* Bot("TestBot", {
            roleArn: role.roleArn,
            description: "alchemy lex test bot (updated)",
            idleSessionTTL: "10 minutes",
            tags: { fixture: "lexv2-bot", pass: "two" },
          });
          const locale = yield* BotLocale("En", {
            botId: bot.botId,
            localeId: "en_US",
            nluIntentConfidenceThreshold: 0.5,
          });
          const size = yield* SlotType("Size", {
            botId: locale.botId,
            localeId: locale.localeId,
            slotTypeValues: [
              { value: "small", synonyms: ["tiny"] },
              { value: "medium" },
              { value: "large", synonyms: ["big"] },
            ],
            resolutionStrategy: "TopResolution",
          });
          const greet = yield* Intent("Greet", {
            botId: size.botId,
            localeId: size.localeId,
            sampleUtterances: ["hello", "hi", "good morning"],
            description: "greets the user politely",
            dialogCodeHook: true,
            fulfillmentCodeHook: true,
          });
          const alias = yield* BotAlias("Staging", {
            botId: greet.botId,
            description: "still unassociated",
            tags: { fixture: "lexv2-alias" },
          });
          return { bot, locale, size, greet, alias };
        }),
      );

      // Identities are stable across the update.
      expect(updated.bot.botId).toBe(created.bot.botId);
      expect(updated.greet.intentId).toBe(created.greet.intentId);
      expect(updated.size.slotTypeId).toBe(created.size.slotTypeId);
      expect(updated.alias.botAliasId).toBe(created.alias.botAliasId);

      const updatedBot = yield* lexm.describeBot({ botId: updated.bot.botId });
      expect(updatedBot.description).toBe("alchemy lex test bot (updated)");
      expect(updatedBot.idleSessionTTLInSeconds).toBe(600);
      const updatedLocale = yield* lexm.describeBotLocale({
        botId: updated.bot.botId,
        botVersion: "DRAFT",
        localeId: "en_US",
      });
      expect(updatedLocale.nluIntentConfidenceThreshold).toBe(0.5);
      const updatedIntent = yield* lexm.describeIntent({
        botId: updated.bot.botId,
        botVersion: "DRAFT",
        localeId: "en_US",
        intentId: updated.greet.intentId,
      });
      expect(
        (updatedIntent.sampleUtterances ?? []).map((u) => u.utterance),
      ).toContain("good morning");
      // Code hook flags synced onto the DRAFT intent by the update.
      expect(updatedIntent.dialogCodeHook?.enabled).toBe(true);
      expect(updatedIntent.fulfillmentCodeHook?.enabled).toBe(true);
      const updatedTags = yield* lexm.listTagsForResource({
        resourceARN: updated.bot.botArn,
      });
      expect(updatedTags.tags?.pass).toBe("two");

      // ---- destroy + typed wait-until-gone ----
      yield* stack.destroy();
      yield* assertBotGone(created.bot.botId);
    }),
  // Observed ~15s live; headroom for slow deletes and the wait-until-gone.
  { timeout: 180_000 },
);
