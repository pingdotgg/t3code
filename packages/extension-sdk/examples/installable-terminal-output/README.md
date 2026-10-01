# Installable terminal output snapshot

This independent package renders its own controls and text. Its worker API calls
t3.terminal/output@^1.0.0 through the public SDK host. It does not import native app panels.

Install the directory through the environment extension installer and grant the intended
project plus t3.terminal/read-output. The login also needs terminal:operate; metadata-only
t3.terminal/read does not authorize terminal contents. HTTP invocation retains access:write.

Open Extensions → Open Terminal output snapshot · Side panel, enter an existing terminal ID
and choose Read output (or press Enter in the input). Reads never open, restart or resize a PTY.
Missing/closed sessions are absent; failures clear the displayed snapshot.

The view replaces text on each explicit read. It does not poll or append snapshots as live
events. It reads at most the last 8192 UTF-8 bytes of the host’s sanitized retained history.
truncated only describes this tail cut: native retention may already have dropped older output.
This is a diagnostic snapshot, not an interactive terminal renderer, cursor, lease or receipt.
Changing ID, replacing a request or unmounting cancels pending delivery.

Live output, input, control, resource identity/leases, terminal assets, full native parity and
mobile/relay/tunnel/V2 verification remain outside this example.
