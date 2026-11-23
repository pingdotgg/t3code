//! The board's insight numbers: values, changes against the period before, trend lines, the
//! provider split, and their text.
//!
//! Port of `packages/client-runtime/src/orbitGateway/taskInsights.ts`, the change text of
//! `apps/web/src/orbit/tasks/TasksInsights.tsx`, and the scale helpers of `InsightCharts.tsx`.
//! A number Orbit does not report is `None` and shows a dash, never zero.

use super::format::{format_duration, format_tokens, js_round, to_fixed};
use super::tasks::{InsightsBucket, InsightsPeriod, InsightsSummary, TaskInsights};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InsightId {
    Completed,
    Spent,
    Tokens,
    Wasted,
    Delivery,
    FirstPass,
    MergeWait,
    ReviewRounds,
}

/// How the change against the period before reads.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InsightUnit {
    /// Percent of the earlier value.
    Percent,
    /// Share points.
    Points,
    /// The raw difference.
    Raw,
}

/// Which way is good; a neutral number shows its change in grey.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InsightBetter {
    Lower,
    Higher,
    Neutral,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InsightSpec {
    pub id: InsightId,
    pub label: &'static str,
    pub unit: InsightUnit,
    pub better: InsightBetter,
}

/// Two rows: output and tokens, then speed and quality.
pub const INSIGHTS: [InsightSpec; 8] = [
    spec(
        InsightId::Completed,
        "Tasks completed",
        InsightUnit::Percent,
        InsightBetter::Higher,
    ),
    spec(
        InsightId::Spent,
        "Tokens spent",
        InsightUnit::Percent,
        InsightBetter::Neutral,
    ),
    spec(
        InsightId::Tokens,
        "Tokens per task",
        InsightUnit::Percent,
        InsightBetter::Lower,
    ),
    spec(
        InsightId::Wasted,
        "Wasted tokens",
        InsightUnit::Points,
        InsightBetter::Lower,
    ),
    spec(
        InsightId::Delivery,
        "Delivery time",
        InsightUnit::Percent,
        InsightBetter::Lower,
    ),
    spec(
        InsightId::FirstPass,
        "PR first pass",
        InsightUnit::Points,
        InsightBetter::Higher,
    ),
    spec(
        InsightId::MergeWait,
        "Merge wait",
        InsightUnit::Percent,
        InsightBetter::Lower,
    ),
    spec(
        InsightId::ReviewRounds,
        "Review rounds",
        InsightUnit::Raw,
        InsightBetter::Lower,
    ),
];

const fn spec(
    id: InsightId,
    label: &'static str,
    unit: InsightUnit,
    better: InsightBetter,
) -> InsightSpec {
    InsightSpec {
        id,
        label,
        unit,
        better,
    }
}

impl InsightId {
    pub fn spec(self) -> InsightSpec {
        // Every id has exactly one entry in INSIGHTS.
        INSIGHTS
            .iter()
            .copied()
            .find(|entry| entry.id == self)
            .unwrap_or(INSIGHTS[0])
    }
}

/// The raw number behind an insight. Shares are 0–1, durations in milliseconds.
fn raw_value(summary: &InsightsSummary, id: InsightId) -> Option<f64> {
    match id {
        InsightId::Completed => summary.merged,
        InsightId::Spent => summary.tokens,
        InsightId::Tokens => summary.tokens_per_merged_pr,
        InsightId::Wasted => summary.wasted_share,
        // Ready to deployed once Orbit stamps deploys (6041); ready to merged until then.
        InsightId::Delivery => summary.delivery_time_ms.or(summary.lead_time_ms),
        InsightId::FirstPass => summary.pr_first_pass,
        // PR opened to merged (6042). Orbit's `merge_wait_ms` measures from settled subtasks.
        InsightId::MergeWait => summary.pr_merge_wait_ms,
        InsightId::ReviewRounds => summary.review_rounds,
    }
}

/// Short text for a raw value, for the cards, the axis and the legend.
pub fn format_insight_value(id: InsightId, value: f64) -> String {
    match id {
        InsightId::Completed => js_round(value).to_string(),
        InsightId::Spent | InsightId::Tokens => format_tokens(value),
        InsightId::Delivery | InsightId::MergeWait => format_duration(value),
        InsightId::ReviewRounds => to_fixed(value, 1),
        InsightId::Wasted | InsightId::FirstPass => format!("{}%", js_round(value * 100.0)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InsightResult {
    pub value: Option<f64>,
    /// Against the period before, in the insight's unit; `None` when either period has no value.
    pub change: Option<f64>,
}

fn change_of(spec: InsightSpec, now: Option<f64>, before: Option<f64>) -> Option<f64> {
    let (now, before) = (now?, before?);
    match spec.unit {
        InsightUnit::Points => Some(js_round((now - before) * 100.0)),
        InsightUnit::Raw => Some(js_round((now - before) * 10.0) / 10.0),
        InsightUnit::Percent if before == 0.0 => None,
        InsightUnit::Percent => Some(js_round((now - before) / before * 100.0)),
    }
}

/// One insight's number and change. A failed or missing read gives dashes, never zeros.
pub fn insight_result(insights: Option<&TaskInsights>, id: InsightId) -> InsightResult {
    let now = insights.and_then(|i| raw_value(&i.current, id));
    let before = insights.and_then(|i| raw_value(&i.previous, id));
    InsightResult {
        value: now,
        change: change_of(id.spec(), now, before),
    }
}

/// Every insight's number and change, in [`INSIGHTS`] order.
pub fn insight_results(insights: Option<&TaskInsights>) -> Vec<(InsightId, InsightResult)> {
    INSIGHTS
        .iter()
        .map(|spec| (spec.id, insight_result(insights, spec.id)))
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ChangeTone {
    Good,
    Bad,
    Neutral,
}

/// Whether a change is good, bad, or neither (no change, or a neutral number).
pub fn insight_change_tone(spec: InsightSpec, change: Option<f64>) -> ChangeTone {
    match change {
        None => ChangeTone::Neutral,
        Some(change) if change == 0.0 || spec.better == InsightBetter::Neutral => {
            ChangeTone::Neutral
        }
        Some(change) => {
            if (change < 0.0) == (spec.better == InsightBetter::Lower) {
                ChangeTone::Good
            } else {
                ChangeTone::Bad
            }
        }
    }
}

/// The change line of a card: `+359%`, `−12%`, `±0%`, `+39 pts`, `−0.2`, or "No earlier data".
/// `None` when the card has no value (the card shows nothing there).
pub fn insight_change_text(spec: InsightSpec, result: InsightResult) -> Option<String> {
    result.value?;
    let Some(change) = result.change else {
        return Some("No earlier data".to_owned());
    };
    let sign = if change > 0.0 {
        "+"
    } else if change < 0.0 {
        "\u{2212}"
    } else {
        "\u{b1}"
    };
    let unit = match spec.unit {
        InsightUnit::Points => " pts",
        InsightUnit::Percent => "%",
        InsightUnit::Raw => "",
    };
    Some(format!("{sign}{}{unit}", change.abs()))
}

/// Which arrow leads the change: none for no change.
pub fn insight_change_trend(change: Option<f64>) -> Option<bool> {
    change.filter(|c| *c != 0.0).map(|c| c < 0.0)
}

#[derive(Debug, Clone, PartialEq)]
pub struct TrendPoint {
    /// The last day the point covers, `YYYY-MM-DD`, or the start of its last hour (ISO).
    pub date: String,
    pub value: f64,
}

const HOUR_MS: i64 = 3_600_000;
const DAY_MS: i64 = 24 * HOUR_MS;

/// The period's buckets with every missing day or hour added as an empty one, up to the newest
/// bucket and back over the whole period, so a chart runs as one line.
fn every_bucket(buckets: &[InsightsBucket], period: InsightsPeriod) -> Vec<InsightsBucket> {
    let (slots, step) = match period {
        InsightsPeriod::Day => (24, HOUR_MS),
        InsightsPeriod::Week => (7, DAY_MS),
        InsightsPeriod::Month => (30, DAY_MS),
    };
    let Some(times) = buckets
        .iter()
        .map(|bucket| parse_date_ms(&bucket.date))
        .collect::<Option<Vec<i64>>>()
    else {
        return buckets.to_vec();
    };
    let (Some(&end), Some(&first)) = (times.iter().max(), times.iter().min()) else {
        return buckets.to_vec();
    };
    let start = first.min(end - (slots - 1) * step);
    let by_time = |time: i64| {
        // A later bucket at the same time wins, as with a JavaScript Map.
        times
            .iter()
            .rposition(|t| *t == time)
            .map(|index| buckets[index].clone())
    };
    let mut filled = Vec::new();
    let mut time = start;
    while time <= end {
        filled.push(by_time(time).unwrap_or_else(|| InsightsBucket {
            date: if period == InsightsPeriod::Day {
                format!("{}:00:00+00:00", &format_iso_ms(time)[..13])
            } else {
                format_iso_ms(time)[..10].to_owned()
            },
            merged: 0.0,
            values: InsightsSummary::default(),
        }));
        time += step;
    }
    filled
}

/// The insight over time, one continuous line over the whole period: merges summed over a trailing
/// window (7 days in 30d, 3 days or hours else); every other number per day, or per hour in 24h.
/// A bucket without a value charts as 0. Tokens per task falls back to weeks when no bucket has it.
pub fn insight_trend(insights: Option<&TaskInsights>, id: InsightId) -> Option<Vec<TrendPoint>> {
    let insights = insights?;
    let reported = if insights.period == InsightsPeriod::Day {
        &insights.hourly
    } else {
        &insights.daily
    };
    if reported.is_empty() {
        return None;
    }
    let buckets = every_bucket(reported, insights.period);
    if id == InsightId::Completed {
        let (step, window) = if insights.period == InsightsPeriod::Month {
            (2, 7)
        } else {
            (1, 3)
        };
        return Some(trailing(&buckets, step, window));
    }
    let values: Vec<Option<f64>> = buckets.iter().map(|b| raw_value(&b.values, id)).collect();
    if id == InsightId::Tokens && values.iter().all(Option::is_none) && insights.weekly.len() > 1 {
        return Some(
            insights
                .weekly
                .iter()
                .map(|week| TrendPoint {
                    date: week.week_start.clone(),
                    value: week.tokens_per_merged_pr.unwrap_or(0.0),
                })
                .collect(),
        );
    }
    Some(
        buckets
            .iter()
            .zip(values)
            .map(|(bucket, value)| TrendPoint {
                date: bucket.date.clone(),
                value: value.unwrap_or(0.0),
            })
            .collect(),
    )
}

/// Merges summed over a trailing window of buckets, one point every `step` buckets, ending at the newest.
fn trailing(buckets: &[InsightsBucket], step: usize, window: usize) -> Vec<TrendPoint> {
    let mut points = Vec::new();
    let mut end = buckets.len();
    while end > 0 {
        let last = end - 1;
        let span = &buckets[(last + 1).saturating_sub(window)..=last];
        points.push(TrendPoint {
            date: buckets[last].date.clone(),
            value: span.iter().map(|b| b.merged).sum(),
        });
        end = end.saturating_sub(step);
    }
    points.reverse();
    points
}

/// Orbit's provider names, by CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InsightProvider {
    Codex,
    Claude,
    Gemini,
}

impl InsightProvider {
    const ORDER: [Self; 3] = [Self::Codex, Self::Claude, Self::Gemini];

    /// Conn's name for the provider.
    pub fn name(self) -> &'static str {
        match self {
            Self::Codex => "Codex",
            Self::Claude => "Claude",
            Self::Gemini => "Gemini",
        }
    }

    /// Orbit breaks insights down by model; the board names the provider behind it.
    fn of_model(model: &str) -> Option<Self> {
        let name = model.to_lowercase();
        if ["claude", "opus", "sonnet", "haiku"]
            .iter()
            .any(|n| name.contains(n))
        {
            return Some(Self::Claude);
        }
        if name.contains("gemini") {
            return Some(Self::Gemini);
        }
        let o_series = name
            .strip_prefix('o')
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()));
        (name.contains("codex") || name.contains("gpt") || o_series).then_some(Self::Codex)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ProviderValue {
    pub provider: InsightProvider,
    pub value: Option<f64>,
}

/// The insight per provider, from Orbit's model breakdown, in a fixed provider order. Models of one
/// provider combine weighted by their merged tasks. Empty for numbers the breakdown lacks.
pub fn insight_by_provider(insights: Option<&TaskInsights>, id: InsightId) -> Vec<ProviderValue> {
    #[derive(Clone, Copy, PartialEq)]
    enum Field {
        Merged,
        TokensPerMergedPr,
        LeadTime,
    }
    let field = match id {
        InsightId::Completed => Field::Merged,
        InsightId::Tokens => Field::TokensPerMergedPr,
        InsightId::Delivery => Field::LeadTime,
        _ => return Vec::new(),
    };
    let Some(insights) = insights.filter(|i| !i.by_model.is_empty()) else {
        return Vec::new();
    };
    InsightProvider::ORDER
        .iter()
        .filter_map(|&provider| {
            let rows: Vec<_> = insights
                .by_model
                .iter()
                .filter(|row| InsightProvider::of_model(&row.key) == Some(provider))
                .collect();
            if rows.is_empty() {
                return None;
            }
            if field == Field::Merged {
                let value = rows.iter().map(|row| row.merged.unwrap_or(0.0)).sum();
                return Some(ProviderValue {
                    provider,
                    value: Some(value),
                });
            }
            let weighted: Vec<(f64, f64)> = rows
                .iter()
                .filter_map(|row| {
                    let value = if field == Field::TokensPerMergedPr {
                        row.tokens_per_merged_pr
                    } else {
                        row.lead_time_ms
                    }?;
                    let weight = row.merged.filter(|m| *m != 0.0)?;
                    Some((value, weight))
                })
                .collect();
            let weight: f64 = weighted.iter().map(|(_, w)| w).sum();
            let value =
                (weight != 0.0).then(|| weighted.iter().map(|(v, w)| v * w).sum::<f64>() / weight);
            Some(ProviderValue { provider, value })
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Chart scales (InsightCharts.tsx)
// ---------------------------------------------------------------------------------------------

/// The value range a line is drawn in: the data's range plus 12% padding.
pub fn extent(values: &[f64]) -> (f64, f64) {
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let or = |a: f64, b: f64| if a == 0.0 || a.is_nan() { b } else { a };
    let pad = or(or((max - min) * 0.12, max.abs() * 0.1), 1.0);
    (min - pad, max + pad)
}

#[derive(Debug, Clone, PartialEq)]
pub struct NiceScale {
    pub low: f64,
    pub high: f64,
    pub ticks: Vec<f64>,
}

/// An axis on round steps (1, 2, 2.5 or 5 × 10ⁿ) that covers the data in at most four gridlines.
pub fn nice_scale(min: f64, max: f64) -> NiceScale {
    let or = |a: f64, b: f64| if a == 0.0 || a.is_nan() { b } else { a };
    let span = or(or(max - min, max.abs()), 1.0);
    let power = 10f64.powf((span / 3.0).log10().floor());
    let candidates = [1.0, 2.0, 2.5, 5.0, 10.0, 20.0, 25.0, 50.0].map(|factor| factor * power);
    let fits = |step: f64| (max / step).ceil() - (min / step).floor() <= 3.0;
    let step = candidates
        .iter()
        .copied()
        .find(|step| fits(*step))
        .unwrap_or(candidates[candidates.len() - 1]);
    let low = (min / step).floor() * step;
    let high = (max / step).ceil() * step;
    let mut ticks = Vec::new();
    let mut tick = low;
    while tick <= high + step / 2.0 {
        ticks.push(js_round(tick / step) * step);
        tick += step;
    }
    NiceScale {
        low,
        high: if high == low { low + step } else { high },
        ticks,
    }
}

/// The sparkline's points in a `width` × 28 box: x from 1 to width − 1, y with 3 px margins.
/// Empty when there are fewer than two values (the sparkline draws nothing then).
pub fn sparkline_points(points: &[TrendPoint], width: f64) -> Vec<(f64, f64)> {
    const HEIGHT: f64 = 28.0;
    if points.len() < 2 || width <= 0.0 {
        return Vec::new();
    }
    let values: Vec<f64> = points.iter().map(|p| p.value).collect();
    let (low, high) = extent(&values);
    let last = (points.len() - 1).max(1) as f64;
    points
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let x = 1.0 + (index as f64 / last) * (width - 2.0);
            let y = HEIGHT - 3.0 - ((point.value - low) / (high - low)) * (HEIGHT - 6.0);
            (x, y)
        })
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Dates (UTC). `Date.parse` for the shapes Orbit sends: `YYYY-MM-DD`, or an ISO date-time with
// optional fraction and a `Z` or `±HH:MM` offset (no offset reads as UTC here).
// ---------------------------------------------------------------------------------------------

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month, day)
}

fn number(text: &str, len: usize) -> Option<i64> {
    (text.len() == len && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// Milliseconds since the epoch, or `None` for a shape this parser does not read.
pub fn parse_date_ms(text: &str) -> Option<i64> {
    let (date, time) = match text.split_once('T') {
        Some((date, time)) => (date, Some(time)),
        None => (text, None),
    };
    let mut parts = date.split('-');
    let year = number(parts.next()?, 4)?;
    let month = number(parts.next()?, 2)?;
    let day = number(parts.next()?, 2)?;
    if parts.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut ms = days_from_civil(year, month, day) * DAY_MS;
    if let Some(time) = time {
        let (clock, offset_ms) = if let Some(clock) = time.strip_suffix('Z') {
            (clock, 0)
        } else if let Some(index) = time.rfind(['+', '-']) {
            let (clock, offset) = time.split_at(index);
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let (hours, minutes) = offset[1..].split_once(':')?;
            (
                clock,
                sign * (number(hours, 2)? * HOUR_MS + number(minutes, 2)? * 60_000),
            )
        } else {
            (time, 0)
        };
        let (clock, millis) = match clock.split_once('.') {
            Some((clock, fraction))
                if !fraction.is_empty() && fraction.bytes().all(|b| b.is_ascii_digit()) =>
            {
                let digits: String = fraction.chars().chain("000".chars()).take(3).collect();
                (clock, digits.parse::<i64>().ok()?)
            }
            Some(_) => return None,
            None => (clock, 0),
        };
        let mut fields = clock.split(':');
        let hours = number(fields.next()?, 2)?;
        let minutes = number(fields.next()?, 2)?;
        let seconds = fields.next().map_or(Some(0), |s| number(s, 2))?;
        if fields.next().is_some() || hours > 24 || minutes > 59 || seconds > 59 {
            return None;
        }
        ms += hours * HOUR_MS + minutes * 60_000 + seconds * 1000 + millis - offset_ms;
    }
    Some(ms)
}

/// `new Date(ms).toISOString()`: `2026-11-19T10:00:00.000Z`.
pub fn format_iso_ms(ms: i64) -> String {
    let days = ms.div_euclid(DAY_MS);
    let rest = ms.rem_euclid(DAY_MS);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / HOUR_MS,
        rest % HOUR_MS / 60_000,
        rest % 60_000 / 1000,
        rest % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::super::tasks::{InsightsBreakdownRow, InsightsWeek};
    use super::*;

    fn summary(
        merged: f64,
        tokens: f64,
        lead: f64,
        first: f64,
        wasted: f64,
        rounds: f64,
    ) -> InsightsSummary {
        InsightsSummary {
            merged: Some(merged),
            tokens: Some(tokens),
            lead_time_ms: Some(lead),
            pr_first_pass: Some(first),
            wasted_share: Some(wasted),
            review_rounds: Some(rounds),
            ..InsightsSummary::default()
        }
    }

    fn insights() -> TaskInsights {
        TaskInsights {
            period: InsightsPeriod::Month,
            current: summary(22.0, 900.0, 100.0, 0.58, 0.18, 1.6),
            previous: summary(20.0, 1000.0, 200.0, 0.61, 0.16, 1.8),
            weekly: Vec::new(),
            daily: Vec::new(),
            hourly: Vec::new(),
            by_model: Vec::new(),
        }
    }

    fn result(value: Option<f64>, change: Option<f64>) -> InsightResult {
        InsightResult { value, change }
    }

    fn bucket(date: &str, merged: f64, values: InsightsSummary) -> InsightsBucket {
        InsightsBucket {
            date: date.to_owned(),
            merged,
            values,
        }
    }

    fn point(date: &str, value: f64) -> TrendPoint {
        TrendPoint {
            date: date.to_owned(),
            value,
        }
    }

    #[test]
    fn shows_dashes_for_a_failed_read_and_unreported_numbers() {
        for (_, r) in insight_results(None) {
            assert_eq!(r, result(None, None));
        }
        let i = insights();
        // Orbit's own merge wait starts at settled subtasks, so it is not used.
        assert_eq!(
            insight_result(Some(&i), InsightId::MergeWait),
            result(None, None)
        );
        assert_eq!(
            insight_result(Some(&i), InsightId::Tokens),
            result(None, None)
        );
    }

    #[test]
    fn compares_amounts_in_percent_shares_in_points_and_rounds_as_a_difference() {
        let i = insights();
        let r = |id| insight_result(Some(&i), id);
        assert_eq!(r(InsightId::Completed), result(Some(22.0), Some(10.0)));
        assert_eq!(r(InsightId::Spent), result(Some(900.0), Some(-10.0)));
        assert_eq!(r(InsightId::Wasted), result(Some(0.18), Some(2.0)));
        assert_eq!(r(InsightId::FirstPass), result(Some(0.58), Some(-3.0)));
        assert_eq!(r(InsightId::ReviewRounds), result(Some(1.6), Some(-0.2)));
    }

    #[test]
    fn runs_delivery_time_to_deployed_once_reported_else_to_merged() {
        let i = insights();
        assert_eq!(
            insight_result(Some(&i), InsightId::Delivery),
            result(Some(100.0), Some(-50.0))
        );
        let mut deployed = insights();
        deployed.current.delivery_time_ms = Some(300.0);
        deployed.previous.delivery_time_ms = Some(400.0);
        assert_eq!(
            insight_result(Some(&deployed), InsightId::Delivery),
            result(Some(300.0), Some(-25.0))
        );
    }

    #[test]
    fn colours_a_change_by_which_way_is_good() {
        let tone = |id: InsightId, change| insight_change_tone(id.spec(), change);
        assert_eq!(tone(InsightId::Completed, Some(10.0)), ChangeTone::Good);
        assert_eq!(tone(InsightId::Delivery, Some(10.0)), ChangeTone::Bad);
        assert_eq!(tone(InsightId::Delivery, Some(-10.0)), ChangeTone::Good);
        assert_eq!(tone(InsightId::Spent, Some(40.0)), ChangeTone::Neutral);
        assert_eq!(tone(InsightId::Completed, Some(0.0)), ChangeTone::Neutral);
        assert_eq!(tone(InsightId::Completed, None), ChangeTone::Neutral);
    }

    #[test]
    fn writes_change_and_value_text() {
        let text =
            |id: InsightId, value, change| insight_change_text(id.spec(), result(value, change));
        assert_eq!(
            text(InsightId::Spent, Some(1.0), Some(359.0)).as_deref(),
            Some("+359%")
        );
        assert_eq!(
            text(InsightId::FirstPass, Some(1.0), Some(39.0)).as_deref(),
            Some("+39 pts")
        );
        assert_eq!(
            text(InsightId::Delivery, Some(1.0), Some(-12.0)).as_deref(),
            Some("\u{2212}12%")
        );
        assert_eq!(
            text(InsightId::ReviewRounds, Some(1.0), Some(-0.2)).as_deref(),
            Some("\u{2212}0.2")
        );
        assert_eq!(
            text(InsightId::Completed, Some(1.0), Some(0.0)).as_deref(),
            Some("\u{b1}0%")
        );
        assert_eq!(
            text(InsightId::Completed, Some(1.0), None).as_deref(),
            Some("No earlier data")
        );
        assert_eq!(text(InsightId::Completed, None, None), None);
        assert_eq!(insight_change_trend(Some(-3.0)), Some(true));
        assert_eq!(insight_change_trend(Some(0.0)), None);

        assert_eq!(format_insight_value(InsightId::Completed, 22.4), "22");
        assert_eq!(
            format_insight_value(InsightId::Spent, 1_030_000_000.0),
            "1.03B"
        );
        assert_eq!(
            format_insight_value(InsightId::Tokens, 1_410_000.0),
            "1.41M"
        );
        assert_eq!(
            format_insight_value(InsightId::Delivery, 87_840_000.0),
            "24h 24m"
        );
        assert_eq!(format_insight_value(InsightId::ReviewRounds, 1.25), "1.3");
        assert_eq!(format_insight_value(InsightId::Wasted, 0.155), "16%");
    }

    #[test]
    fn charts_merges_over_a_trailing_window_and_tokens_by_week_without_bucket_values() {
        let daily: Vec<_> = (0..7)
            .map(|i| {
                bucket(
                    &format!("2026-11-1{i}"),
                    f64::from(i),
                    InsightsSummary::default(),
                )
            })
            .collect();
        let week = TaskInsights {
            period: InsightsPeriod::Week,
            daily: daily.clone(),
            ..insights()
        };
        assert_eq!(
            insight_trend(Some(&week), InsightId::Completed),
            Some(vec![
                point("2026-11-10", 0.0),
                point("2026-11-11", 1.0),
                point("2026-11-12", 3.0),
                point("2026-11-13", 6.0),
                point("2026-11-14", 9.0),
                point("2026-11-15", 12.0),
                point("2026-11-16", 15.0),
            ])
        );
        let weekly = vec![
            InsightsWeek {
                week_start: "2026-11-02".to_owned(),
                tokens_per_merged_pr: Some(5.0),
            },
            InsightsWeek {
                week_start: "2026-11-09".to_owned(),
                tokens_per_merged_pr: None,
            },
        ];
        let with_weeks = TaskInsights {
            weekly,
            ..week.clone()
        };
        assert_eq!(
            insight_trend(Some(&with_weeks), InsightId::Tokens),
            Some(vec![point("2026-11-02", 5.0), point("2026-11-09", 0.0)])
        );
        // A number no bucket reports is a flat line at 0, not a missing chart.
        assert_eq!(
            insight_trend(Some(&week), InsightId::Wasted),
            Some(daily.iter().map(|b| point(&b.date, 0.0)).collect())
        );
        let hourly: Vec<_> = (0..24)
            .map(|i| {
                bucket(
                    &format!("2026-11-19T{i:02}:00:00+00:00"),
                    if i < 20 { 0.0 } else { f64::from(i - 20) },
                    InsightsSummary::default(),
                )
            })
            .collect();
        let day = TaskInsights {
            period: InsightsPeriod::Day,
            hourly,
            ..insights()
        };
        let trend = insight_trend(Some(&day), InsightId::Completed).unwrap_or_default();
        assert_eq!(
            trend[trend.len() - 4..].to_vec(),
            vec![
                point("2026-11-19T20:00:00+00:00", 0.0),
                point("2026-11-19T21:00:00+00:00", 1.0),
                point("2026-11-19T22:00:00+00:00", 3.0),
                point("2026-11-19T23:00:00+00:00", 6.0),
            ]
        );
        // An older Orbit answers the 24-hour period without hours: no line, not a daily one.
        let old = TaskInsights {
            period: InsightsPeriod::Day,
            daily,
            ..insights()
        };
        assert_eq!(insight_trend(Some(&old), InsightId::Completed), None);
        assert_eq!(insight_trend(None, InsightId::Completed), None);
    }

    #[test]
    fn charts_every_other_number_as_one_line_with_zero_where_a_bucket_has_none() {
        let values = |merged, lead: Option<f64>, delivery: Option<f64>, rounds: Option<f64>| {
            InsightsSummary {
                merged: Some(merged),
                lead_time_ms: lead,
                delivery_time_ms: delivery,
                review_rounds: rounds,
                ..InsightsSummary::default()
            }
        };
        let daily = vec![
            bucket(
                "2026-11-14",
                2.0,
                values(2.0, Some(600.0), Some(900.0), None),
            ),
            bucket("2026-11-17", 0.0, values(0.0, None, None, None)),
            bucket("2026-11-18", 0.0, values(0.0, None, None, None)),
            bucket("2026-11-19", 1.0, values(1.0, Some(300.0), None, Some(2.0))),
        ];
        let week = TaskInsights {
            period: InsightsPeriod::Week,
            daily,
            ..insights()
        };
        assert_eq!(
            insight_trend(Some(&week), InsightId::Delivery),
            Some(vec![
                point("2026-11-13", 0.0),
                point("2026-11-14", 900.0),
                point("2026-11-15", 0.0),
                point("2026-11-16", 0.0),
                point("2026-11-17", 0.0),
                point("2026-11-18", 0.0),
                point("2026-11-19", 300.0),
            ])
        );
        assert_eq!(
            insight_trend(Some(&week), InsightId::Completed).map(|t| t.len()),
            Some(7)
        );
        assert_eq!(
            insight_result(Some(&week), InsightId::MergeWait),
            result(None, None)
        );
        let tokens = |tokens| InsightsSummary {
            merged: Some(1.0),
            tokens: Some(tokens),
            ..InsightsSummary::default()
        };
        let day = TaskInsights {
            period: InsightsPeriod::Day,
            hourly: vec![
                bucket("2026-11-19T10:00:00+00:00", 1.0, tokens(400.0)),
                bucket("2026-11-19T12:00:00+00:00", 1.0, tokens(600.0)),
            ],
            ..insights()
        };
        let line = insight_trend(Some(&day), InsightId::Spent).unwrap_or_default();
        assert_eq!(line.len(), 24);
        assert_eq!(line[0], point("2026-11-18T13:00:00+00:00", 0.0));
        assert_eq!(
            line[21..].to_vec(),
            vec![
                point("2026-11-19T10:00:00+00:00", 400.0),
                point("2026-11-19T11:00:00+00:00", 0.0),
                point("2026-11-19T12:00:00+00:00", 600.0),
            ]
        );
    }

    #[test]
    fn splits_by_provider_weighting_models_by_merges() {
        let row = |key: &str, merged: f64, tokens: Option<f64>| InsightsBreakdownRow {
            key: key.to_owned(),
            label: key.to_owned(),
            tasks: Some(merged),
            merged: Some(merged),
            tokens_per_merged_pr: tokens,
            lead_time_ms: None,
        };
        let i = TaskInsights {
            by_model: vec![
                row("claude-opus-5-5", 3.0, Some(100.0)),
                row("gpt-5.5-codex", 2.0, Some(50.0)),
                row("claude-sonnet-5-5", 1.0, Some(200.0)),
                row("some-local-model", 4.0, Some(10.0)),
            ],
            ..insights()
        };
        let pv = |provider, value| ProviderValue { provider, value };
        assert_eq!(
            insight_by_provider(Some(&i), InsightId::Tokens),
            vec![
                pv(InsightProvider::Codex, Some(50.0)),
                pv(InsightProvider::Claude, Some(125.0))
            ]
        );
        assert_eq!(
            insight_by_provider(Some(&i), InsightId::Completed),
            vec![
                pv(InsightProvider::Codex, Some(2.0)),
                pv(InsightProvider::Claude, Some(4.0))
            ]
        );
        assert_eq!(
            insight_by_provider(Some(&i), InsightId::Delivery),
            vec![
                pv(InsightProvider::Codex, None),
                pv(InsightProvider::Claude, None)
            ]
        );
        assert_eq!(insight_by_provider(Some(&i), InsightId::Wasted), vec![]);
        assert_eq!(
            InsightProvider::of_model("o3-mini"),
            Some(InsightProvider::Codex)
        );
        assert_eq!(
            InsightProvider::of_model("gemini-3-pro"),
            Some(InsightProvider::Gemini)
        );
        assert_eq!(InsightProvider::Claude.name(), "Claude");
    }

    #[test]
    fn scales_charts() {
        assert_eq!(extent(&[5.0, 5.0]), (4.5, 5.5));
        assert_eq!(extent(&[0.0, 0.0]), (-1.0, 1.0));
        let scale = nice_scale(0.0, 7.0);
        assert_eq!(scale.ticks, vec![0.0, 2.5, 5.0, 7.5]);
        assert_eq!((scale.low, scale.high), (0.0, 7.5));
        let flat = nice_scale(0.0, 0.0);
        assert_eq!((flat.low, flat.high), (0.0, 0.1));
        assert!(sparkline_points(&[point("a", 1.0)], 100.0).is_empty());
        let placed = sparkline_points(&[point("a", 0.0), point("b", 10.0)], 102.0);
        assert_eq!(placed[0].0, 1.0);
        assert_eq!(placed[1].0, 101.0);
        assert!(placed[0].1 > placed[1].1);
    }

    #[test]
    fn parses_and_formats_dates() {
        assert_eq!(parse_date_ms("1970-01-02"), Some(DAY_MS));
        assert_eq!(
            parse_date_ms("2026-11-19T10:00:00+00:00"),
            parse_date_ms("2026-11-19T10:00:00.000Z")
        );
        assert_eq!(
            parse_date_ms("2026-11-19T12:00:00+02:00"),
            parse_date_ms("2026-11-19T10:00:00Z")
        );
        assert_eq!(parse_date_ms("nope"), None);
        let ms = parse_date_ms("2026-11-19").unwrap_or_default();
        assert_eq!(format_iso_ms(ms), "2026-11-19T00:00:00.000Z");
        assert_eq!(format_iso_ms(ms - HOUR_MS), "2026-11-18T23:00:00.000Z");
        assert_eq!(
            format_iso_ms(parse_date_ms("2024-02-29").unwrap_or_default())[..10],
            *"2024-02-29"
        );
    }
}
