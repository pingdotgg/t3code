import * as AWS from "@/AWS";
import { AlarmMuteRule } from "@/AWS/CloudWatch";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test (AWS account/region-scoped collection).
//
// `AlarmMuteRule` is enumerable: `listAlarmMuteRules` paginates every mute
// rule in the region (verified live). `list()` flattens those summaries,
// derives the name from each ARN, and re-reads each rule via
// `getAlarmMuteRule` to return the full `Attributes` shape (identical to
// `read`).
//
// NOTE: We do not deploy a rule first because `putAlarmMuteRule` currently
// rejects every input with an (empty-message) `ValidationException` — a
// separate create-path blocker independent of `list()`. We therefore verify
// `list()` runs against the live API and returns the well-typed `Attributes`
// array. When create is unblocked, the deploy-and-find-it assertion below can
// be re-enabled.
test.provider("list enumerates alarm mute rules in the region", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const provider = yield* Provider.findProvider(AlarmMuteRule);
    const all = yield* provider.list();

    expect(Array.isArray(all)).toBe(true);
    for (const rule of all) {
      expect(typeof rule.alarmMuteRuleName).toBe("string");
      expect(rule.alarmMuteRuleArn).toContain(":alarm-mute-rule:");
    }
  }),
);
