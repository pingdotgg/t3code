//! Mode ordering shared by thread commands and MCP access checks.

/// Runtime access, from approval-required through full-access; unknown modes are narrowest.
pub fn runtime_rank(mode: &str) -> usize {
    match mode {
        "auto-accept-edits" => 1,
        "auto" => 2,
        "full-access" => 3,
        _ => 0,
    }
}

/// Plan mode is narrower than the default interaction mode.
pub fn interaction_rank(mode: &str) -> usize {
    usize::from(mode != "plan")
}
