# Release documentation

Use each release surface for one purpose:

- `README.md` describes the product as it exists now.
- `CHANGELOG.md` records user-visible changes by version.
- GitHub release notes explain why a release matters and link the included pull requests.
- Pull requests record implementation scope and validation.
- Commits preserve focused engineering history.

## Release checklist

1. Select the release version and included pull requests.
2. Confirm each included pull request has a release category or an explicit exclusion.
3. Update `CHANGELOG.md`.
4. Update the README only when current installation, support, or product behavior changed.
5. Run the release and provider qualification checks.
6. Generate GitHub release notes and review them before publication.
7. Record breaking changes, migrations, and known limitations explicitly.

The inherited T3 release, relay deployment, and Expo delivery workflows are archived under `docs/upstream/workflows/`. They are documentation, not active GitHub Actions workflows. Do not restore them until every external account in `prerequisites.md` has a named fork owner, a least-privilege credential, a reviewed release path, and a tested rollback path.
