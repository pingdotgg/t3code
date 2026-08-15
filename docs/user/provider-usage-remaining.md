# Provider usage remaining

On web and desktop, the sidebar shows a compact provider usage strip directly above **Usage**. Each
enabled provider has its logo and either the percentage of its current allowance remaining or an em
dash (—). Select an item to see the available details, such as its usage windows, reset times, and
when T3 Code last received a successful update.

This is the provider's current reported allowance. It is separate from the **Usage** page's
historical tokens and estimated costs, and does not replace or derive from that history.

The strip follows the enabled provider rows in **Settings → Providers**. If you have more than one
instance of the same provider, each enabled instance appears separately and in that same order.
Disabled provider rows do not appear in the strip.

## When a provider shows an em dash

An em dash means T3 Code does not have a current, trustworthy remaining-allowance percentage for
that provider. This can happen when the provider has not reported one yet, the available information
is stale, sign-in is needed, or the connected environment is an older version that does not provide
usage remaining. The provider stays visible so you can still open its details.

## What each provider can report

- **Codex** can show the usage windows it reports, their reset times, credits or balance when
  available, and any banked reset inventory.
- **Claude** can show a remaining percentage after Claude reports a rate-limit update while it is
  running. T3 Code does not estimate this from earlier conversation activity. The value becomes
  unavailable when it is no longer current.
- **Cursor**, **Grok**, and **OpenCode** remain in the strip when enabled, but may show an em dash
  because they do not currently expose trustworthy allowance information to T3 Code.

## Using a Codex banked reset

If Codex reports an available banked reset, open its provider details and choose **Use reset**. T3
Code shows the reset name and expiry, if one is reported, before asking you to confirm. Nothing is
consumed until you confirm.

Applying a banked reset cannot be undone. Check the selected reset before confirming; after the
provider accepts it, T3 Code refreshes the displayed allowance and reset inventory.

## Scope and refreshes

Usage remaining is for your current primary environment only. It is not combined across devices,
environments, or provider accounts. While you are actively using the app, T3 Code refreshes this
information on a 30-second cadence, and also updates it when relevant provider settings change.
