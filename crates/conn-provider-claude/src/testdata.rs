//! Recorded CLI traffic (`testdata/cli`, from the stdio probe, CLI 2.1.322) and the events the
//! TypeScript adapter emitted for the same input (`testdata/ts`).

pub fn cli_transcripts() -> [(&'static str, &'static str); 8] {
    [
        ("e01_turn", include_str!("../testdata/cli/e01_turn.ndjson")),
        (
            "e02_second_turn",
            include_str!("../testdata/cli/e02_second_turn.ndjson"),
        ),
        (
            "e03_interrupt",
            include_str!("../testdata/cli/e03_interrupt.ndjson"),
        ),
        (
            "e04_set_model",
            include_str!("../testdata/cli/e04_set_model.ndjson"),
        ),
        (
            "e05_permission_mode",
            include_str!("../testdata/cli/e05_permission_mode.ndjson"),
        ),
        (
            "e06_permissions",
            include_str!("../testdata/cli/e06_permissions.ndjson"),
        ),
        (
            "e09_resume_missing",
            include_str!("../testdata/cli/e09_resume_missing.ndjson"),
        ),
        ("e10_kill", include_str!("../testdata/cli/e10_kill.ndjson")),
    ]
}

pub fn cli(name: &str) -> &'static str {
    cli_transcripts()
        .into_iter()
        .find(|(n, _)| *n == name)
        .map(|(_, text)| text)
        .expect("known transcript")
}

pub fn ts_events(name: &str) -> &'static str {
    match name {
        "e01_turn" => include_str!("../testdata/ts/e01_turn.json"),
        "e02_second_turn" => include_str!("../testdata/ts/e02_second_turn.json"),
        "e03_interrupt" => include_str!("../testdata/ts/e03_interrupt.json"),
        "e06_permissions" => include_str!("../testdata/ts/e06_permissions.json"),
        _ => panic!("no TS events for {name}"),
    }
}
