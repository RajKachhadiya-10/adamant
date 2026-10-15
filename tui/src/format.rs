use crate::api::{AuditEvent, RunDetail, RunSummary, SseEvent, User};
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tone {
    Normal,
    Muted,
    Error,
    Success,
    Accent,
    Link,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Out {
    Ask(String),
    /// The agent's reply. It grows while the reply streams and may hold newlines.
    Agent(String),
    Line {
        tone: Tone,
        text: String,
    },
    /// "Worked for 7s • 12:53 PM" under a finished turn.
    Worked(String),
}

impl Out {
    pub fn line(tone: Tone, text: impl Into<String>) -> Self {
        Out::Line {
            tone,
            text: text.into(),
        }
    }

    pub fn plain(&self) -> String {
        match self {
            Out::Ask(text) => format!("> {text}"),
            Out::Agent(text) | Out::Line { text, .. } | Out::Worked(text) => text.clone(),
        }
    }
}

pub fn status_tone(status: &str) -> Tone {
    match status {
        "succeeded" => Tone::Success,
        "failed" | "aborted" => Tone::Error,
        "running" | "publishing" => Tone::Accent,
        "queued" | "report_only" => Tone::Muted,
        _ => Tone::Normal,
    }
}

pub fn format_run_row(run: &RunSummary, now_ms: i64) -> String {
    format!(
        "{:<18} {:<8}  {}  {}",
        run.status,
        short_id(&run.id),
        brief(&run.target_branch, 28),
        ago(&run.updated_at, now_ms)
    )
}

pub fn format_run_detail(detail: &RunDetail) -> Vec<Out> {
    let run = &detail.run;
    let mut lines = vec![
        Out::line(
            status_tone(&run.status),
            format!("{}  {}", run.status, run.id),
        ),
        Out::line(Tone::Muted, format!("repo    {}", run.repository_id)),
        Out::line(Tone::Muted, format!("branch  {}", run.target_branch)),
        Out::line(Tone::Muted, format!("source  {}", run.source_sha)),
        Out::line(
            Tone::Muted,
            format!("created {}", ago(&run.created_at, now_ms())),
        ),
        Out::line(
            Tone::Muted,
            format!("updated {}", ago(&run.updated_at, now_ms())),
        ),
        Out::line(Tone::Normal, ""),
    ];
    if detail.audit_events.is_empty() {
        lines.push(Out::line(Tone::Muted, "No audit events yet."));
    } else {
        for event in &detail.audit_events {
            lines.push(format_audit(event));
        }
    }
    lines
}

pub fn format_audit(event: &AuditEvent) -> Out {
    Out::line(
        Tone::Normal,
        format!("{}  {}", clock(&event.created_at), event.event_type),
    )
}

pub fn format_user(user: &User) -> Vec<Out> {
    let email = user
        .email
        .as_deref()
        .filter(|email| !email.is_empty())
        .unwrap_or("no email");
    vec![
        Out::line(Tone::Normal, format!("{}  {email}", user.username)),
        Out::line(
            Tone::Muted,
            format!(
                "providers  {}",
                if user.providers.is_empty() {
                    "none".into()
                } else {
                    user.providers.join(", ")
                }
            ),
        ),
    ]
}

/// One feed event as a heal status line, or `None` for deliveries the audit
/// events already describe (every workflow_run and pull_request webhook).
pub fn activity_line(event: &SseEvent) -> Option<Out> {
    let data: Value = serde_json::from_str(&event.data).unwrap_or(Value::Null);
    let kind = event.event.as_deref().unwrap_or("event");
    let (source, name) = kind.split_once(':').unwrap_or(("", kind));
    let when = clock(
        data.get("createdAt")
            .or_else(|| data.get("receivedAt"))
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    if source == "webhook" {
        return match name {
            "workflow_run" | "pull_request" | "ping" => None,
            other => Some(Out::line(
                Tone::Muted,
                format!("{when}  GitHub sent {}", other.replace('_', " ")),
            )),
        };
    }
    let run = short_id(data.get("runId").and_then(Value::as_str).unwrap_or("")).to_string();
    let detail = data.get("payload").cloned().unwrap_or(Value::Null);
    let text = |key: &str| detail.get(key).and_then(Value::as_str).map(str::to_string);
    let number = |key: &str| detail.get(key).and_then(Value::as_i64);
    let pr = number("prNumber")
        .map(|n| format!("PR #{n}"))
        .unwrap_or_else(|| "the PR".into());
    let (tone, line) = match name {
        "run.queued" => {
            let repo = text("repository")
                .map(|repo| format!(" · {repo}"))
                .unwrap_or_default();
            let sha = text("sourceSha")
                .map(|sha| format!(" @ {}", short_id(&sha).chars().take(7).collect::<String>()))
                .unwrap_or_default();
            // The worker's sync found a red build GitHub never sent a webhook for.
            let via = if text("via").as_deref() == Some("sync") {
                " (found by sync)"
            } else {
                ""
            };
            (Tone::Accent, format!("● Heal {run} queued{repo}{sha}{via}"))
        }
        "run.started" => {
            let retry = detail.get("retry").and_then(Value::as_bool) == Some(true);
            (
                Tone::Normal,
                format!("  {run} started{}", if retry { " again" } else { "" }),
            )
        }
        "run.retrieved" => {
            let at = text("location")
                .map(|at| format!(" at {at}"))
                .unwrap_or_default();
            (Tone::Normal, format!("  {run} read the failing log{at}"))
        }
        "run.sandboxed" => {
            let attempt = number("attempt").unwrap_or(1);
            match text("verdict").as_deref() {
                Some("pass") => (
                    Tone::Success,
                    format!("  {run} attempt {attempt}: sandbox passed"),
                ),
                verdict => (
                    Tone::Muted,
                    format!(
                        "  {run} attempt {attempt}: sandbox {}, trying again",
                        verdict.unwrap_or("failed")
                    ),
                ),
            }
        }
        "run.pr_opened" => {
            let url = text("prUrl")
                .map(|url| format!("  {url}"))
                .unwrap_or_default();
            (Tone::Link, format!("  {run} opened {pr}{url}"))
        }
        "run.investigated" => (
            Tone::Normal,
            format!("  {run} read the code and named the cause"),
        ),
        "run.agent_tried" => {
            let verdict = text("verdict")
                .map(|verdict| format!(": {verdict}"))
                .unwrap_or_default();
            (
                Tone::Muted,
                format!("  {run} tried a fix in the sandbox{verdict}"),
            )
        }
        // Manual mode: the heal stops at an open PR until the user merges or closes it.
        "run.awaiting_review" => {
            let url = text("prUrl")
                .map(|url| format!("  {url}"))
                .unwrap_or_default();
            (
                Tone::Link,
                format!("● {run} opened {pr} for your review{url}"),
            )
        }
        // The status change that goes with run.awaiting_review.
        "run.awaiting_hitl" => return None,
        "run.aborted" => (
            Tone::Muted,
            format!("✗ {run} {pr} was closed without merging"),
        ),
        "run.merged" if text("by").as_deref() == Some("review") => {
            (Tone::Success, format!("✓ {run} {pr} merged by you"))
        }
        "run.merged" => (Tone::Success, format!("✓ {run} merged {pr}")),
        "run.succeeded" => (Tone::Success, format!("✓ Heal {run} succeeded")),
        "run.failed" => {
            let why = text("reason")
                .map(|why| format!(": {}", brief(&why, 160)))
                .unwrap_or_default();
            (Tone::Error, format!("✗ Heal {run} failed{why}"))
        }
        "run.gave_up" => {
            let attempts = number("attempts").unwrap_or(0);
            (
                Tone::Error,
                format!("✗ {run} gave up after {attempts} attempt(s) without a passing sandbox"),
            )
        }
        "run.publish_failed" => {
            let why = text("error")
                .map(|why| format!(": {}", brief(&why, 160)))
                .unwrap_or_default();
            (Tone::Error, format!("✗ {run} could not open the PR{why}"))
        }
        "run.merge_failed" => {
            let why = text("error")
                .map(|why| format!(": {}", brief(&why, 160)))
                .unwrap_or_default();
            (Tone::Error, format!("✗ {run} could not merge {pr}{why}"))
        }
        "pull_request.merged" => {
            if detail.get("ours").and_then(Value::as_bool) == Some(true) {
                (Tone::Muted, format!("  GitHub confirmed the merge of {pr}"))
            } else {
                (
                    Tone::Muted,
                    format!("  {pr} merged on GitHub (not an Adamant heal)"),
                )
            }
        }
        other if run.is_empty() => (Tone::Normal, format!("  {other}")),
        other => (Tone::Normal, format!("  {run} {other}")),
    };
    Some(Out::line(tone, format!("{when}  {line}")))
}

/// When the event happened, for dropping the history a quiet watch replays.
pub fn activity_ms(event: &SseEvent) -> Option<i64> {
    let data: Value = serde_json::from_str(&event.data).ok()?;
    let at = data
        .get("createdAt")
        .or_else(|| data.get("receivedAt"))
        .and_then(Value::as_str)?;
    parse_unix_ms(at)
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn ago(iso: &str, now_ms: i64) -> String {
    let Some(then) = parse_unix_ms(iso) else {
        return clock(iso);
    };
    let secs = ((now_ms - then) / 1000).max(0);
    if secs < 5 {
        "now".into()
    } else if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 48 * 3600 {
        format!("{}h", secs / 3600)
    } else {
        format!("{}d", secs / 86400)
    }
}

/// "7s", "1m 05s", "1h 02m 03s", as Codex counts a turn.
pub fn elapsed(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m {:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h {:02}m {:02}s", secs / 3600, secs / 60 % 60, secs % 60)
    }
}

/// The wall clock as "12:53 PM", in local time.
#[cfg(unix)]
pub fn local_clock() -> String {
    // SAFETY: time and localtime_r only write into values this function owns.
    let tm = unsafe {
        let now = libc::time(std::ptr::null_mut());
        let mut tm: libc::tm = std::mem::zeroed();
        if libc::localtime_r(&now, &mut tm).is_null() {
            return String::new();
        }
        tm
    };
    twelve_hour(tm.tm_hour as u32, tm.tm_min as u32)
}

/// UTC: std has no time zones, and this is only a label.
#[cfg(not(unix))]
pub fn local_clock() -> String {
    let secs = (now_ms() / 1000).max(0) as u64;
    twelve_hour((secs / 3600 % 24) as u32, (secs / 60 % 60) as u32)
}

fn twelve_hour(hour: u32, minute: u32) -> String {
    let half = if hour < 12 { "AM" } else { "PM" };
    let hour = match hour % 12 {
        0 => 12,
        other => other,
    };
    format!("{hour}:{minute:02} {half}")
}

pub fn clock(iso: &str) -> String {
    iso.split_once('T')
        .and_then(|(_, rest)| {
            let time = rest.trim_end_matches('Z');
            let hms = time.split(['.', '+', '-']).next().unwrap_or(time);
            let mut parts = hms.split(':');
            Some(format!("{}:{}", parts.next()?, parts.next()?))
        })
        .unwrap_or_else(|| "--:--".into())
}

pub fn short_id(id: &str) -> &str {
    if id.is_ascii() && id.len() > 8 {
        &id[..8]
    } else {
        id
    }
}

pub fn row_count(text: &str, width: usize) -> usize {
    if width == 0 {
        return 1;
    }
    text.split('\n')
        .map(|line| {
            unicode_width::UnicodeWidthStr::width(line)
                .div_ceil(width)
                .max(1)
        })
        .sum()
}

pub fn brief(value: &str, max: usize) -> String {
    if value.chars().count() <= max {
        return value.to_string();
    }
    let head: String = value.chars().take(max.saturating_sub(1)).collect();
    format!("{head}…")
}

fn parse_unix_ms(value: &str) -> Option<i64> {
    let (date, rest) = value.split_once('T')?;
    let mut date_parts = date.split('-');
    let year: i32 = date_parts.next()?.parse().ok()?;
    let month: i32 = date_parts.next()?.parse().ok()?;
    let day: i32 = date_parts.next()?.parse().ok()?;
    let time = rest.trim_end_matches('Z');
    let hms = time.split(['.', '+']).next()?.split('-').next()?;
    let mut clock = hms.split(':');
    let hour: i32 = clock.next()?.parse().ok()?;
    let minute: i32 = clock.next()?.parse().ok()?;
    let second: i32 = clock.next().unwrap_or("0").parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || !(0..24).contains(&hour) {
        return None;
    }
    let days = days_from_civil(year, month, day);
    let secs = days * 86_400 + hour as i64 * 3600 + minute as i64 * 60 + second as i64;
    let millis = time
        .split_once('.')
        .and_then(|(_, frac)| frac.chars().take(3).collect::<String>().parse::<i64>().ok())
        .unwrap_or(0);
    Some(secs * 1000 + millis)
}

fn days_from_civil(year: i32, month: i32, day: i32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = (year - era * 400) as u64;
    let month_part = if month > 2 { month - 3 } else { month + 9 } as u64;
    let day_of_year = (153 * month_part + 2) / 5 + day as u64 - 1;
    let day_of_era = yoe * 365 + yoe / 4 - yoe / 100 + day_of_year;
    era as i64 * 146_097 + day_of_era as i64 - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(kind: &str, data: &str) -> SseEvent {
        SseEvent {
            id: None,
            event: Some(kind.into()),
            data: data.into(),
        }
    }

    #[test]
    fn heal_events_read_as_status() {
        let queued = event(
            "audit:run.queued",
            r#"{"runId":"1a2b3c4d-0000","createdAt":"2026-10-15T09:30:00.000Z","payload":{"repository":"vaish/app","sourceSha":"abcdef1234567890"}}"#,
        );
        assert_eq!(
            activity_line(&queued).unwrap().plain(),
            "09:30  ● Heal 1a2b3c4d queued · vaish/app @ abcdef1"
        );
        let opened = event(
            "audit:run.pr_opened",
            r#"{"runId":"1a2b3c4d-0000","createdAt":"2026-10-15T09:31:00.000Z","payload":{"prNumber":12,"prUrl":"https://github.com/vaish/app/pull/12"}}"#,
        );
        assert_eq!(
            activity_line(&opened).unwrap().plain(),
            "09:31    1a2b3c4d opened PR #12  https://github.com/vaish/app/pull/12"
        );
        let merged = event(
            "audit:run.merged",
            r#"{"runId":"1a2b3c4d-0000","createdAt":"2026-10-15T09:32:00.000Z","payload":{"prNumber":12}}"#,
        );
        assert_eq!(
            activity_line(&merged),
            Some(Out::line(Tone::Success, "09:32  ✓ 1a2b3c4d merged PR #12"))
        );
        let delivery = event(
            "webhook:workflow_run",
            r#"{"receivedAt":"2026-10-15T09:29:00.000Z"}"#,
        );
        assert_eq!(activity_line(&delivery), None);
        assert!(activity_ms(&merged).unwrap() > activity_ms(&delivery).unwrap());
    }

    fn line(kind: &str, payload: &str) -> Option<Out> {
        activity_line(&event(
            kind,
            &format!(
                r#"{{"runId":"1a2b3c4d-0000","createdAt":"2026-10-15T09:40:00.000Z","payload":{payload}}}"#
            ),
        ))
    }

    #[test]
    fn manual_mode_heals_wait_for_review() {
        assert_eq!(
            line(
                "audit:run.awaiting_review",
                r#"{"prNumber":12,"prUrl":"https://github.com/vaish/app/pull/12"}"#
            ),
            Some(Out::line(
                Tone::Link,
                "09:40  ● 1a2b3c4d opened PR #12 for your review  https://github.com/vaish/app/pull/12"
            ))
        );
        assert_eq!(
            line("audit:run.awaiting_review", "{}").unwrap().plain(),
            "09:40  ● 1a2b3c4d opened the PR for your review"
        );
        assert_eq!(line("audit:run.awaiting_hitl", r#"{"prNumber":12}"#), None);
        assert_eq!(
            line(
                "audit:run.aborted",
                r#"{"prNumber":12,"reason":"pr_closed"}"#
            ),
            Some(Out::line(
                Tone::Muted,
                "09:40  ✗ 1a2b3c4d PR #12 was closed without merging"
            ))
        );
        assert_eq!(
            line("audit:run.merged", r#"{"prNumber":12,"by":"review"}"#),
            Some(Out::line(
                Tone::Success,
                "09:40  ✓ 1a2b3c4d PR #12 merged by you"
            ))
        );
        assert_eq!(
            line("audit:run.merged", r#"{"prNumber":12,"by":"agent"}"#)
                .unwrap()
                .plain(),
            "09:40  ✓ 1a2b3c4d merged PR #12"
        );
    }

    #[test]
    fn sync_and_sandbox_tries_read_as_status() {
        assert_eq!(
            line(
                "audit:run.queued",
                r#"{"repository":"vaish/app","sourceSha":"abcdef1234567890","via":"sync"}"#
            )
            .unwrap()
            .plain(),
            "09:40  ● Heal 1a2b3c4d queued · vaish/app @ abcdef1 (found by sync)"
        );
        assert_eq!(
            line("audit:run.queued", r#"{"via":"webhook"}"#)
                .unwrap()
                .plain(),
            "09:40  ● Heal 1a2b3c4d queued"
        );
        assert_eq!(
            line(
                "audit:run.agent_tried",
                r#"{"try":2,"verdict":"did not apply"}"#
            ),
            Some(Out::line(
                Tone::Muted,
                "09:40    1a2b3c4d tried a fix in the sandbox: did not apply"
            ))
        );
        assert_eq!(
            line("audit:run.agent_tried", r#"{"try":1}"#)
                .unwrap()
                .plain(),
            "09:40    1a2b3c4d tried a fix in the sandbox"
        );
        assert_eq!(
            line("audit:run.investigated", "{}").unwrap().plain(),
            "09:40    1a2b3c4d read the code and named the cause"
        );
    }

    #[test]
    fn counts_a_turn_like_codex() {
        assert_eq!(elapsed(3), "3s");
        assert_eq!(elapsed(65), "1m 05s");
        assert_eq!(elapsed(3723), "1h 02m 03s");
        assert_eq!(twelve_hour(0, 5), "12:05 AM");
        assert_eq!(twelve_hour(12, 53), "12:53 PM");
        assert_eq!(twelve_hour(23, 0), "11:00 PM");
    }

    #[test]
    fn formats_age_from_iso() {
        let then = parse_unix_ms("2026-10-15T00:00:00.000Z").unwrap();
        assert_eq!(ago("2026-10-15T00:00:00.000Z", then + 90_000), "1m");
        assert_eq!(clock("2026-10-15T00:12:33.000Z"), "00:12");
    }
}
