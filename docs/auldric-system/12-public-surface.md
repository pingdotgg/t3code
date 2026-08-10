# Auldric public surface

Issue #27 rebuilds the approved public requirement as a separate static application at
`apps/auldric-public`. It does not rename, reskin, import, or replace T3's `apps/marketing` site.
The two applications keep separate package, build, deployment, rollback, metadata, legal, and
release responsibilities.

## Requirement provenance

Issue #14 classifies the donor's public marketing content/assets and claim-validation intent as
`keep-rebuild`, while delivery scaffolding, access mechanics, persistence, generated assets, and
release configuration are split or replaced. Issue #27 inspected only donor commit
`cf6400e77dfaf9569f1ce6eaca4421deb0b2bf23` as historical requirement evidence.

The rebuild retains the classified Auldric name, navy/slash direction, public origin boundary, and
the brand line “The proof is in the planning.” Explanatory copy, layouts, SVGs, capability logic,
tests, and operations guidance are new. It imports no donor code, binary asset, waitlist row, Clerk
flow, latest-release lookup, entitlement, or runtime implementation.

## Public product definition

Auldric is a source-backed Marketing and Strategy workspace. Its product model carries business
sources into evidence, decisions, reviewable outputs, and next work. The public site describes that
model without claiming that a usable product deployment, account, workflow, integration, saved
artifact, or autonomous outcome exists.

Product definition and launch state are separate:

- product and home pages explain what Auldric is;
- access, waitlist, pricing, and download pages report what the current publication can actually
  offer;
- missing, unknown, incomplete, or malformed capability input always resolves to an unavailable
  state;
- an unavailable route never redirects to T3 or treats a public page as an entitlement.

## Operational surface

The static application implements:

- home and product narrative using the approved Auldric navy, slash-led wordmark, and
  Marketing/Strategy vocabulary;
- access and target-onboarding explanation with an explicit current-state panel;
- an unpublished pricing and eligibility state with no checkout or payment collection;
- a consent-gated waitlist route;
- a verified-release-gated download route;
- privacy, terms, canonical metadata, raster social metadata, crawler policy, sitemap, and 404
  recovery;
- keyboard focus, skip navigation, semantic landmarks and headings, labelled form controls,
  responsive layout, and reduced-motion treatment.

The default build is a noindex preview. It contains no analytics, advertising pixels, account
cookies, contact form, price, checkout, access destination, or download.

## Capability gates

| Capability          | Opens only when                                                                                            | Missing or invalid state                              |
| ------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Public publication  | Exact HTTPS Auldric site URL, legal name, address, jurisdiction, and privacy contact are supplied          | `noindex,nofollow`; crawler-wide `Disallow: /`        |
| Product access      | Publication is ready, status is `available`, and HTTPS uses a separate `auldric.com` origin                | Access unavailable; `/access` remains the primary CTA |
| Waitlist            | Publication is ready, status is `open`, retention is 1–730 days, and a reviewed HTTPS endpoint is supplied | No form or email field is rendered                    |
| Desktop download    | Publication is ready, status selects a reviewed release, and the build fetches and hashes its bytes        | No release link is rendered                           |
| Pricing and payment | A separately approved commercial offer is implemented                                                      | Terms unpublished; no checkout or payment             |

Waitlist submission requires the visible consent checkbox and sends the reviewed consent version.
The controls remain disabled until the enhancement has registered its handler, so a missing or
blocked script cannot make a native cross-origin submission. The enhanced request omits credentials,
rejects redirects, treats only a successful HTTP response as receipt, and preserves the entered
value for recovery after failure. Enabling the route does not provide persistence: the deployment
owner must configure and operate the named endpoint under the published privacy terms.

Download configuration cannot supply an arbitrary URL or checksum. A release must first be entered
in `src/content/verified-releases.json` with an exact `AuldricAI/auldrics` GitHub release URL,
filename, version, platform, and SHA-256. Every public build fetches each recorded file and fails if
the response or digest does not match. Redirects are followed manually: every destination must be
validated as default-port HTTPS GitHub release storage before the next request, and more than five
hops fails the build. The record is empty at issue #27 completion, so downloads are unavailable.

## Claim boundary

Public copy may define Auldric and explain its target product model. It must not claim:

- usable access, onboarding, account entitlement, or saved customer work without product proof;
- a public price, tier, eligibility threshold, purchase route, or payment collection;
- a waitlist without the configured consent and privacy path;
- a desktop release from a tag, repository, operator-entered digest, donor asset, or T3 installer;
- integrations, autonomous execution, growth or revenue outcomes, broad measurement, or other
  capabilities not verified by their owning implementation issues.

## T3 invariance and rollback

`apps/marketing`, `@t3tools/marketing`, all T3 hosts and callbacks, T3 release links, and T3 runtime
identity remain T3-owned and unchanged. A package-local test pins the tracked T3 marketing tree
digest so a public Auldric change cannot silently reskin it.

Deploy and roll back `@auldric/public` independently. Removing its deployment or configuration does
not alter T3, the in-product Marketing boundary, product data, authentication, or release channels.
The operational build and configuration procedure is in
[the Auldric public-site runbook](../operations/auldric-public-site.md).

## Decision

Keep the Auldric public narrative in its own fail-closed static application. Preserve the native T3
public application byte-for-byte.

## Next action

Supply and review the legal publication inputs before deployment. Enable access, waitlist, or a
download only after its external capability passes the gates above.

## Parked until

Public pricing, checkout, mobile distribution, product access, waitlist persistence, and desktop
artifacts remain parked until their operators, terms, destinations, or signed releases exist and
are independently verified.
