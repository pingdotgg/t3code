import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export class BackgroundRelayConfigInvalid extends Schema.TaggedError<BackgroundRelayConfigInvalid>()(
  "BackgroundRelayConfigInvalid",
  {},
) {
  override get message(): string {
    return "Configure T3CODE_BACKGROUND_RELAY_URL and T3CODE_BACKGROUND_RELAY_ENVIRONMENT_CREDENTIAL together, using an HTTPS origin and a nonempty credential. The optional T3CODE_BACKGROUND_RELAY_ISSUER must also be an HTTPS origin.";
  }
}

export class BackgroundRelayConfig extends Context.Reference<{
  readonly url: string;
  readonly issuer: string;
  readonly environmentCredential: Redacted.Redacted<string>;
} | null>("t3/relay/BackgroundRelayConfig", { defaultValue: () => null }) {}

export const layer = Layer.effect(
  BackgroundRelayConfig,
  Effect.gen(function* () {
    const config = yield* Config.all({
      url: Config.String("T3CODE_BACKGROUND_RELAY_URL").pipe(Config.option),
      issuer: Config.String("T3CODE_BACKGROUND_RELAY_ISSUER").pipe(Config.option),
      environmentCredential: Config.Redacted("T3CODE_BACKGROUND_RELAY_ENVIRONMENT_CREDENTIAL").pipe(
        Config.option,
      ),
    });
    if (
      Option.isNone(config.url) &&
      Option.isNone(config.environmentCredential) &&
      Option.isNone(config.issuer)
    ) {
      return null;
    }
    const url = Option.isSome(config.url) ? normalizeSecureRelayUrl(config.url.value) : null;
    const issuer = Option.isSome(config.issuer)
      ? normalizeSecureRelayUrl(config.issuer.value)
      : url;
    if (
      !url ||
      !issuer ||
      Option.isNone(config.environmentCredential) ||
      !Redacted.value(config.environmentCredential.value).trim()
    ) {
      return yield* new BackgroundRelayConfigInvalid();
    }
    return { url, issuer, environmentCredential: config.environmentCredential.value };
  }),
);
