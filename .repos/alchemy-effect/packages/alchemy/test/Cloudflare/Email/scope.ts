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
 * Set `CLOUDFLARE_TEST_EMAIL_ROUTING=1` with an API-token credential that
 * carries `Zone.Email Routing Rules` (edit) plus account-level
 * `Email Routing Addresses` to run them.
 */
export const emailRoutingScoped = !!process.env.CLOUDFLARE_TEST_EMAIL_ROUTING;
