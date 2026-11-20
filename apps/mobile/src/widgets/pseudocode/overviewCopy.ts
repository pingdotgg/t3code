import { msg } from "gt-react-native";
import { m } from "../../i18n/messages";

export function overviewCopy() {
  return {
    overview: m(msg("Overview")),
    active: m(msg("Active now")),
    recent: m(msg("Recent threads")),
    review: m(msg("Ready to review")),
    working: m(msg("Working")),
    waiting: m(msg("Need you")),
    approvals: m(msg("Approvals")),
    questions: m(msg("Questions")),
    projects: m(msg("Projects")),
    starting: m(msg("Starting")),
    approval: m(msg("Approval needed")),
    input: m(msg("Needs your input")),
    finished: m(msg("Completed")),
    failed: m(msg("Failed")),
    idle: m(msg("Idle")),
    lastKnown: m(msg("Last known")),
    noActive: m(msg("No active threads")),
    noRecent: m(msg("No recent threads")),
    noReview: m(msg("All caught up")),
    sync: m(msg("Open PseudoCode to refresh")),
  };
}

export type OverviewCopy = ReturnType<typeof overviewCopy>;
