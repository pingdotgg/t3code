# Release prerequisites

The fork does not inherit T3 Code production accounts. A release workflow may be restored only after each required service has a named fork owner, a least-privilege credential, and a tested rollback path.

## Required before desktop or CLI publication

| Prerequisite                                              | Owner              | Status         |
| --------------------------------------------------------- | ------------------ | -------------- |
| Fork-owned npm organization or package scope              | `@prathyaksh24-wq` | Not configured |
| Windows signing identity and credentials                  | `@prathyaksh24-wq` | Not configured |
| Apple signing, notarization, and provisioning credentials | `@prathyaksh24-wq` | Not configured |
| GitHub release identity with repository-only permissions  | `@prathyaksh24-wq` | Not configured |
| Stable and prerelease versioning rules                    | `@prathyaksh24-wq` | Not decided    |

## Required before hosted web or relay deployment

| Prerequisite                                                      | Owner              | Status         |
| ----------------------------------------------------------------- | ------------------ | -------------- |
| Fork-owned web hosting project and deployment token               | `@prathyaksh24-wq` | Not configured |
| Fork-owned authentication application identifiers and domains     | `@prathyaksh24-wq` | Not configured |
| Fork-owned relay infrastructure, database, observability, and DNS | `@prathyaksh24-wq` | Not configured |
| Privacy and retention policy for hosted telemetry                 | `@prathyaksh24-wq` | Not decided    |

## Optional surfaces

| Prerequisite                                     | Owner              | Status         |
| ------------------------------------------------ | ------------------ | -------------- |
| Fork-owned Expo project and delivery credentials | `@prathyaksh24-wq` | Not configured |
| Optional announcement integration                | `@prathyaksh24-wq` | Not configured |

## Current state

- Pull-request CI uses standard GitHub-hosted runners.
- Mobile showcase screenshots are manual and use standard GitHub-hosted runners.
- T3 Code release, relay deployment, and Expo delivery workflows are archived as upstream reference material and cannot execute.
