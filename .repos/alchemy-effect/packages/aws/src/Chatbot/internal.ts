import type * as chatbot from "@distilled.cloud/aws/chatbot";
import { Region, type RegionName } from "@distilled.cloud/aws/Region";
import type { SourceError } from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * AWS Chatbot has endpoints only in these regions (there is no
 * `chatbot.{region}.amazonaws.com` anywhere else). Chat configurations are
 * global (their ARNs carry no region), so any supported endpoint sees the
 * same data. The providers and bindings follow the ambient region when it is
 * supported and use `us-east-2` otherwise.
 *
 * @internal
 */
const CHATBOT_REGIONS: ReadonlySet<string> = new Set([
  "us-east-2",
  "us-west-2",
  "eu-west-1",
  "ap-southeast-1",
]);

const CHATBOT_HOME_REGION: RegionName = "us-east-2";

/**
 * Run a distilled Chatbot effect in a supported region: the ambient region
 * when Chatbot is offered there, otherwise `us-east-2`. A missing `Region`
 * (distilled treats it as an optional override) also falls back to
 * `us-east-2`, so the helper adds no requirement.
 *
 * `Region`'s service value is an `Effect<RegionName>`, so it is provided as
 * an effect, not a bare string.
 *
 * @internal
 */
export const inChatbotRegion = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SourceError, R> =>
  Effect.gen(function* () {
    const ambient = yield* Effect.serviceOption(Region);
    // No region configured falls back to the home region too.
    const region = Option.isSome(ambient)
      ? yield* ambient.value.pipe(
          Effect.catchTag("Alchemy::AWS::MissingRegion", () => Effect.undefined),
        )
      : undefined;
    return region !== undefined && CHATBOT_REGIONS.has(region)
      ? yield* effect
      : yield* effect.pipe(Effect.provideService(Region, Effect.succeed(CHATBOT_HOME_REGION)));
  });

/**
 * Convert a plain tag map to the Chatbot wire `Tag` list
 * (`{ TagKey, TagValue }`).
 */
export const toChatbotTags = (tags: Record<string, string>): chatbot.Tag[] =>
  Object.entries(tags).map(([TagKey, TagValue]) => ({ TagKey, TagValue }));

/**
 * Convert an observed Chatbot wire `Tag` list to a plain tag map.
 */
export const fromChatbotTags = (tags: readonly chatbot.Tag[] | undefined): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.TagKey, t.TagValue]));
