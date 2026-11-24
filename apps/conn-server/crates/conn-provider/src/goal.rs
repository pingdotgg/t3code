//! `/goal`, the native goal command (`parseGoalCommand` in contracts): the engine's dispatch
//! rule and the providers that run goals natively read it the same way.

/// `OrchestrationV2GoalCommand`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GoalCommand {
    Show,
    Clear,
    Pause,
    Resume,
    Set(String),
}

impl GoalCommand {
    /// `goalCommandStopsActiveRun`: sent into active work, the command stops that work when it
    /// starts or replaces goal work, or ends a goal that drives the run.
    pub fn stops_active_run(&self, goal_status: Option<&str>) -> bool {
        match self {
            Self::Set(_) | Self::Resume => true,
            Self::Clear | Self::Pause => goal_status == Some("active"),
            Self::Show => false,
        }
    }
}

/// `parseGoalCommand`: `/goal`, alone or with an argument, in a message with no attachments.
pub fn parse_command(text: &str, has_attachments: bool) -> Option<GoalCommand> {
    if has_attachments {
        return None;
    }
    let rest = text.trim().strip_prefix("/goal")?;
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let argument = rest.trim();
    Some(match argument.to_lowercase().as_str() {
        "" | "edit" => GoalCommand::Show,
        "clear" => GoalCommand::Clear,
        "pause" => GoalCommand::Pause,
        "resume" => GoalCommand::Resume,
        _ => GoalCommand::Set(argument.to_owned()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `parseGoalCommand`'s cases.
    #[test]
    fn goal_commands_parse_as_t3_does() {
        let set = |s: &str| Some(GoalCommand::Set(s.to_owned()));
        for (text, attachments, expected) in [
            ("/goal", false, Some(GoalCommand::Show)),
            ("  /goal edit ", false, Some(GoalCommand::Show)),
            ("/goal CLEAR", false, Some(GoalCommand::Clear)),
            ("/goal pause", false, Some(GoalCommand::Pause)),
            ("/goal resume", false, Some(GoalCommand::Resume)),
            ("/goal Ship the feature", false, set("Ship the feature")),
            ("/goal\nship\nit ", false, set("ship\nit")),
            ("/goals", false, None),
            ("/goal clear", true, None),
            ("please /goal clear", false, None),
        ] {
            assert_eq!(parse_command(text, attachments), expected, "{text:?}");
        }
    }
}
