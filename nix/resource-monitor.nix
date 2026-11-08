# SPDX-License-Identifier: MIT
# Same as nixpkgs `t3code/resource-monitor.nix`, except `src` comes from
# the local checkout. Build it with `nix build .#default` (packaging pulls
# it in) or explicitly with `nix build .#t3code ...` — the wrapper's
# `T3CODE_RESOURCE_MONITOR_PATH` points at this binary.
{
  rustPlatform,
  t3code-unwrapped,
}:

rustPlatform.buildRustPackage {
  pname = "t3code-resource-monitor";
  inherit (t3code-unwrapped) version src;

  sourceRoot = "${t3code-unwrapped.src.name}/native/resource-monitor";

  # Refresh with `nix build` and copy the `got: sha256-…` from a
  # hash-mismatch error whenever native/resource-monitor/Cargo.lock changes.
  cargoHash = "sha256-5cmG2daM1bVOA23gjjoalbx0fEL1hmqV6WZov0sUZp8=";

  meta = {
    description = "Native resource diagnostics sidecar for T3 Code";
    inherit (t3code-unwrapped.meta)
      homepage
      license
      maintainers
      platforms
      ;
    mainProgram = "t3-resource-monitor";
  };
}
