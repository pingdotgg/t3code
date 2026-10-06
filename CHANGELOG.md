# Changelog

## Unreleased

- Coalesce overlapping branch pull-request Git metadata reads. Sequential calls
  still read fresh metadata, and each caller still verifies repository identity.
