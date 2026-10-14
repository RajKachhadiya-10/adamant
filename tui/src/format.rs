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
    Line { tone: Tone, text: String },
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
            Out::Line { text, .. } => text.clone(),
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

pub fn format_activity(event: &SseEvent) -> String {
    let payload: Value = serde_json::from_str(&event.data).unwrap_or(Value::Null);
    let when = payload
        .get("createdAt")
        .or_else(|| payload.get("receivedAt"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let name = event
        .event
        .as_deref()
        .and_then(|kind| kind.split_once(':').map(|(_, rest)| rest))
        .unwrap_or(event.event.as_deref().unwrap_or("event"));
    let run = payload.get("runId").and_then(Value::as_str).unwrap_or("");
    let extra = if !run.is_empty() {
        short_id(run).to_string()
    } else {
        payload
            .get("processingStatus")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    if extra.is_empty() {
        format!("{}  {name}", clock(when))
    } else {
        format!("{}  {name}  {extra}", clock(when))
    }
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
    if text.is_empty() || width == 0 {
        return 1;
    }
    unicode_width::UnicodeWidthStr::width(text)
        .div_ceil(width)
        .max(1)
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

    #[test]
    fn formats_age_from_iso() {
        let then = parse_unix_ms("2026-10-15T00:00:00.000Z").unwrap();
        assert_eq!(ago("2026-10-15T00:00:00.000Z", then + 90_000), "1m");
        assert_eq!(clock("2026-10-15T00:12:33.000Z"), "00:12");
    }
}
