# Fork automation

> For maintainers. Using T3 Code? See [docs/user](../user/).

This fork intentionally does not copy upstream pull-request, deployment, mobile, preview, or npm
publishing automation. [`.github/workflows/release.yml`](../../.github/workflows/release.yml) is the
only GitHub Actions workflow.

The release workflow runs these gates before publishing stable or nightly desktop artifacts:

- `vp check`
- `vp run typecheck`
- `vp run test`
- `vp run release:smoke`

Pull requests do not have a repository-hosted CI workflow. Contributors should run the smallest
relevant tests, lint, and typecheck locally; maintainers should require those results during review.

See [Fork Releases](../operations/release.md) for triggers, artifacts, optional signing, and manual
validation.
