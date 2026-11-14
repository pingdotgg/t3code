//! Recorded CLI traffic (`testdata/cli`, from the stdio probe, CLI 2.1.322) and the events the
//! TypeScript adapter emitted for the same input (`testdata/ts`).

pub(crate) fn cli_transcripts() -> [(&'static str, &'static str); 12] {
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
        (
            "e12_subagent",
            include_str!("../testdata/cli/e12_subagent.ndjson"),
        ),
        (
            "e13_subagent_fg",
            include_str!("../testdata/cli/e13_subagent_fg.ndjson"),
        ),
        (
            "e14_steer",
            include_str!("../testdata/cli/e14_steer.ndjson"),
        ),
        (
            "e15_image",
            include_str!("../testdata/cli/e15_image.ndjson"),
        ),
    ]
}

pub(crate) fn cli(name: &str) -> &'static str {
    cli_transcripts()
        .into_iter()
        .find(|(n, _)| *n == name)
        .map(|(_, text)| text)
        .expect("known transcript")
}

pub(crate) fn ts_events(name: &str) -> &'static str {
    match name {
        "e01_turn" => include_str!("../testdata/ts/e01_turn.json"),
        "e02_second_turn" => include_str!("../testdata/ts/e02_second_turn.json"),
        "e03_interrupt" => include_str!("../testdata/ts/e03_interrupt.json"),
        "e06_permissions" => include_str!("../testdata/ts/e06_permissions.json"),
        "e12_subagent" => include_str!("../testdata/ts/e12_subagent.json"),
        "e13_subagent_fg" => include_str!("../testdata/ts/e13_subagent_fg.json"),
        "e14_steer" => include_str!("../testdata/ts/e14_steer.json"),
        "e15_image" => include_str!("../testdata/ts/e15_image.json"),
        _ => panic!("no TS events for {name}"),
    }
}
