# CPU usage optimization

- [x] Audit always-on server and client CPU-sensitive paths.
- [x] Scope native resource-monitor 1 Hz sampling to live diagnostics.
- [x] Limit native detail refreshes to tracked processes and reuse background command metadata.
- [x] Share the desktop-local bootstrap poll across renderer consumers.
- [x] Share the settings relative-time ticker across visible labels.
- [x] Update focused tests and resource telemetry documentation.
- [x] Re-run the Rust sidecar tests under the repository-supported Rust toolchain.

## Review/results

Background native process sampling now runs at 5 seconds on normal AC power and
returns to 1 second while diagnostics is open. This reduces idle process-table
scans and history copies without changing live diagnostics cadence.

Native samples now scan the full process table only for identity and CPU data,
then refresh memory, I/O, and command details for the retained process tree.
The Rust sidecar test suite now passes under stable rustc 1.97.1.

The web client now uses one active desktop-bootstrap poll and one active
relative-time ticker per interval instead of one timer per mounted consumer.
