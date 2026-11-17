import {
  BROWSER_LOGIN_FIELDS,
  BrowserLoginError,
  type BrowserLoginsCheckResult,
  type BrowserLoginsListVaultsResult,
  type BrowserLoginsSettings,
  type SecretProviderId,
  type BrowserLoginErrorReason,
  type BrowserLoginField,
  type BrowserLoginsList,
} from "@t3tools/contracts";
import type {
  SecretProviderDriver,
  SecretProviderDriverServices,
  SecretProviderLogins,
  SecretProviderLoginsError,
} from "@t3tools/secret-provider-core/server/driver";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { BUILT_IN_SECRET_PROVIDER_DRIVER_LIST } from "../secrets/secretProviderDefinitions.ts";
import * as Settings from "../serverSettings.ts";

export class BrowserLogins extends Context.Service<
  BrowserLogins,
  {
    /** Logins in the configured vault for the page's exact origin. Never reads a value. */
    readonly list: (input: {
      readonly tabUrl: string;
    }) => Effect.Effect<BrowserLoginsList, BrowserLoginError>;
    /**
     * Reads one field fresh, never cached, after checking the item is in the configured vault and
     * belongs to `origin`. Only a page fill may call this; the value must not leave the server.
     */
    readonly secretFor: (input: {
      readonly itemId: string;
      readonly field: BrowserLoginField;
      readonly origin: string;
    }) => Effect.Effect<Redacted.Redacted<string>, BrowserLoginError>;
    /** Vault names in a secret provider's account, for choosing one. Metadata only. */
    readonly vaults: (input: {
      readonly provider: SecretProviderId;
    }) => Effect.Effect<BrowserLoginsListVaultsResult, BrowserLoginError>;
    /** How many logins a provider and vault hold, from listing alone. Saves nothing. */
    readonly check: (
      input: BrowserLoginsSettings,
    ) => Effect.Effect<BrowserLoginsCheckResult, BrowserLoginError>;
  }
>()("t3/browserLogins/BrowserLogins") {}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The origin a login may fill: https, or http on loopback. A bare host is https, as in 1Password. */
const loginOrigin = (url: string): string | undefined => {
  const parsed = URL.parse(url.includes("://") ? url : `https://${url}`);
  if (parsed === null) return undefined;
  if (parsed.protocol === "https:") return parsed.origin;
  if (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed.origin;
  return undefined;
};

export const loginMatchesOrigin = (urls: ReadonlyArray<string>, origin: string) =>
  loginOrigin(origin) === origin && urls.some((url) => loginOrigin(url) === origin);

const fail = (reason: BrowserLoginErrorReason) => Effect.fail(new BrowserLoginError({ reason }));

const fromDriver = (error: SecretProviderLoginsError) =>
  fail(error.reason === "unavailable" ? "providerUnavailable" : error.reason);

export const make = Effect.fn("BrowserLogins.make")(function* (options: {
  readonly drivers: ReadonlyArray<SecretProviderDriver>;
}) {
  const settingsService = yield* Settings.ServerSettingsService;
  const context = yield* Effect.context<SecretProviderDriverServices>();

  const providerFor = Effect.fn("BrowserLogins.providerFor")(function* (id: SecretProviderId) {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catch(() => fail("notConfigured")),
    );
    const provider = Object.hasOwn(settings.secretProviders, id)
      ? settings.secretProviders[id]
      : undefined;
    if (provider === undefined) return yield* fail("notConfigured");
    const driver = options.drivers.find((candidate) => candidate.kind === provider.kind);
    const logins: SecretProviderLogins | undefined = driver?.logins;
    if (driver === undefined || logins === undefined) return yield* fail("providerUnsupported");
    return { driver, logins, config: provider.config };
  });

  const configured = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.catch(() => fail("notConfigured")),
    );
    const browserLogins = settings.browserLogins;
    if (browserLogins === undefined) return yield* fail("notConfigured");
    return { ...(yield* providerFor(browserLogins.provider)), vault: browserLogins.vault };
  });

  const list: BrowserLogins["Service"]["list"] = Effect.fn("BrowserLogins.list")(function* ({
    tabUrl,
  }) {
    const origin = loginOrigin(tabUrl);
    const { logins, config, vault } = yield* configured;
    if (origin === undefined || URL.parse(tabUrl)?.origin !== origin) {
      return { origin: null, logins: [] };
    }
    const items = yield* logins.list(config, vault).pipe(Effect.catch(fromDriver));
    const matching = items.filter((item) => loginMatchesOrigin(item.urls, origin));
    // Which fields exist is per item, so only the page's own logins are read in full.
    const details = yield* Effect.forEach(matching, (item) =>
      logins.get(config, vault, item.id).pipe(Effect.catch(fromDriver)),
    );
    return {
      origin,
      logins: details.map((detail) => ({
        id: detail.id,
        title: detail.title,
        urls: [...detail.urls],
        fields: BROWSER_LOGIN_FIELDS.filter((field) => detail.fields[field] !== undefined),
      })),
    };
  }, Effect.provideContext(context));

  const secretFor: BrowserLogins["Service"]["secretFor"] = Effect.fn("BrowserLogins.secretFor")(
    function* ({ itemId, field, origin }) {
      const { driver, logins, config, vault } = yield* configured;
      const detail = yield* logins.get(config, vault, itemId).pipe(Effect.catch(fromDriver));
      if (!loginMatchesOrigin(detail.urls, origin)) return yield* fail("originMismatch");
      const reference = detail.fields[field];
      if (reference === undefined) return yield* fail("fieldMissing");
      const [value] = yield* driver.read(config, [reference]);
      if (value === undefined) return yield* fail("providerUnavailable");
      return Redacted.make(value);
    },
    Effect.provideContext(context),
  );

  const vaults: BrowserLogins["Service"]["vaults"] = Effect.fn("BrowserLogins.vaults")(function* ({
    provider,
  }) {
    const { logins, config } = yield* providerFor(provider);
    const listed = yield* logins.vaults(config).pipe(Effect.catch(fromDriver));
    return {
      vaults: Option.isSome(listed) ? listed.value.map(({ id, name }) => ({ id, name })) : null,
    };
  }, Effect.provideContext(context));

  const check: BrowserLogins["Service"]["check"] = Effect.fn("BrowserLogins.check")(function* ({
    provider,
    vault,
  }) {
    const { logins, config } = yield* providerFor(provider);
    const items = yield* logins.list(config, vault).pipe(Effect.catch(fromDriver));
    return { logins: items.length };
  }, Effect.provideContext(context));

  return BrowserLogins.of({ list, secretFor, vaults, check });
});

export const layer = Layer.effect(
  BrowserLogins,
  make({ drivers: BUILT_IN_SECRET_PROVIDER_DRIVER_LIST }),
);
