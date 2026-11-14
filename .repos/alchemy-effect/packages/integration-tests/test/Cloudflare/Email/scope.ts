/**
 * Email Routing is scoped separately from the rest of the Cloudflare API.
 * A credential without it — notably Cloudflare OAuth, which carries no
 * Email Routing scope at all — is refused before any resource logic runs:
 *
 *     Unauthorized: Authentication error
 *       at provider.create (packages/alchemy/src/Apply.ts)
 *
 * Every suite below drives real Email Routing resources (routing settings,
 * rules, catch-alls, destination addresses, sending subdomains) against the
 * standing test zone, so all of them need the scope.
 *
 * The standing testing credential (an API token carrying `Zone.Email Routing
 * Rules` (edit) plus account-level `Email Routing Addresses`) has the scope,
 * so the suites run by default. Set `CLOUDFLARE_TEST_EMAIL_ROUTING=0` to skip
 * them skip-clean under a credential without it (e.g. Cloudflare OAuth).
 */
export const emailRoutingScoped = process.env.CLOUDFLARE_TEST_EMAIL_ROUTING !== "0";

/**
 * Exclusive label for every test that touches zone Email Routing. The suites
 * share Email Routing on the standing test zone, and `Email.Routing`'s destroy
 * turns routing off for the whole zone, so they must not overlap.
 */
export const EMAIL_ROUTING_ZONE = "cloudflare:email-routing-zone";
