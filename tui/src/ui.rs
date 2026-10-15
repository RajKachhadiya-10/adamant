use std::time::Duration;

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Paragraph};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{App, Overlay};
use crate::format::{self, status_tone, Out, Tone};
use crate::theme::{palette, COMPOSER_ROWS, FOOTER_ROWS};

const PLACEHOLDER: &str = "Ask Adamant to do anything";
/// One pass of the highlight across "Working".
const SWEEP: Duration = Duration::from_secs(2);
/// Half the highlight's width, in columns.
const BAND: f32 = 3.0;
const BLINK_MS: u128 = 600;

pub fn draw(frame: &mut Frame, app: &App) {
    let p = palette();
    let area = frame.area();
    frame.render_widget(Block::new().style(Style::new().bg(p.canvas)), area);
    if area.height <= FOOTER_ROWS || area.width < 8 {
        return;
    }

    let [body, footer] =
        Layout::vertical([Constraint::Min(1), Constraint::Length(FOOTER_ROWS)]).areas(area);
    let [composer, status, hints] = Layout::vertical([
        Constraint::Length(COMPOSER_ROWS),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .areas(footer);

    // A blank row always parts the transcript from the composer, so a prompt's gray block
    // never runs into it. While work runs, Codex's status row takes the row under it.
    let status_row = app.working() && app.pending.is_none() && body.height > 2;
    let content = Rect {
        height: body.height.saturating_sub(if status_row { 2 } else { 1 }),
        ..body
    };

    if app.lines.is_empty() {
        let used = app
            .notice
            .as_ref()
            .map(|notice| render_notice(frame, body, notice))
            .unwrap_or(0);
        let top = if app.notice.is_some() {
            used
        } else {
            1.min(body.height.saturating_sub(2))
        };
        render_welcome(frame, body, top, app);
    } else {
        render_transcript(frame, content, app);
    }
    if status_row {
        let row = Rect {
            x: body.x + 1,
            y: body.y + body.height - 1,
            width: body.width.saturating_sub(1),
            height: 1,
        };
        frame.render_widget(
            Paragraph::new(working_line(app)).style(Style::new().bg(p.canvas)),
            row,
        );
    }

    frame.render_widget(Block::new().style(Style::new().bg(p.bar)), composer);
    let prompt = Rect {
        x: composer.x,
        y: composer.y + composer.height / 2,
        width: composer.width,
        height: 1,
    };
    frame.render_widget(
        Paragraph::new(composer_line(app, prompt.width)).style(Style::new().bg(p.bar)),
        prompt,
    );
    frame.render_widget(
        Paragraph::new(status_line(app, status.width)).style(Style::new().bg(p.canvas)),
        status,
    );
    frame.render_widget(
        Paragraph::new(hint_line(app)).style(Style::new().bg(p.canvas)),
        hints,
    );

    if let Some(pending) = &app.pending {
        render_approval(frame, body, pending);
    } else if app.overlay == Overlay::Shortcuts {
        render_shortcuts(frame, body);
    } else if app.overlay == Overlay::Runs {
        render_runs(frame, body, app);
    } else if app.overlay == Overlay::Repos {
        render_repos(frame, body, app);
    } else if !app.suggestions().is_empty() {
        render_slash(frame, body, app);
    }
}

fn render_welcome(frame: &mut Frame, body: Rect, top: u16, app: &App) {
    let p = palette();
    if body.height <= top || body.width < 4 {
        return;
    }
    let rect = Rect {
        x: body.x + 1,
        y: body.y + top,
        width: body.width.saturating_sub(1),
        height: 3.min(body.height - top),
    };
    let model = match &app.model {
        Some(model) => format!("model {model} · {}", mode(app)),
        None => "no model: set OPENAI_API_KEY to work with the agent".into(),
    };
    let lines = vec![
        Line::from(vec![
            Span::styled(">_ ", Style::new().fg(p.accent).bg(p.canvas)),
            Span::styled("Adamant", Style::new().fg(p.accent).bg(p.canvas)),
            Span::styled(
                format!(" (v{})", app.version),
                Style::new().fg(p.dim).bg(p.canvas),
            ),
        ]),
        Line::from(Span::styled(
            app.cwd.clone(),
            Style::new().fg(p.dim).bg(p.canvas),
        )),
        Line::from(Span::styled(model, Style::new().fg(p.dim).bg(p.canvas))),
    ];
    frame.render_widget(Paragraph::new(lines).style(Style::new().bg(p.canvas)), rect);
}

fn mode(app: &App) -> &'static str {
    if app.auto {
        "auto"
    } else {
        "manual"
    }
}

fn render_notice(frame: &mut Frame, body: Rect, notice: &crate::app::Notice) -> u16 {
    let p = palette();
    let inner_rows = 2 + notice.lines.len();
    let height = inner_rows as u16 + 2;
    if body.height < height + 3 || body.width < 24 {
        return 0;
    }
    let width = body.width.min(62);
    let rect = Rect {
        x: body.x + 1,
        y: body.y,
        width: width.saturating_sub(1),
        height,
    };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(p.border))
        .style(Style::new().bg(p.canvas));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let mut lines = vec![
        Line::from(vec![
            Span::styled("✦  ", Style::new().fg(p.accent).bg(p.canvas)),
            Span::styled(notice.title.clone(), Style::new().fg(p.accent).bg(p.canvas)),
        ]),
        Line::from(Span::styled(" ", Style::new().bg(p.canvas))),
    ];
    for line in &notice.lines {
        let color = if line.starts_with("http://") || line.starts_with("https://") {
            p.blue
        } else {
            p.ink
        };
        lines.push(Line::from(Span::styled(
            line.clone(),
            Style::new().fg(color).bg(p.canvas),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines).style(Style::new().bg(p.canvas)),
        inner,
    );
    height.saturating_add(1)
}

fn render_transcript(frame: &mut Frame, body: Rect, app: &App) {
    let p = palette();
    let wrapped = wrap_outs(&app.lines, body.width as usize);
    let view = body.height as usize;
    if view == 0 || wrapped.is_empty() {
        return;
    }
    let max_scroll = wrapped.len().saturating_sub(view);
    let scroll = app.scroll.min(max_scroll);
    let end = wrapped.len().saturating_sub(scroll);
    let start = end.saturating_sub(view);
    let visible = wrapped[start..end].to_vec();
    let height = visible.len() as u16;
    let rect = Rect {
        height: height.min(body.height),
        ..body
    };
    frame.render_widget(
        Paragraph::new(visible).style(Style::new().bg(p.canvas)),
        rect,
    );
}

/// Codex's cells: each prompt in a gray block like the composer, replies and notes under
/// a dim bullet, a blank row between cells. `cols` is the full row, margin included.
fn wrap_outs(lines: &[Out], cols: usize) -> Vec<Line<'static>> {
    let p = palette();
    let mut rows = Vec::new();
    let mut in_notes = false;
    // Tool calls arrive as "• Ran …" plus indented output, already laid out as a cell.
    let mut own_bullet = false;
    for line in lines {
        let starts_cell = match line {
            Out::Line { text, .. } => !in_notes || text.starts_with("• "),
            _ => true,
        };
        if starts_cell && !rows.is_empty() {
            rows.push(Line::from(Span::styled("", Style::new().bg(p.canvas))));
        }
        in_notes = matches!(line, Out::Line { .. });
        match line {
            Out::Ask(text) => rows.extend(ask_rows(text, cols)),
            Out::Agent(text) => rows.extend(hang(text, "• ", p.ink, cols)),
            Out::Worked(text) => rows.extend(hang(text, "  ", p.dim, cols)),
            Out::Line { tone, text } => {
                let color = tone_color(*tone);
                if starts_cell {
                    own_bullet = text.starts_with("• ");
                }
                let rows_for = match (starts_cell, own_bullet) {
                    (true, true) => {
                        hang(text.strip_prefix("• ").unwrap_or(text), "• ", color, cols)
                    }
                    (false, true) => hang(text, "", color, cols),
                    (true, false) => hang(text, "• ", color, cols),
                    (false, false) => hang(text, "  ", color, cols),
                };
                rows.extend(rows_for);
            }
        }
    }
    rows
}

/// A column of margin, `lead` on the first row and an indent as wide under it.
fn hang(text: &str, lead: &str, color: Color, cols: usize) -> Vec<Line<'static>> {
    let p = palette();
    let indent = UnicodeWidthStr::width(lead);
    let width = cols.saturating_sub(2 + indent).max(1);
    wrap(text, width)
        .into_iter()
        .enumerate()
        .map(|(index, row)| {
            let head = if index == 0 {
                format!(" {lead}")
            } else {
                " ".repeat(1 + indent)
            };
            Line::from(vec![
                Span::styled(head, Style::new().fg(p.dim).bg(p.canvas)),
                Span::styled(row, Style::new().fg(color).bg(p.canvas)),
            ])
        })
        .collect()
}

/// The prompt as Codex echoes it: full width on the composer's gray, a row of padding
/// above and below.
fn ask_rows(text: &str, cols: usize) -> Vec<Line<'static>> {
    let p = palette();
    let fill = Style::new().fg(p.ink).bg(p.bar);
    let pad = || Line::from(Span::styled(" ".repeat(cols), fill));
    let mut rows = vec![pad()];
    for (index, row) in wrap(text, cols.saturating_sub(4).max(1))
        .into_iter()
        .enumerate()
    {
        let used = 3 + UnicodeWidthStr::width(row.as_str());
        rows.push(Line::from(vec![
            Span::styled(
                if index == 0 { " › " } else { "   " },
                Style::new().fg(p.muted).bg(p.bar),
            ),
            Span::styled(row, fill),
            Span::styled(" ".repeat(cols.saturating_sub(used)), fill),
        ]));
    }
    rows.push(pad());
    rows
}

/// Codex's status row: a blinking bullet, "Working" under a sweeping highlight, the time
/// so far and how to stop it.
fn working_line(app: &App) -> Line<'static> {
    let p = palette();
    let elapsed = app
        .working_since()
        .map(|since| since.elapsed())
        .unwrap_or_default();
    let motion = app.animating();
    let lit = !motion || (elapsed.as_millis() / BLINK_MS) % 2 == 0;
    let mut spans = vec![Span::styled(
        if lit { "• " } else { "◦ " },
        Style::new()
            .fg(if lit { p.ink } else { p.dim })
            .bg(p.canvas),
    )];
    if motion {
        spans.extend(shimmer("Working", elapsed));
    } else {
        spans.push(Span::styled(
            "Working",
            Style::new()
                .fg(p.ink)
                .bg(p.canvas)
                .add_modifier(Modifier::BOLD),
        ));
    }
    spans.push(Span::styled(
        format!(" ({} • ", format::elapsed(elapsed.as_secs())),
        Style::new().fg(p.dim).bg(p.canvas),
    ));
    spans.push(Span::styled(
        "esc",
        Style::new()
            .fg(p.key)
            .bg(p.canvas)
            .add_modifier(Modifier::BOLD),
    ));
    spans.push(Span::styled(
        " to interrupt)",
        Style::new().fg(p.dim).bg(p.canvas),
    ));
    Line::from(spans)
}

/// Each character turns toward the glow (lighter on dark, darker on light) as a band passes
/// over it. The band starts and ends off the word, so the pass reads as a sweep rather than
/// a jump.
fn shimmer(text: &str, elapsed: Duration) -> Vec<Span<'static>> {
    let p = palette();
    let chars: Vec<char> = text.chars().collect();
    let travel = chars.len() as f32 + 4.0 * BAND;
    let phase = (elapsed.as_millis() % SWEEP.as_millis()) as f32 / SWEEP.as_millis() as f32;
    let at = phase * travel - 2.0 * BAND;
    chars
        .into_iter()
        .enumerate()
        .map(|(index, ch)| {
            let distance = (index as f32 - at).abs();
            let glow = if distance < BAND {
                0.5 * (1.0 + (std::f32::consts::PI * distance / BAND).cos())
            } else {
                0.0
            };
            Span::styled(
                ch.to_string(),
                Style::new()
                    .fg(mix(p.muted, p.glow, glow))
                    .bg(p.canvas)
                    .add_modifier(Modifier::BOLD),
            )
        })
        .collect()
}

fn mix(from: Color, to: Color, amount: f32) -> Color {
    match (from, to) {
        (Color::Rgb(r1, g1, b1), Color::Rgb(r2, g2, b2)) => {
            let blend = |a: u8, b: u8| (a as f32 + (b as f32 - a as f32) * amount).round() as u8;
            Color::Rgb(blend(r1, r2), blend(g1, g2), blend(b1, b2))
        }
        _ if amount >= 0.5 => to,
        _ => from,
    }
}

/// Breaks at newlines, then at the last space that fits, else mid-word.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut rows = Vec::new();
    for line in text.split('\n') {
        wrap_line(
            &line.trim_end_matches('\r').replace('\t', "    "),
            width,
            &mut rows,
        );
    }
    if rows.is_empty() {
        rows.push(String::new());
    }
    rows
}

fn wrap_line(line: &str, width: usize, rows: &mut Vec<String>) {
    let mut current = String::new();
    let mut column = 0usize;
    for ch in line.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if ch_width == 0 {
            if !ch.is_control() {
                current.push(ch);
            }
            continue;
        }
        if column + ch_width > width && column > 0 {
            match current.rfind(' ').filter(|at| *at > 0) {
                Some(at) if ch != ' ' => {
                    let tail = current.split_off(at + 1);
                    rows.push(current.trim_end().to_string());
                    column = UnicodeWidthStr::width(tail.as_str());
                    current = tail;
                }
                _ => {
                    rows.push(std::mem::take(&mut current));
                    column = 0;
                    if ch == ' ' {
                        continue;
                    }
                }
            }
        }
        current.push(ch);
        column += ch_width;
    }
    rows.push(current);
}

fn composer_line(app: &App, width: u16) -> Line<'static> {
    let p = palette();
    let avail = (width as usize).saturating_sub(3).max(1);
    let mut spans = vec![Span::styled(" › ", Style::new().fg(p.ink).bg(p.bar))];
    if app.input.is_empty() {
        let placeholder = if app.overlay == Overlay::Repos {
            "Type to filter repositories"
        } else {
            PLACEHOLDER
        };
        let shown = fit(placeholder, 0, avail).0;
        push_placeholder(&mut spans, &shown, app.show_cursor());
    } else {
        let (shown, at) = fit(&app.input, app.cursor_byte(), avail);
        push_input(&mut spans, &shown, at, app.show_cursor());
    }
    Line::from(spans)
}

fn push_placeholder(spans: &mut Vec<Span<'static>>, shown: &str, cursor: bool) {
    let p = palette();
    if cursor && !shown.is_empty() {
        let mut chars = shown.chars();
        let first = chars.next().unwrap().to_string();
        let rest: String = chars.collect();
        spans.push(Span::styled(
            first,
            Style::new().fg(p.cursor_ink).bg(p.cursor),
        ));
        if !rest.is_empty() {
            spans.push(Span::styled(rest, Style::new().fg(p.muted).bg(p.bar)));
        }
    } else {
        spans.push(Span::styled(
            shown.to_string(),
            Style::new().fg(p.muted).bg(p.bar),
        ));
    }
}

fn push_input(spans: &mut Vec<Span<'static>>, shown: &str, at: usize, cursor: bool) {
    let p = palette();
    let at = at.min(shown.len());
    let (left, rest) = shown.split_at(at);
    if !left.is_empty() {
        spans.push(Span::styled(
            left.to_string(),
            Style::new().fg(p.ink).bg(p.bar),
        ));
    }
    if !cursor {
        if !rest.is_empty() {
            spans.push(Span::styled(
                rest.to_string(),
                Style::new().fg(p.ink).bg(p.bar),
            ));
        }
        return;
    }
    if rest.is_empty() {
        spans.push(Span::styled(
            " ",
            Style::new().fg(p.cursor_ink).bg(p.cursor),
        ));
        return;
    }
    let mut chars = rest.chars();
    let first = chars.next().unwrap().to_string();
    let tail: String = chars.collect();
    spans.push(Span::styled(
        first,
        Style::new().fg(p.cursor_ink).bg(p.cursor),
    ));
    if !tail.is_empty() {
        spans.push(Span::styled(tail, Style::new().fg(p.ink).bg(p.bar)));
    }
}

fn fit(text: &str, cursor: usize, cols: usize) -> (String, usize) {
    if cols == 0 {
        return (String::new(), 0);
    }
    let cursor = if text.is_char_boundary(cursor.min(text.len())) {
        cursor.min(text.len())
    } else {
        0
    };
    if UnicodeWidthStr::width(text) <= cols {
        return (text.to_string(), cursor);
    }
    let before = &text[..cursor];
    let after = &text[cursor..];
    let mut kept = String::new();
    for ch in before.chars().rev() {
        let mut trial = String::new();
        trial.push(ch);
        trial.push_str(&kept);
        if UnicodeWidthStr::width(trial.as_str()) + 1 > cols {
            break;
        }
        kept = trial;
    }
    let at = kept.len();
    let mut visible = kept;
    for ch in after.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if UnicodeWidthStr::width(visible.as_str()) + ch_width > cols {
            break;
        }
        visible.push(ch);
    }
    (visible, at)
}

fn status_line(app: &App, width: u16) -> Line<'static> {
    let p = palette();
    let label = format!("{} · {}", app.presence(), mode(app));
    let room = (width as usize).saturating_sub(UnicodeWidthStr::width(label.as_str()) + 4);
    let text = if room > 1 {
        format!("{label} · {}", format::brief(&app.cwd, room))
    } else {
        label
    };
    Line::from(vec![
        Span::styled(" ", Style::new().fg(p.accent).bg(p.canvas)),
        Span::styled(text, Style::new().fg(p.accent).bg(p.canvas)),
    ])
}

fn hint_line(app: &App) -> Line<'static> {
    let p = palette();
    let pairs: &[(&str, &str)] = if app.pending.is_some() {
        &[("y", " allow"), ("a", " allow all"), ("n", " deny")]
    } else if app.working() {
        &[
            ("esc", " interrupt"),
            ("⇧tab", " mode"),
            ("ctrl-c", " quit"),
        ]
    } else if !app.suggestions().is_empty() {
        &[("↑↓", " select"), ("tab", " complete"), ("enter", " run")]
    } else if app.overlay == Overlay::Runs {
        &[("↑↓", " select"), ("enter", " open"), ("esc", " close")]
    } else if app.overlay == Overlay::Repos {
        &[
            ("↑↓", " move"),
            ("space", " select"),
            ("enter", " install"),
            ("esc", " close"),
        ]
    } else if app.overlay == Overlay::Shortcuts {
        &[("esc", " close")]
    } else {
        &[
            ("⇧tab", " mode"),
            ("←", " for runs"),
            ("?", " for shortcuts"),
        ]
    };
    let mut spans = vec![Span::styled(" ", Style::new().fg(p.hint).bg(p.canvas))];
    for (index, (key, rest)) in pairs.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled(" · ", Style::new().fg(p.hint).bg(p.canvas)));
        }
        spans.push(Span::styled(
            (*key).to_string(),
            Style::new().fg(p.key).bg(p.canvas),
        ));
        spans.push(Span::styled(
            (*rest).to_string(),
            Style::new().fg(p.hint).bg(p.canvas),
        ));
    }
    Line::from(spans)
}

const SLASH_ROWS: usize = 8;

/// A window of the matches that follows the selection, so ↑↓ reach every command.
fn render_slash(frame: &mut Frame, body: Rect, app: &App) {
    let p = palette();
    let suggestions = app.suggestions();
    if suggestions.is_empty() || body.height == 0 {
        return;
    }
    let index = app.slash_index.min(suggestions.len() - 1);
    let start = index.saturating_sub(SLASH_ROWS - 1);
    let shown = suggestions
        .iter()
        .skip(start)
        .take(SLASH_ROWS)
        .collect::<Vec<_>>();
    let height = (shown.len() as u16).min(body.height);
    let y = body.y + body.height.saturating_sub(height);
    for (offset, spec) in shown.iter().take(height as usize).enumerate() {
        let selected = start + offset == index;
        let bg = if selected { p.select } else { p.canvas };
        let name_color = if selected { p.accent } else { p.ink };
        let line = Line::from(vec![
            Span::styled(
                format!(" /{:<12}", spec.name),
                Style::new().fg(name_color).bg(bg),
            ),
            Span::styled(
                spec.summary.to_string(),
                Style::new()
                    .fg(if selected { p.ink } else { p.muted })
                    .bg(bg),
            ),
        ]);
        let rect = Rect {
            x: body.x,
            y: y + offset as u16,
            width: body.width,
            height: 1,
        };
        frame.render_widget(Paragraph::new(line).style(Style::new().bg(bg)), rect);
    }
}

fn render_runs(frame: &mut Frame, body: Rect, app: &App) {
    let p = palette();
    let lines: Vec<(Line<'static>, ratatui::style::Color)> =
        if app.runs_loading && app.runs.is_empty() {
            vec![(
                Line::from(Span::styled(
                    " loading runs",
                    Style::new().fg(p.muted).bg(p.canvas),
                )),
                p.canvas,
            )]
        } else if app.runs.is_empty() {
            vec![(
                Line::from(Span::styled(
                    " no runs yet",
                    Style::new().fg(p.muted).bg(p.canvas),
                )),
                p.canvas,
            )]
        } else {
            let start = app.run_index.saturating_sub(7);
            app.runs
                .iter()
                .enumerate()
                .skip(start)
                .take(8)
                .map(|(index, run)| {
                    let selected = index == app.run_index;
                    let bg = if selected { p.select } else { p.canvas };
                    let text = format::format_run_row(run, format::now_ms());
                    let line = Line::from(Span::styled(
                        format!(" {text}"),
                        Style::new().fg(tone_color(status_tone(&run.status))).bg(bg),
                    ));
                    (line, bg)
                })
                .collect()
        };
    paint_rows(frame, body, lines);
}

const REPO_ROWS: usize = 10;

fn render_repos(frame: &mut Frame, body: Rect, app: &App) {
    let p = palette();
    let view = app.repo_view();
    let source = match app.gh_source {
        Some(crate::github::Source::Public) => " · public only; gh auth login lists private ones",
        _ => "",
    };
    let header = format!(
        " Install Adamant on which repositories? {} selected{source}",
        app.picked.len()
    );
    let mut rows: Vec<(Line<'static>, ratatui::style::Color)> = vec![(
        Line::from(Span::styled(header, Style::new().fg(p.accent).bg(p.canvas))),
        p.canvas,
    )];
    if app.gh_loading {
        rows.push((
            Line::from(Span::styled(
                " loading your GitHub repositories",
                Style::new().fg(p.muted).bg(p.canvas),
            )),
            p.canvas,
        ));
    } else if view.is_empty() {
        let text = if app.gh_repos.is_empty() {
            " no repositories found"
        } else {
            " nothing matches"
        };
        rows.push((
            Line::from(Span::styled(text, Style::new().fg(p.muted).bg(p.canvas))),
            p.canvas,
        ));
    } else {
        let index = app.repo_index.min(view.len() - 1);
        let start = index.saturating_sub(REPO_ROWS - 1);
        for (at, repo) in view.iter().enumerate().skip(start).take(REPO_ROWS) {
            let selected = at == index;
            let bg = if selected { p.select } else { p.canvas };
            let mark = if repo.installed {
                " ✓ "
            } else if app.picked.contains(&repo.id) {
                " ◉ "
            } else {
                " ○ "
            };
            let mut spans = vec![
                Span::styled(
                    mark,
                    Style::new()
                        .fg(if repo.installed { p.green } else { p.accent })
                        .bg(bg),
                ),
                Span::styled(
                    repo.full_name(),
                    Style::new().fg(if selected { p.ink } else { p.key }).bg(bg),
                ),
            ];
            let mut tags = Vec::new();
            if repo.installed {
                tags.push("installed");
            }
            if repo.private {
                tags.push("private");
            }
            if !repo.admin && !repo.installed {
                tags.push("needs an admin");
            }
            if !tags.is_empty() {
                spans.push(Span::styled(
                    format!("  {}", tags.join(" · ")),
                    Style::new().fg(p.muted).bg(bg),
                ));
            }
            rows.push((Line::from(spans), bg));
        }
        if view.len() > REPO_ROWS {
            rows.push((
                Line::from(Span::styled(
                    format!(" {} repositories · type to filter", view.len()),
                    Style::new().fg(p.dim).bg(p.canvas),
                )),
                p.canvas,
            ));
        }
    }
    paint_rows(frame, body, rows);
}

fn render_shortcuts(frame: &mut Frame, body: Rect) {
    let p = palette();
    const ROWS: &[(&str, &str)] = &[
        ("enter", "send"),
        ("esc", "interrupt, or clear the line"),
        ("⇧tab", "auto / manual approvals"),
        ("ctrl-c", "interrupt, then quit"),
        ("ctrl-l", "clear the screen"),
        ("tab", "complete a command"),
        ("←", "list runs"),
        ("↑ ↓", "move"),
        ("pgup", "scroll"),
    ];
    let height = ROWS.len() as u16 + 4;
    if body.height < 6 || body.width < 30 {
        return;
    }
    let width = body.width.min(48);
    let rect = Rect {
        x: body.x + 1,
        y: body.y + body.height.saturating_sub(height.min(body.height)),
        width: width.saturating_sub(1),
        height: height.min(body.height),
    };
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(p.border))
        .style(Style::new().bg(p.canvas));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let mut lines = vec![
        Line::from(Span::styled(
            "shortcuts",
            Style::new().fg(p.accent).bg(p.canvas),
        )),
        Line::from(Span::raw("")),
    ];
    for (key, rest) in ROWS {
        lines.push(Line::from(vec![
            Span::styled(format!("{key:<8}"), Style::new().fg(p.key).bg(p.canvas)),
            Span::styled((*rest).to_string(), Style::new().fg(p.muted).bg(p.canvas)),
        ]));
    }
    frame.render_widget(
        Paragraph::new(lines).style(Style::new().bg(p.canvas)),
        inner,
    );
}

fn render_approval(frame: &mut Frame, body: Rect, pending: &crate::app::Pending) {
    let p = palette();
    let width = body.width.min(100);
    if body.height < 6 || width < 24 {
        return;
    }
    let inner_width = width.saturating_sub(6) as usize;
    let mut detail = Vec::new();
    for line in &pending.approval.detail {
        detail.extend(wrap(line, inner_width.max(1)));
    }
    let room = body.height.saturating_sub(6) as usize;
    detail.truncate(room.max(1));
    let height = (detail.len() as u16 + 6).min(body.height);
    let rect = Rect {
        x: body.x + 1,
        y: body.y + body.height - height,
        width: width.saturating_sub(1),
        height,
    };
    frame.render_widget(ratatui::widgets::Clear, rect);
    let block = Block::bordered()
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(p.accent))
        .padding(ratatui::widgets::Padding::horizontal(1))
        .style(Style::new().bg(p.canvas));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let mut lines = vec![
        Line::from(Span::styled(
            pending.approval.title.clone(),
            Style::new().fg(p.accent).bg(p.canvas),
        )),
        Line::from(Span::raw("")),
    ];
    for row in detail {
        lines.push(Line::from(Span::styled(
            row,
            Style::new().fg(p.ink).bg(p.canvas),
        )));
    }
    lines.push(Line::from(Span::raw("")));
    lines.push(Line::from(vec![
        Span::styled("y", Style::new().fg(p.key).bg(p.canvas)),
        Span::styled(" yes · ", Style::new().fg(p.hint).bg(p.canvas)),
        Span::styled("a", Style::new().fg(p.key).bg(p.canvas)),
        Span::styled(
            " yes, and switch to auto · ",
            Style::new().fg(p.hint).bg(p.canvas),
        ),
        Span::styled("n", Style::new().fg(p.key).bg(p.canvas)),
        Span::styled(" no", Style::new().fg(p.hint).bg(p.canvas)),
    ]));
    frame.render_widget(
        Paragraph::new(lines).style(Style::new().bg(p.canvas)),
        inner,
    );
}

fn paint_rows(frame: &mut Frame, body: Rect, rows: Vec<(Line<'static>, ratatui::style::Color)>) {
    if rows.is_empty() || body.height == 0 {
        return;
    }
    let height = rows.len() as u16;
    let y = body.y + body.height.saturating_sub(height.min(body.height));
    for (offset, (line, bg)) in rows.into_iter().enumerate() {
        let rect = Rect {
            x: body.x,
            y: y + offset as u16,
            width: body.width,
            height: 1,
        };
        frame.render_widget(Paragraph::new(line).style(Style::new().bg(bg)), rect);
    }
}

fn tone_color(tone: Tone) -> ratatui::style::Color {
    let p = palette();
    match tone {
        Tone::Normal => p.ink,
        Tone::Muted => p.muted,
        Tone::Error => p.red,
        Tone::Success => p.green,
        Tone::Accent => p.accent,
        Tone::Link => p.blue,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::theme::{self, DARK, LIGHT, SOLID};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn ready_app() -> App {
        let config = Config {
            origin: Some("http://localhost:8787".into()),
            origin_error: None,
            session: Some("session".into()),
            session_error: None,
            model: None,
            auto: true,
        };
        let mut app = App::new("0.1.0", "~", &config, true);
        app.starting = false;
        app.base = crate::app::Base::Ready;
        app.notice = None;
        app
    }

    fn rows(terminal: &Terminal<TestBackend>) -> Vec<String> {
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer.cell((x, y)).map(|cell| cell.symbol()).unwrap_or(" "))
                    .collect::<String>()
            })
            .collect()
    }

    #[test]
    fn empty_screen_matches_the_codex_shell() {
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        let app = ready_app();
        terminal.draw(|frame| draw(frame, &app)).unwrap();
        let lines = rows(&terminal);
        let screen = lines.join("\n");
        assert!(screen.contains(">_ Adamant (v0.1.0)"), "{screen}");
        assert!(screen.contains("Ask Adamant to do anything"), "{screen}");
        assert!(screen.contains("ready · auto · ~"), "{screen}");
        assert!(screen.contains("for runs"), "{screen}");
        assert!(screen.contains("for shortcuts"), "{screen}");
        assert!(!screen.to_lowercase().contains("codex"));
        assert!(!screen.contains("OpenAI"));

        let buffer = terminal.backend().buffer();
        let mut yellow = false;
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width.saturating_sub(6) {
                let word: String = (0..7)
                    .map(|i| buffer.cell((x + i, y)).unwrap().symbol())
                    .collect();
                if word == "Adamant"
                    && buffer.cell((x, y)).unwrap().style().fg == Some(palette().accent)
                {
                    yellow = true;
                }
            }
        }
        assert!(yellow, "the Adamant title was not yellow");

        let prompt = lines
            .iter()
            .position(|line| line.contains("Ask Adamant"))
            .expect("prompt");
        let above = buffer.cell((0, prompt as u16 - 1)).unwrap().style().bg;
        let below = buffer.cell((0, prompt as u16 + 1)).unwrap().style().bg;
        assert_eq!(
            above,
            Some(palette().bar),
            "composer should have padding above the prompt"
        );
        assert_eq!(
            below,
            Some(palette().bar),
            "composer should have padding below the prompt"
        );
    }

    #[test]
    fn signed_out_notice_title_is_yellow() {
        let config = Config {
            origin: Some("http://localhost:8787".into()),
            origin_error: None,
            session: None,
            session_error: None,
            model: None,
            auto: true,
        };
        let app = App::new("0.1.0", "~", &config, true);
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|frame| draw(frame, &app)).unwrap();
        let buffer = terminal.backend().buffer();
        let mut found = false;
        for y in 0..buffer.area.height {
            for x in 0..buffer.area.width.saturating_sub(4) {
                let word: String = (0..4)
                    .map(|i| {
                        buffer
                            .cell((x + i, y))
                            .map(|cell| cell.symbol())
                            .unwrap_or("")
                    })
                    .collect();
                if word == "Sign" {
                    assert_eq!(
                        buffer.cell((x, y)).unwrap().style().fg,
                        Some(palette().accent)
                    );
                    found = true;
                }
            }
        }
        assert!(found);
    }

    fn drawn(app: &App) -> Terminal<TestBackend> {
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();
        terminal
    }

    fn rgb(color: Option<Color>) -> (u8, u8, u8) {
        match color {
            Some(Color::Rgb(r, g, b)) => (r, g, b),
            other => panic!("not an RGB colour: {other:?}"),
        }
    }

    #[test]
    fn glass_leaves_the_canvas_to_the_terminal() {
        theme::use_for_test(DARK);
        let terminal = drawn(&ready_app());
        let buffer = terminal.backend().buffer();
        let bg = |x, y| buffer.cell((x, y)).unwrap().style().bg;
        // The welcome rows, the blank body, the status and hint rows.
        for (x, y) in [(0, 0), (5, 1), (79, 10), (0, 22), (40, 23)] {
            assert_eq!(bg(x, y), Some(Color::Reset), "({x}, {y})");
        }
        // The composer stays an opaque card.
        for x in [0, 40, 79] {
            assert_eq!(bg(x, 19), Some(DARK.bar));
        }
    }

    #[test]
    fn solid_paints_the_old_black() {
        theme::use_for_test(SOLID);
        let terminal = drawn(&ready_app());
        let buffer = terminal.backend().buffer();
        assert_eq!(
            buffer.cell((0, 0)).unwrap().style().bg,
            Some(Color::Rgb(0, 0, 0))
        );
        assert_eq!(buffer.cell((0, 23)).unwrap().style().bg, Some(SOLID.canvas));
    }

    #[test]
    fn light_uses_dark_ink() {
        theme::use_for_test(LIGHT);
        assert!(!theme::is_light(rgb(Some(LIGHT.ink))));
        assert!(!theme::is_light(rgb(Some(LIGHT.accent))));
        assert!(theme::is_light(rgb(Some(LIGHT.bar))));
        let mut app = ready_app();
        app.lines
            .push(Out::Agent("Readable on a light background.".into()));
        let terminal = drawn(&app);
        let buffer = terminal.backend().buffer();
        let lines = rows(&terminal);
        let y = lines
            .iter()
            .position(|line| line.contains("Readable"))
            .unwrap();
        let x = lines[y].find("Readable").unwrap();
        let cell = buffer.cell((x as u16, y as u16)).unwrap();
        assert_eq!(cell.style().fg, Some(LIGHT.ink));
        assert_eq!(cell.style().bg, Some(Color::Reset));
        let prompt = lines
            .iter()
            .position(|line| line.contains("Ask Adamant"))
            .unwrap();
        assert_eq!(
            buffer.cell((0, prompt as u16)).unwrap().style().bg,
            Some(LIGHT.bar)
        );
    }

    #[test]
    fn the_sweep_darkens_on_light_and_lightens_on_dark() {
        // 947 ms puts the middle of the band on the fourth letter.
        let peak = |palette| {
            theme::use_for_test(palette);
            rgb(shimmer("Working", Duration::from_millis(947))[3].style.fg)
        };
        let luma = |(r, g, b): (u8, u8, u8)| r as u32 + g as u32 + b as u32;
        assert!(luma(peak(LIGHT)) < luma(rgb(Some(LIGHT.muted))));
        assert!(luma(peak(DARK)) > luma(rgb(Some(DARK.muted))));
    }
}

#[cfg(test)]
mod screens {
    use super::*;
    use crate::app::{AgentNote, Msg};
    use crate::config::{Config, ModelConfig};
    use crate::github::{GhRepo, Listing, Source};
    use crate::tools::Approval;
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn app() -> App {
        let config = Config {
            origin: Some("http://localhost:8787".into()),
            origin_error: None,
            session: Some("session".into()),
            session_error: None,
            model: Some(ModelConfig {
                key: "k".into(),
                base: "http://localhost".into(),
                model: "gpt-6-sol".into(),
                effort: None,
            }),
            auto: false,
        };
        let mut app = App::new("0.1.0", "~/adamant", &config, true);
        app.starting = false;
        app.base = crate::app::Base::Ready;
        app.notice = None;
        app
    }

    fn screen(app: &App) -> String {
        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|frame| draw(frame, app)).unwrap();
        let buffer = terminal.backend().buffer();
        (0..buffer.area.height)
            .map(|y| {
                (0..buffer.area.width)
                    .map(|x| buffer.cell((x, y)).map(|cell| cell.symbol()).unwrap_or(" "))
                    .collect::<String>()
                    .trim_end()
                    .to_string()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn start(app: &mut App, text: &str) -> u64 {
        match app.submit_text(text) {
            crate::app::Effect::Prompt { gen, .. } => gen,
            _ => panic!("expected a turn"),
        }
    }

    #[test]
    fn a_reply_wraps_at_words_and_an_approval_names_the_command() {
        let mut app = app();
        let gen = start(&mut app, "why is CI red?");
        app.on_msg(Msg::Agent {
            gen,
            note: AgentNote::Text(
                "The typecheck fails in server/api/routes/runs.ts because readString returns undefined.\nI will fix it.".into(),
            ),
        });
        let (reply, _answer) = tokio::sync::oneshot::channel();
        app.on_msg(Msg::Agent {
            gen,
            note: AgentNote::Ask {
                approval: Approval {
                    title: "Run this command?".into(),
                    detail: vec!["pnpm typecheck".into()],
                },
                reply,
            },
        });
        let shown = screen(&app);
        println!("{shown}");
        assert!(
            shown.contains("The typecheck fails in server/api/routes/runs.ts because readString")
        );
        assert!(
            shown.contains("because readString returns\n   undefined."),
            "word wrap split a word:\n{shown}"
        );
        assert!(shown.contains("Run this command?"));
        assert!(shown.contains("pnpm typecheck"));
        assert!(shown.contains("y allow · a allow all · n deny"));
        assert!(shown.contains("waiting for you · manual"));
    }

    #[test]
    fn a_running_turn_shows_the_working_row_over_the_composer() {
        let mut app = app();
        start(&mut app, "yoo");
        app.turn_started = Some(std::time::Instant::now() - std::time::Duration::from_secs(65));
        let shown = screen(&app);
        println!("{shown}");
        let rows: Vec<&str> = shown.lines().collect();
        let working = rows
            .iter()
            .position(|row| row.contains("• Working (1m 05s • esc to interrupt)"))
            .expect("working row");
        assert!(rows[working + 2].contains("› Ask Adamant"), "{shown}");
        assert!(shown.contains("working · manual"));

        let mut terminal = Terminal::new(TestBackend::new(80, 24)).unwrap();
        terminal.draw(|frame| draw(frame, &app)).unwrap();
        let buffer = terminal.backend().buffer();
        let ask = rows.iter().position(|row| row.contains("› yoo")).unwrap() as u16;
        for y in [ask - 1, ask, ask + 1] {
            for x in [0, 40, 79] {
                assert_eq!(
                    buffer.cell((x, y)).unwrap().style().bg,
                    Some(palette().bar),
                    "({x}, {y})"
                );
            }
        }
        assert_eq!(
            buffer.cell((0, ask + 2)).unwrap().style().bg,
            Some(Color::Reset)
        );
    }

    #[test]
    fn a_finished_turn_says_how_long_it_worked() {
        let mut app = app();
        let gen = start(&mut app, "how are you");
        app.on_msg(Msg::Agent {
            gen,
            note: AgentNote::Text("Doing well.".into()),
        });
        app.on_msg(Msg::Agent {
            gen,
            note: AgentNote::Done,
        });
        let shown = screen(&app);
        println!("{shown}");
        assert!(
            shown.contains(" • Doing well.\n\n   Worked for 0s"),
            "{shown}"
        );
        assert!(!shown.contains("esc to interrupt"));
    }

    #[test]
    fn arrows_reach_every_slash_command() {
        let mut app = app();
        app.on_msg(Msg::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('/'),
            crossterm::event::KeyModifiers::NONE,
        )));
        let all = app.suggestions().len();
        assert!(all > SLASH_ROWS, "the list fits; nothing to scroll");
        for _ in 0..all - 1 {
            app.on_msg(Msg::Key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Down,
                crossterm::event::KeyModifiers::NONE,
            )));
        }
        let last = app.suggestions()[all - 1].name;
        let first = app.suggestions()[0].name;
        let shown = screen(&app);
        println!("{shown}");
        assert!(shown.contains(&format!(" /{last}")), "{shown}");
        assert!(!shown.contains(&format!(" /{first} ")), "{shown}");
    }

    #[test]
    fn the_picker_lists_repositories_with_their_state() {
        let mut app = app();
        app.submit_text("/repos");
        let repo = |id, name: &str, installed, admin| GhRepo {
            id,
            owner: "vaishcodescape".into(),
            owner_id: 1,
            name: name.into(),
            private: true,
            admin,
            installed,
        };
        app.on_msg(Msg::Github(Ok(Listing {
            repos: vec![
                repo(1, "adamant", false, true),
                repo(2, "notes", true, true),
                repo(3, "shared", false, false),
            ],
            source: Source::Public,
        })));
        app.on_msg(Msg::Key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char(' '),
            crossterm::event::KeyModifiers::NONE,
        )));
        let shown = screen(&app);
        println!("{shown}");
        assert!(shown.contains("Install Adamant on which repositories? 1 selected"));
        assert!(shown.contains("◉ vaishcodescape/adamant  private"));
        assert!(shown.contains("✓ vaishcodescape/notes  installed · private"));
        assert!(shown.contains("○ vaishcodescape/shared  private · needs an admin"));
        assert!(shown.contains("Type to filter repositories"));
        assert!(shown.contains("space select"));
    }
}
