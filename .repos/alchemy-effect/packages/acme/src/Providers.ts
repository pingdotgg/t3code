import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Account, AccountProvider } from "./Account.ts";
import { Certificate, CertificateProvider } from "./Certificate.ts";
import { IssueCertificateHttp } from "./IssueCertificateHttp.ts";

export class Providers extends Provider.ProviderCollection<Providers>()("ACME") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Registers the ACME resource providers ({@link Account},
 * {@link Certificate}) and the {@link IssueCertificateHttp} binding. DNS-01
 * solvers come from the DNS provider, e.g. `Cloudflare.providers()` registers
 * `Cloudflare.ACME.ZoneSolver`.
 *
 * @example
 * ```typescript
 * export default Alchemy.Stack(
 *   "Certs",
 *   {
 *     providers: Layer.mergeAll(ACME.providers(), Cloudflare.providers()),
 *     state: Alchemy.localState(),
 *   },
 *   Effect.gen(function* () {
 *     const wildcard = yield* Wildcard;
 *     return { notAfter: wildcard.notAfter };
 *   }),
 * );
 * ```
 */
export const providers = () =>
  Layer.effect(Providers, Provider.collection([Account, Certificate])).pipe(
    Layer.provide(Layer.mergeAll(AccountProvider(), CertificateProvider())),
    Layer.provideMerge(IssueCertificateHttp),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.orDie,
  );
