import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { Account, AccountProvider } from "./Account.ts";
import {
  AccountExternalAccount,
  AccountExternalAccountProvider,
} from "./AccountExternalAccount.ts";
import { AccountPerson, AccountPersonProvider } from "./AccountPerson.ts";
import { Alert, AlertProvider } from "./Alert.ts";
import { ApplePayDomain, ApplePayDomainProvider } from "./ApplePayDomain.ts";
import { AppsSecret, AppsSecretProvider } from "./AppsSecret.ts";
import { StripeAuth } from "./AuthProvider.ts";
import { BillingMeter, BillingMeterProvider } from "./BillingMeter.ts";
import {
  BillingPortalConfiguration,
  BillingPortalConfigurationProvider,
} from "./BillingPortalConfiguration.ts";
import { Coupon, CouponProvider } from "./Coupon.ts";
import { CreateAccountHttp } from "./CreateAccountHttp.ts";
import { CreateAccountLinkHttp } from "./CreateAccountLinkHttp.ts";
import { CreateAppsSecretHttp } from "./CreateAppsSecretHttp.ts";
import { CreateCreditGrantHttp } from "./CreateCreditGrantHttp.ts";
import { CreateCustomerHttp } from "./CreateCustomerHttp.ts";
import { CreateFileLinkHttp } from "./CreateFileLinkHttp.ts";
import { CreateIssuingCardHttp } from "./CreateIssuingCardHttp.ts";
import { CreateIssuingCardholderHttp } from "./CreateIssuingCardholderHttp.ts";
import { CreateTerminalReaderHttp } from "./CreateTerminalReaderHttp.ts";
import { CreditGrant, CreditGrantProvider } from "./CreditGrant.ts";
import * as Credentials from "./Credentials.ts";
import { Customer, CustomerProvider } from "./Customer.ts";
import { CustomerTaxId, CustomerTaxIdProvider } from "./CustomerTaxId.ts";
import {
  EntitlementsFeature,
  EntitlementsFeatureProvider,
} from "./EntitlementsFeature.ts";
import { FileLink, FileLinkProvider } from "./FileLink.ts";
import { IssuingCard, IssuingCardProvider } from "./IssuingCard.ts";
import {
  IssuingCardholder,
  IssuingCardholderProvider,
} from "./IssuingCardholder.ts";
import {
  IssuingPersonalizationDesign,
  IssuingPersonalizationDesignProvider,
} from "./IssuingPersonalizationDesign.ts";
import { PaymentLink, PaymentLinkProvider } from "./PaymentLink.ts";
import {
  PaymentMethodConfiguration,
  PaymentMethodConfigurationProvider,
} from "./PaymentMethodConfiguration.ts";
import {
  PaymentMethodDomain,
  PaymentMethodDomainProvider,
} from "./PaymentMethodDomain.ts";
import { Plan, PlanProvider } from "./Plan.ts";
import { Price, PriceProvider } from "./Price.ts";
import { Product, ProductProvider } from "./Product.ts";
import { ProductFeature, ProductFeatureProvider } from "./ProductFeature.ts";
import { PromotionCode, PromotionCodeProvider } from "./PromotionCode.ts";
import { RadarValueList, RadarValueListProvider } from "./RadarValueList.ts";
import {
  RadarValueListItem,
  RadarValueListItemProvider,
} from "./RadarValueListItem.ts";
import {
  RestrictedApiKey,
  RestrictedApiKeyProvider,
} from "./RestrictedApiKey.ts";
import { RetrieveAccountExternalAccountHttp } from "./RetrieveAccountExternalAccountHttp.ts";
import { RetrieveAccountHttp } from "./RetrieveAccountHttp.ts";
import { RetrieveAccountPersonHttp } from "./RetrieveAccountPersonHttp.ts";
import { RetrieveAlertHttp } from "./RetrieveAlertHttp.ts";
import { RetrieveApplePayDomainHttp } from "./RetrieveApplePayDomainHttp.ts";
import { RetrieveAppsSecretHttp } from "./RetrieveAppsSecretHttp.ts";
import { RetrieveBillingMeterHttp } from "./RetrieveBillingMeterHttp.ts";
import { RetrieveBillingPortalConfigurationHttp } from "./RetrieveBillingPortalConfigurationHttp.ts";
import { RetrieveCouponHttp } from "./RetrieveCouponHttp.ts";
import { RetrieveCreditGrantHttp } from "./RetrieveCreditGrantHttp.ts";
import { RetrieveCustomerHttp } from "./RetrieveCustomerHttp.ts";
import { RetrieveCustomerTaxIdHttp } from "./RetrieveCustomerTaxIdHttp.ts";
import { RetrieveEntitlementsFeatureHttp } from "./RetrieveEntitlementsFeatureHttp.ts";
import { RetrieveFileLinkHttp } from "./RetrieveFileLinkHttp.ts";
import { RetrieveIssuingCardHttp } from "./RetrieveIssuingCardHttp.ts";
import { RetrieveIssuingCardholderHttp } from "./RetrieveIssuingCardholderHttp.ts";
import { RetrieveIssuingPersonalizationDesignHttp } from "./RetrieveIssuingPersonalizationDesignHttp.ts";
import { RetrievePaymentLinkHttp } from "./RetrievePaymentLinkHttp.ts";
import { RetrievePaymentMethodConfigurationHttp } from "./RetrievePaymentMethodConfigurationHttp.ts";
import { RetrievePaymentMethodDomainHttp } from "./RetrievePaymentMethodDomainHttp.ts";
import { RetrievePlanHttp } from "./RetrievePlanHttp.ts";
import { RetrievePriceHttp } from "./RetrievePriceHttp.ts";
import { RetrieveProductFeatureHttp } from "./RetrieveProductFeatureHttp.ts";
import { RetrieveProductHttp } from "./RetrieveProductHttp.ts";
import { RetrievePromotionCodeHttp } from "./RetrievePromotionCodeHttp.ts";
import { RetrieveRadarValueListHttp } from "./RetrieveRadarValueListHttp.ts";
import { RetrieveRadarValueListItemHttp } from "./RetrieveRadarValueListItemHttp.ts";
import { RetrieveShippingRateHttp } from "./RetrieveShippingRateHttp.ts";
import { RetrieveTaxRateHttp } from "./RetrieveTaxRateHttp.ts";
import { RetrieveTaxRegistrationHttp } from "./RetrieveTaxRegistrationHttp.ts";
import { RetrieveTaxSettingsHttp } from "./RetrieveTaxSettingsHttp.ts";
import { RetrieveTerminalConfigurationHttp } from "./RetrieveTerminalConfigurationHttp.ts";
import { RetrieveTerminalLocationHttp } from "./RetrieveTerminalLocationHttp.ts";
import { RetrieveTerminalReaderHttp } from "./RetrieveTerminalReaderHttp.ts";
import { RetrieveWebhookEndpointHttp } from "./RetrieveWebhookEndpointHttp.ts";
import { ShippingRate, ShippingRateProvider } from "./ShippingRate.ts";
import { TaxRate, TaxRateProvider } from "./TaxRate.ts";
import { TaxRegistration, TaxRegistrationProvider } from "./TaxRegistration.ts";
import { TaxSettings, TaxSettingsProvider } from "./TaxSettings.ts";
import {
  TerminalConfiguration,
  TerminalConfigurationProvider,
} from "./TerminalConfiguration.ts";
import {
  TerminalLocation,
  TerminalLocationProvider,
} from "./TerminalLocation.ts";
import { TerminalReader, TerminalReaderProvider } from "./TerminalReader.ts";
import { UpdateAccountHttp } from "./UpdateAccountHttp.ts";
import { UpdateCreditGrantHttp } from "./UpdateCreditGrantHttp.ts";
import { UpdateCustomerHttp } from "./UpdateCustomerHttp.ts";
import { UpdateFileLinkHttp } from "./UpdateFileLinkHttp.ts";
import { UpdateIssuingCardHttp } from "./UpdateIssuingCardHttp.ts";
import { UpdateIssuingCardholderHttp } from "./UpdateIssuingCardholderHttp.ts";
import { UpdateTaxSettingsHttp } from "./UpdateTaxSettingsHttp.ts";
import { UpdateTerminalReaderHttp } from "./UpdateTerminalReaderHttp.ts";
import { WebhookEndpoint, WebhookEndpointProvider } from "./WebhookEndpoint.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "Stripe",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Build a layer that registers all Stripe resource providers, the Stripe
 * `AuthProvider`, the resolved `Credentials`, and an `HttpClient`. Include
 * this from your stack alongside other cloud `providers()` layers.
 *
 * Resource providers are inserted into {@link Provider.collection} as they
 * land.
 *
 * @example
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as Stripe from "alchemy/Stripe";
 * import * as Effect from "effect/Effect";
 *
 * export default Alchemy.Stack(
 *   "MyStack",
 *   {
 *     providers: Stripe.providers(),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     return {};
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Account,
      AccountExternalAccount,
      AccountPerson,
      Alert,
      ApplePayDomain,
      AppsSecret,
      BillingMeter,
      BillingPortalConfiguration,
      Coupon,
      CreditGrant,
      Customer,
      CustomerTaxId,
      EntitlementsFeature,
      FileLink,
      IssuingCard,
      IssuingCardholder,
      IssuingPersonalizationDesign,
      PaymentLink,
      PaymentMethodConfiguration,
      PaymentMethodDomain,
      Plan,
      Price,
      Product,
      ProductFeature,
      PromotionCode,
      RadarValueList,
      RadarValueListItem,
      RestrictedApiKey,
      ShippingRate,
      TaxRate,
      TaxRegistration,
      TaxSettings,
      TerminalConfiguration,
      TerminalLocation,
      TerminalReader,
      WebhookEndpoint,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AccountProvider(),
        AccountExternalAccountProvider(),
        AccountPersonProvider(),
        AlertProvider(),
        ApplePayDomainProvider(),
        AppsSecretProvider(),
        BillingMeterProvider(),
        BillingPortalConfigurationProvider(),
        CouponProvider(),
        CreditGrantProvider(),
        CustomerProvider(),
        CustomerTaxIdProvider(),
        EntitlementsFeatureProvider(),
        FileLinkProvider(),
        IssuingCardProvider(),
        IssuingCardholderProvider(),
        IssuingPersonalizationDesignProvider(),
        PaymentLinkProvider(),
        PaymentMethodConfigurationProvider(),
        PaymentMethodDomainProvider(),
        PlanProvider(),
        PriceProvider(),
        ProductProvider(),
        ProductFeatureProvider(),
        PromotionCodeProvider(),
        RadarValueListProvider(),
        RadarValueListItemProvider(),
        RestrictedApiKeyProvider(),
        ShippingRateProvider(),
        TaxRateProvider(),
        TaxRegistrationProvider(),
        TaxSettingsProvider(),
        TerminalConfigurationProvider(),
        TerminalLocationProvider(),
        TerminalReaderProvider(),
        WebhookEndpointProvider(),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        CreateAccountHttp,
        CreateAccountLinkHttp,
        CreateAppsSecretHttp,
        CreateCreditGrantHttp,
        CreateCustomerHttp,
        CreateFileLinkHttp,
        CreateIssuingCardHttp,
        CreateIssuingCardholderHttp,
        CreateTerminalReaderHttp,
        RetrieveAccountExternalAccountHttp,
        RetrieveAccountHttp,
        RetrieveAccountPersonHttp,
        RetrieveAlertHttp,
        RetrieveApplePayDomainHttp,
        RetrieveAppsSecretHttp,
        RetrieveBillingMeterHttp,
        RetrieveBillingPortalConfigurationHttp,
        RetrieveCouponHttp,
        RetrieveCreditGrantHttp,
        RetrieveCustomerHttp,
        RetrieveCustomerTaxIdHttp,
        RetrieveEntitlementsFeatureHttp,
        RetrieveFileLinkHttp,
        RetrieveIssuingCardHttp,
        RetrieveIssuingCardholderHttp,
        RetrieveIssuingPersonalizationDesignHttp,
        RetrievePaymentLinkHttp,
        RetrievePaymentMethodConfigurationHttp,
        RetrievePaymentMethodDomainHttp,
        RetrievePlanHttp,
        RetrievePriceHttp,
        RetrieveProductFeatureHttp,
        RetrieveProductHttp,
        RetrievePromotionCodeHttp,
        RetrieveRadarValueListHttp,
        RetrieveRadarValueListItemHttp,
        RetrieveShippingRateHttp,
        RetrieveTaxRateHttp,
        RetrieveTaxRegistrationHttp,
        RetrieveTaxSettingsHttp,
        RetrieveTerminalConfigurationHttp,
        RetrieveTerminalLocationHttp,
        RetrieveTerminalReaderHttp,
        RetrieveWebhookEndpointHttp,
        UpdateAccountHttp,
        UpdateCreditGrantHttp,
        UpdateCustomerHttp,
        UpdateFileLinkHttp,
        UpdateIssuingCardHttp,
        UpdateIssuingCardholderHttp,
        UpdateTaxSettingsHttp,
        UpdateTerminalReaderHttp,
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(StripeAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
