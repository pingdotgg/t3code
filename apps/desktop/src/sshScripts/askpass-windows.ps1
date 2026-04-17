# Invoked by ssh via SSH_ASKPASS (through ssh-askpass.cmd) when T3 Code re-runs
# ssh with a cached password from the renderer's in-app prompt. We never expose
# a native dialog here — if T3_SSH_AUTH_SECRET is missing, that's a caller bug
# and we fail loudly.
if ($null -ne $env:T3_SSH_AUTH_SECRET) {
  [Console]::Out.WriteLine($env:T3_SSH_AUTH_SECRET)
  exit 0
}
[Console]::Error.WriteLine("T3 Code ssh-askpass invoked without T3_SSH_AUTH_SECRET.")
exit 1
