# Upstream synchronization

## Cadence

- Review upstream releases weekly.
- Evaluate a full integration monthly.
- Review security and provider-compatibility fixes promptly.
- Check for a compatible upstream baseline before each product release.

## Integration flow

1. Fetch upstream branches and tags.
2. Choose a released tag or recorded commit.
3. Create an integration branch from product `main`.
4. Merge the selected upstream baseline without rewriting public product history.
5. Resolve conflicts by preserving both inherited runtime behavior and intentional product policy.
6. Run focused checks for changed areas.
7. Run the web client integration pass and applicable provider matrix entries.
8. Update the baseline and patch ledger.
9. Open a pull request that explains upstream changes, retained divergences, and validation.

## Selective updates

Prefer a complete compatible upstream release. Cherry-pick only when:

- The change is isolated.
- Its dependencies are understood.
- Waiting for the complete release carries more risk.
- The cherry-pick is recorded in the patch ledger.

## Automation

A scheduled workflow may detect upstream movement and open an issue or draft synchronization pull request. It must never merge upstream changes automatically.

## Release infrastructure warning

The inherited release workflow references T3-owned signing, package publishing, hosted application, relay, and notification infrastructure. Fork-specific release work must replace or disable those integrations before publishing product artifacts.
