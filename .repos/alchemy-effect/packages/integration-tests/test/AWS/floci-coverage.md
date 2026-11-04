# Floci local-provider coverage

Source baseline: Floci PR [#13](https://github.com/alchemy-run/floci/pull/13), merge `416aadae25e3109e1b51b1de90f9c05e78010d7f`.

**Coverage is incomplete.** A service in Floci's index is not evidence that every Alchemy resource, lifecycle operation, or runtime binding works. The initial static inventory found 226 dual registrations across 40 namespaces; this change adds nine Organizations registrations. Custom local providers for ECS Service/Task and Lambda Function/MicrovmImage must be preserved.

## Validation procedure

Use `pnpm test:aws:floci --list` to inspect automatic selection without starting tests, probing Docker images, or resetting emulator state. `--dry-run` additionally prints the command, endpoint, and reset/external choices. The wrapper defaults to four concurrent files and preserves shared state; `--reset-shared` explicitly requests a reset and conflicts with external mode or `ALCHEMY_FLOCI_NO_RESET`. These conservative defaults do not establish a full-suite memory bound.

Use the `floci:dev` script against the pinned source, not an old Docker image with the same name. The script uses Floci's Maven wrapper and requires Java 25. Limit both Maven and the forked Quarkus JVM, and supervise aggregate resident memory separately; heap limits alone are insufficient.

The source server and the shared Docker emulator both use port 4566. Stopping the latter loses its default in-memory state and requires explicit permission. Never reset or replace a shared emulator as an incidental test step. Pass `--external` to the test wrapper (or set `ALCHEMY_FLOCI_EXTERNAL=1`) when using source development: it skips image selection and state reset, and the manager fails if the existing server is unavailable instead of starting/replacing a Docker container. Direct manager callers can use `ensureFloci({ external: true })`.

A recheck exposed why this is necessary: host memory pressure stopped the supervised development JVM, and the old automatic manager started a Docker fallback which did not implement Organizations. External mode prevents that recovery path. Its two regression tests use an unreachable endpoint with Docker unavailable; both configuration and environment selection must produce the external-server error.

Review each selected test's resource dependencies before running it. The current wrapper discovers entire directories after finding any dual registration, and explicit paths bypass that restriction. An unsupported sibling resource can still select a live provider even when `ALCHEMY_TEST_DEV=1` redirects the test body's SDK calls. Organizations automatic discovery is therefore restricted to `Organization.test.ts`, which owns its local fixture; the existing management-account suites and live-only Account provider are not added to the default run.

Keep one Bun test-runner process and the existing shared RPC sidecar; process-per-file workers or recycling are not the memory optimization. Start with explicitly reviewed files in a pilot using `--concurrency 1 --sequential --retry 0 --timeout 120000`, `--external`, and an isolated `ALCHEMY_TEST_STAGE`. Per-test timeouts and memory supervision apply; the full suite has no global deadline. Require local endpoint and dummy-account checks before destructive governance tests. Record test/sidecar memory separately from the development JVM and Docker. Stop after a budget breach, failed test, or incomplete cleanup; investigate before advancing.

The session's external supervisor was checked with a 40 MiB allocation and a 24 MiB cutoff. It terminates owned process groups, checks macOS pressure and swap growth, and checks Docker memory. This is sampled protection, not an operating-system hard memory guarantee. It is not part of the `test:aws:floci` command itself. The unrestricted command still needs full-run retention measurements and persistent safeguards before it should be recommended for a full run. Lower concurrency alone does not bound collection or retained modules. Lifecycle changes release completed file closures, file-owned sessions, and provider/artifact contexts; log capture improvements are secondary and do not explain the reported crashes by themselves.

## Executed batches

| Batch | Result | Peak test process-tree RSS | Cleanup |
| --- | --- | --- | --- |
| SSM String parameter lifecycle | Passed | 1,062 MiB | Parameter absent; observed test processes exited |
| SSM Parameter.test.ts, four cases | Passed | 1,302 MiB | All cases completed their destroy/deletion assertions; observed test processes exited |
| Organizations local resource lifecycle, nine resource types | Passed; final external-only file run passed both cases | 1,113 MiB in the earlier aggregate run | Organization absent; member/dependencies removed; observed test processes exited |
| External-server manager regression tests | Both passed | 556 MiB | No Docker fallback; observed test processes exited |
| Post-recovery single-process SSM + Organizations pilot | All six passed against verified source `dev` | 945 MiB | Local CLI returned no SSM parameters and `AWSOrganizationsNotInUseException`; no new Docker containers; observed test processes exited |

Development startup was observed at approximately 1,051 MiB for Maven plus Quarkus and launchers. The test and development peaks are independent samples, not necessarily simultaneous. These batches do not establish a safe full-suite bound.

The final workspace `tsc -b` check passed after separating the shared RPC test service from its standalone entrypoint. It ran separately from tests and the development JVM, using `GOMAXPROCS=2 GOMEMLIMIT=6GiB GOGC=50`, a 10 GiB sampled cutoff, and a 240-second deadline. The first pass reached 8,164 MiB and reported fixture-import errors; the corrected incremental pass completed at 3,596 MiB. Neither left owned processes behind. The compiler needs its own realistic allowance: earlier 4 GiB cutoffs were too low, and earlier host-pressure stops did not establish anything about test-suite memory safety.

One SSM attempt was stopped by the supervisor when Docker returned `--` while its last running container disappeared. No test resource remained. The supervisor now treats that placeholder as zero only after confirming no containers are running; otherwise unavailable telemetry remains a failure.

## Runner regression validation

- The latest core validation passed **63 tests**, with seven skipped Node variants and one todo, across twelve files in 34.6 seconds. Workspace `tsc -b` also passed after the follow-up fixes. Added cases cover colliding test titles and retry identities; cancellation/rejection while another owner retains a shared RPC session; release/disconnect during active Effects and streams; finalizer ordering, stale stubs, and ordinary development-session behavior. The result-map and RPC ownership defects found in review are fixed and regression-covered.
- After the earlier fixture/type-check correction, the combined runner/sidecar/launcher run completed 42 passing tests, six skipped Node variants, and one todo in 34.1 seconds across eleven files, with a sampled 621 MiB process-tree peak and no surviving owned processes. It covered file cleanup after filtering/import failures/interruption, interactive retry ordering, session/provider/artifact release, pending RPC cancellation, development-context survival, append-safe file logging, and external-server failure without Docker fallback.
- The five launcher regression tests also passed separately in 432 ms with a sampled 187 MiB process-tree peak and no surviving owned processes. These exercise real wrapper subprocesses with Docker unavailable, covering discovery, defaults, explicit flags, reset conflicts, external mode, and invalid endpoints. They do not exercise a real shared reset or establish full-suite memory safety.

## Full-selection attempts

The complete automatic selection collected **1,124 tests from 337 files** with concurrency four, no fast/name filter, no retries, a 90-second default test timeout, and a 240-second outer deadline. Both attempts used source development, external-only mode, dummy AWS credentials/account, stage `floci-pr13-full`, and Docker namespace `alchemy-floci-full`.

- The first attempt recorded 24 passes, two failures, and three todos before the session supervisor stopped it. Its Docker calculation incorrectly summed percentages using different per-container limits; this was a telemetry defect, not evidence of Docker exhaustion. The calculation was corrected and verified to sum used bytes against Docker's total memory instead.
- The corrected attempt recorded **52 passes, three failures, and seven todos** before both supervisors stopped on **macOS memory pressure level 2**. The runner/descendant sampled peak was **4,008 MiB**; Maven/Quarkus peaked separately at **1,077 MiB**. Corrected Docker usage was approximately 16.2%, below its cutoff. A concurrent unrelated Celld test was subsequently observed using roughly 4.5 GiB; the exact attribution of host pressure is not established.
- Functional failures before the cutoff: ACM `DescribeCertificate` returned `ISSUED` for the fixture expected to remain `PENDING_VALIDATION`; ACM `GetCertificate` did not return `RequestInProgressException`; API Gateway authorizer reconciliation returned `BadRequestException: Invalid operation` after creation. AppConfig event-source teardown additionally failed while the source server was shutting down; that is not an independently validated lifecycle failure.
- All observed owned test and JVM processes exited. One stopped, namespace-labelled AppSync Lambda container was removed after verifying its ownership; no containers or volumes remained in that namespace, and port 4566 was free. Interrupted infrastructure finalizers were not all successful, so these attempts do not establish a clean full lifecycle run.

Those historical logs were written under `/tmp/floci-memory-pilot`, which is no longer present. The full selection did not complete.

### 20 GiB monitored attempt (2026-09-21)

The combined supervisor counted source/test process RSS plus Docker usage in bytes. Its real allocation probe verified memory-triggered termination and no surviving probe processes; Docker accounting was separately checked with mixed per-container limits.

The full selection recorded **319 passes, 12 test failures, and 18 skipped/todo results**, plus **three file teardown failures**, before the former 240-second outer deadline. Peak aggregate sampled memory was **8.6 GiB**, below the 20 GiB cutoff, and recorded macOS pressure remained normal. All observed owned processes exited, the test-owned Docker namespace was empty, and the gateway was free after cleanup.

Additional failures included REST API event-source visibility, API Gateway WebSocket behavior, S3 `BucketNotEmpty` during AppConfig/Athena/CloudFront cleanup, Cognito role removal (`Roles is required`) and domain attributes, EC2 security-group convergence, and an AppSync binding timeout. AppConfig cleanup failed while the emulator was healthy, independently of the earlier shutdown-related failure.

Persistent logs are under `~/.grok/long-running-background-tasks/floci-merge-20g/full-20260921/`. After this attempt the user explicitly removed global suite deadlines; both the supervisor and `AGENTS.md` were updated. Per-test timeouts and memory protections remain. Review additionally identified duplicate-title result collisions and two RPC session-lifetime issues; the follow-up fixes subsequently passed the focused validation documented above.

### Deadline-free attempts after the core fixes

Both attempts retained the 20 GiB aggregate budget and per-test timeouts, with no suite-wide timeout or watcher expiry:

| Concurrency | Recorded results | Sampled aggregate peak | Stop reason |
| --- | --- | --- | --- |
| Four files | 292 passed, 9 failed, 16 skipped/todo; three additional teardown-hook failures | 8.22 GiB | macOS pressure level 2 persisted for 10 seconds |
| One file, sequential tests | 45 passed, 4 failed, 7 todo | 4.82 GiB | macOS pressure level 2 persisted for 10 seconds |

Neither hit the 20 GiB cutoff. Both supervisors reported no surviving owned processes; independent Docker/gateway checks confirmed an empty owned namespace, no owned volumes, and no listener on port 4566. The full 1,124-test selection still has not completed. Logs persist under the same directory in `full-no-deadline-20260921/` and `full-sequential-20260921/`.

## Current blockers

The approved switch from Docker container `3eb750d3a867` to source development was completed after checking container identity and host headroom. The gateway was verified as the owned Quarkus JVM, reporting version `dev` with Organizations support. All six SSM and Organizations tests then passed together in one Bun runner without reset or Docker fallback.

After cleanup verification, the source supervisor was deliberately stopped: Maven, Quarkus, and all observed owned processes exited, and port 4566 was free. Source startup plus the pilot reached a sampled 1,071 MiB in the source process tree, separately from the 945 MiB test-process peak. The old Docker container remains stopped; unrelated jobs and containers were left untouched.

Full-suite memory safety and resource coverage remain unverified. Previous host-pressure stops and replacement of the source listener by an old Docker emulator remain relevant risks: external mode prevents this runner from creating a fallback, but cannot prevent another process from taking the shared port. Continue only with adequate host headroom and verified endpoint ownership. Sampled supervision is not a hard whole-machine limit; Docker telemetry runs on a separate thread to avoid blocking RSS sampling.

## Resource-level findings

“Operation coverage” below is static evidence, not a passing lifecycle test. Runtime/data-plane bindings require their own deployment coverage.

| Resources | Local registration / validation | Blockers or limits |
| --- | --- | --- |
| SSM.Parameter | Existing dual; four lifecycle tests passed | No whole-service/runtime-binding claim |
| Organizations.Organization, Root, OrganizationalUnit, Policy, PolicyAttachment, RootPolicyType, TrustedServiceAccess, OrganizationResourcePolicy, DelegatedAdministrator | Added duals; aggregate local lifecycle passed | Account singleton: serialize tests and remove all members/dependencies before deleting organization. DelegatedAdministrator observation previously propagated AccountNotRegisteredException before first registration; fixed to treat it as absent. |
| Organizations.Account | Live only; partial emulator | Rename requires Account Management PutAccountName, absent in Floci. CreateAccount ignores RoleName and IamUserAccessToBilling. |
| CodeArtifact.Domain | Live only; deletion recovery mismatch | Floci DeleteDomain returns not-found for an absent domain; Alchemy assumes idempotent success and the SDK delete error union omits this error. Resolve the contract before claiming recovery coverage. |
| CodeArtifact.Repository | Live only; operation coverage present | Needs a local Domain. Cross-account permissions, upstream cycles, and package data-plane behavior are not established. |
| S3Tables.TableBucket | Live only; ordinary lifecycle operations present | Forced cleanup uses ListNamespaces, whose response is incomplete. Stored encryption metadata does not establish encrypted table storage. |
| S3Tables.Namespace | Live only; blocked | GetNamespace/list entries omit required createdBy and ownerAccountId. |
| S3Tables.Table | Live only; blocked | GetTable omits warehouseLocation and createdBy; GetTableMetadataLocation omits warehouseLocation. No real Iceberg warehouse. |
| AccessAnalyzer.Analyzer | Live only; blocked | GetAnalyzer, TagResource, UntagResource missing. |
| AccessAnalyzer.ArchiveRule | Live only; blocked | Get/Create/Update/DeleteArchiveRule missing; Analyzer dependency also blocked. |
| Backup.BackupVault | Live only; partial | Policy-free lifecycle operations exist; Put/DeleteBackupVaultAccessPolicy persistence missing. Get policy returns not-found. |
| Backup.BackupPlan | Live only; blocked | Create ignores BackupPlanTags; plan tag/untag unsupported. Mandatory Alchemy ownership tags cannot converge. |
| Backup.BackupSelection | Live only; partial | Explicit-resource CRUD exists, but ListOfTags is ignored/not returned; BackupPlan dependency blocked. |
| ApiGatewayV2.ApiMappingResource, ElastiCache.ServerlessCache, RDS.DBProxy, RDS.DBProxyEndpoint, RDS.DBProxyTargetGroup, SNS.PlatformApplication | Resource-level gaps within already selected service directories | Lifecycle compatibility not yet audited; do not infer support from neighboring dual registrations. |

Relevant evidence:

- `packages/aws/src/Providers.ts`: registration inventory.
- `packages/aws/src/Local/ProviderContext.ts`: live collection context and local override behavior.
- `submodules/floci/docs/services/index.md`: service/operation index, not a resource acceptance matrix.
- `submodules/floci/src/main/java/io/github/hectorvent/floci/services/s3tables/S3TablesController.java`: response representations.
- `submodules/distilled/packages/aws/src/services/s3tables.ts`: required wire-response fields.
- `submodules/floci/src/main/java/io/github/hectorvent/floci/services/accessanalyzer/AccessAnalyzerController.java`: supported routes.
- `submodules/floci/src/main/java/io/github/hectorvent/floci/services/organizations/OrganizationsJsonHandler.java`: operation dispatch.
- `submodules/floci/src/main/java/io/github/hectorvent/floci/services/account/AccountController.java`: cross-service rename gap.
- `submodules/floci/src/main/java/io/github/hectorvent/floci/services/backup/BackupController.java` and `BackupService.java`: policy/selection/tagging limits.

## Remaining namespace audit queue

These Floci-indexed services map to existing Alchemy namespaces without established complete local coverage. Each resource still needs its own operation/dependency check; this list is not approval to wrap all providers.

- Governance/security: AccessAnalyzer, Account, Organizations.Account, IdentityCenter, GuardDuty, Macie2, Inspector2, VerifiedPermissions, SecurityHub, Detective, Config, CloudTrail, ControlTower.
- Storage/data: S3Tables, Backup, CloudHSMV2, MemoryDB, Neptune, DocDB, Redshift, LakeFormation, EFS, DataSync.
- Compute/application: KinesisAnalyticsV2, Kafka, MQ, MWAA, EMR, EMRServerless, EKS, OpenSearch, AppIntegrations, Bedrock, BedrockAgentCore, SageMaker.
- Networking/observability: GlobalAccelerator, CloudWatch, OAM, RUM, NetworkFirewall, Route53Resolver, ResourceExplorer, AMP.
- Delivery/management: CloudFormation, CloudControl, CodeBuild, CodeDeploy, CodePipeline, CodeArtifact, ServiceCatalog, ServiceQuotas, Budgets, RAM, FIS.
- Other: Textract, Translate, CostExplorer, CostAndUsageReport, BCMDataExports, Transfer, IoT.

Names differ across projects: MSK maps to Kafka, Flink to KinesisAnalyticsV2, SSO Admin plus Identity Store to IdentityCenter, Managed Prometheus to AMP, and CUR to CostAndUsageReport.

Floci index rows without corresponding registered Alchemy resource namespaces include SWF, Connect, Lightsail, Elastic Beanstalk, ELB Classic, CodeGuru Reviewer, Control Catalog, Marketplace, Comprehend, Rekognition, Transcribe, Pricing, and BCM Pricing Calculator. Determine which expose lifecycle resources worth implementing; pure authentication/data-plane operations are not automatically resource-provider gaps.

## Completion bar

For each resource: supported required operations and semantics, local registration and dependencies, explicit test selection, passing create/update/replacement/delete where applicable, out-of-band local verification, and no surviving owned resources/processes. Keep unsupported and untested entries visible. Full Floci coverage and the full AWS-on-Floci suite are not yet validated.
