# Thread handoff port

T3's attachment and worktree toolkits and `OrchestratorMcpService.createThreads` are the
reference. This port adds no provider protocol or client-specific code. The supported server
is Linux; its clients are macOS and iOS. It adds no Windows, Android or non-GitHub host paths.

| T3 boundary | Rust boundary |
| --- | --- |
| Attachment toolkit | `tools/attachments.rs`, the client `conn-files::Files`, engine claims |
| Worktree toolkit and `WorktreeMcpService` | `tools/worktree.rs`, `conn-vcs`, setup terminals |
| `createThreads` | `tools/create_threads.rs`, `thread.create`, `thread.created.record` |
| Parameter decoders | `gen-tools.mjs` generates `thread-inputs.json`; `input.rs` applies it |

A workspace move queues its continuation in the binding transaction before ending the old
run. Its session closes before the continuation starts. The old MCP credential stays usable
for reads, as T3 permits after this detach. Creation and binding use command receipts and
compare the expected worktree in the store transaction. A failed bind removes the created
worktree and branch. An accepted handoff completes binding or rollback even if its client
disconnects, so session teardown cannot strand a checkout.

T3's upload owner registry expires entries after 24 hours plus the upload URL lifetime.
This registry also caps live entries at 4,096 and refuses another prepare until space is
available. It never evicts an unexpired owner. At most 256 handoffs run at once. No new
external crate is added: the MCP crate reuses files, VCS, terminals and the regex engine
already linked by the server.

`src/tests/threads_handoff.rs` maps these behaviors to Rust tests:

- T3 core's upload-owner case: `attachment_upload_is_owned_by_preparing_caller`.
- Canonical references and real bytes: `attachments_claim_bytes_reuse_canonical_metadata_and_refuse_foreign_ids`.
- T3's batch retry and inheritance cases: `create_threads_inherits_checkout_records_timeline_and_retries`.
- T3's worktree service cases: `handoff_moves_thread_ends_old_run_and_resumes_in_worktree`,
  `handoff_fetches_remote_base_and_list_falls_back_after_worktree_cleanup`,
  `concurrent_handoff_is_refused_and_a_raced_binding_rolls_back_git`, and
  `handoff_setup_runs_in_a_thread_terminal_with_the_project_environment`.

`parity.mjs` calls all seven tools on both servers without a model. It compares outside
visibility, successes, failures and input errors, then uses calling-thread credentials for
batch creation, uploads, handoff and a continuation. The setup script writes its project and
worktree environment into the new checkout. Its remote-base fixture keeps a stale tracking
ref after deleting the remote branch; the handoff must fall back to the local base. The VCS
regression `worktree_base_fetch_skips_tags_and_deleted_tracking_refs` also proves that the
fetch downloads no tags. The engine's `client-check.mjs` also decodes and
reduces the new parent timeline item with the real client's code.

A release-build stress run on Beast measured `Pss_Anon` at 1,952 KiB before staging uploads
and 3,252 KiB with 4,096 owners. It stayed at 3,252 KiB after discarding them and after another
1,000 prepare/discard cycles. The 4,097th prepare was refused; a discarded slot was reusable.
