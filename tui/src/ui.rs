use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::Style;
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Paragraph};
use ratatui::Frame;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::app::{App, Overlay};
use crate::format::{self, status_tone, Out, Tone};
use crate::theme::{
    BAR, BLACK, BLUE, BORDER, COMPOSER_ROWS, CURSOR, DIM, FOOTER_ROWS, GREEN, HINT, INK, KEY,
    MUTED, RED, SELECT, YELLOW,
};

const PLACEHOLDER: &str = "Ask Adamant to do anything";

pub fn draw(frame: &mut Frame, app: &App) {
    let area = frame.area();
    frame.render_widget(Block::new().style(Style::new().bg(BLACK)), area);
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
        render_transcript(frame, body, app);
    }

    frame.render_widget(Block::new().style(Style::new().bg(BAR)), composer);
    let prompt = Rect {
        x: composer.x,
        y: composer.y + composer.height / 2,
        width: composer.width,
        height: 1,
    };
    frame.render_widget(
        Paragraph::new(composer_line(app, prompt.width)).style(Style::new().bg(BAR)),
        prompt,
    );
    frame.render_widget(
        Paragraph::new(status_line(app, status.width)).style(Style::new().bg(BLACK)),
        status,
    );
    frame.render_widget(
        Paragraph::new(hint_line(app)).style(Style::new().bg(BLACK)),
        hints,
    );

    if app.overlay == Overlay::Shortcuts {
        render_shortcuts(frame, body);
    } else if app.overlay == Overlay::Runs {
        render_runs(frame, body, app);
    } else if !app.suggestions().is_empty() {
        render_slash(frame, body, app);
    }
}

fn render_welcome(frame: &mut Frame, body: Rect, top: u16, app: &App) {
    if body.height <= top || body.width < 4 {
        return;
    }
    let rect = Rect {
        x: body.x + 1,
        y: body.y + top,
        width: body.width.saturating_sub(1),
        height: 2.min(body.height - top),
    };
    let lines = vec![
        Line::from(vec![
            Span::styled(">_ ", Style::new().fg(YELLOW).bg(BLACK)),
            Span::styled("Adamant", Style::new().fg(YELLOW).bg(BLACK)),
            Span::styled(
                format!(" (v{})", app.version),
                Style::new().fg(DIM).bg(BLACK),
            ),
        ]),
        Line::from(Span::styled(
            app.cwd.clone(),
            Style::new().fg(DIM).bg(BLACK),
        )),
    ];
    frame.render_widget(Paragraph::new(lines).style(Style::new().bg(BLACK)), rect);
}

fn render_notice(frame: &mut Frame, body: Rect, notice: &crate::app::Notice) -> u16 {
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
        .border_style(Style::new().fg(BORDER))
        .style(Style::new().bg(BLACK));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let mut lines = vec![
        Line::from(vec![
            Span::styled("✦  ", Style::new().fg(YELLOW).bg(BLACK)),
            Span::styled(notice.title.clone(), Style::new().fg(YELLOW).bg(BLACK)),
        ]),
        Line::from(Span::styled(" ", Style::new().bg(BLACK))),
    ];
    for line in &notice.lines {
        let color = if line.starts_with("http://") || line.starts_with("https://") {
            BLUE
        } else {
            INK
        };
        lines.push(Line::from(Span::styled(
            line.clone(),
            Style::new().fg(color).bg(BLACK),
        )));
    }
    frame.render_widget(Paragraph::new(lines).style(Style::new().bg(BLACK)), inner);
    height.saturating_add(1)
}

fn render_transcript(frame: &mut Frame, body: Rect, app: &App) {
    let width = body.width.saturating_sub(2) as usize;
    let wrapped = wrap_outs(&app.lines, width.max(1));
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
        x: body.x + 1,
        y: body.y,
        width: body.width.saturating_sub(1),
        height: height.min(body.height),
    };
    frame.render_widget(Paragraph::new(visible).style(Style::new().bg(BLACK)), rect);
}

fn wrap_outs(lines: &[Out], width: usize) -> Vec<Line<'static>> {
    let mut rows = Vec::new();
    for line in lines {
        match line {
            Out::Ask(text) => rows.extend(ask_rows(text, width)),
            Out::Line { tone, text } => {
                for row in wrap(text, width) {
                    rows.push(Line::from(Span::styled(
                        row,
                        Style::new().fg(tone_color(*tone)).bg(BLACK),
                    )));
                }
            }
        }
    }
    rows
}

fn ask_rows(text: &str, width: usize) -> Vec<Line<'static>> {
    let body_width = width.saturating_sub(2).max(1);
    wrap(text, body_width)
        .into_iter()
        .enumerate()
        .map(|(index, row)| {
            if index == 0 {
                Line::from(vec![
                    Span::styled("> ", Style::new().fg(INK).bg(BLACK)),
                    Span::styled(row, Style::new().fg(INK).bg(BLACK)),
                ])
            } else {
                Line::from(Span::styled(
                    format!("  {row}"),
                    Style::new().fg(INK).bg(BLACK),
                ))
            }
        })
        .collect()
}

fn wrap(text: &str, width: usize) -> Vec<String> {
    if text.is_empty() {
        return vec![String::new()];
    }
    let width = width.max(1);
    let mut rows = Vec::new();
    let mut current = String::new();
    let mut column = 0usize;
    for ch in text.chars() {
        let ch_width = UnicodeWidthChar::width(ch).unwrap_or(0);
        if ch_width == 0 {
            current.push(ch);
            continue;
        }
        if column + ch_width > width && column > 0 {
            rows.push(std::mem::take(&mut current));
            column = 0;
        }
        current.push(ch);
        column += ch_width;
    }
    if !current.is_empty() {
        rows.push(current);
    }
    if rows.is_empty() {
        vec![String::new()]
    } else {
        rows
    }
}

fn composer_line(app: &App, width: u16) -> Line<'static> {
    let avail = (width as usize).saturating_sub(3).max(1);
    let mut spans = vec![Span::styled(" > ", Style::new().fg(INK).bg(BAR))];
    if app.input.is_empty() {
        let shown = fit(PLACEHOLDER, 0, avail).0;
        push_placeholder(&mut spans, &shown, app.show_cursor());
    } else {
        let (shown, at) = fit(&app.input, app.cursor_byte(), avail);
        push_input(&mut spans, &shown, at, app.show_cursor());
    }
    Line::from(spans)
}

fn push_placeholder(spans: &mut Vec<Span<'static>>, shown: &str, cursor: bool) {
    if cursor && !shown.is_empty() {
        let mut chars = shown.chars();
        let first = chars.next().unwrap().to_string();
        let rest: String = chars.collect();
        spans.push(Span::styled(first, Style::new().fg(BLACK).bg(CURSOR)));
        if !rest.is_empty() {
            spans.push(Span::styled(rest, Style::new().fg(MUTED).bg(BAR)));
        }
    } else {
        spans.push(Span::styled(
            shown.to_string(),
            Style::new().fg(MUTED).bg(BAR),
        ));
    }
}

fn push_input(spans: &mut Vec<Span<'static>>, shown: &str, at: usize, cursor: bool) {
    let at = at.min(shown.len());
    let (left, rest) = shown.split_at(at);
    if !left.is_empty() {
        spans.push(Span::styled(left.to_string(), Style::new().fg(INK).bg(BAR)));
    }
    if !cursor {
        if !rest.is_empty() {
            spans.push(Span::styled(rest.to_string(), Style::new().fg(INK).bg(BAR)));
        }
        return;
    }
    if rest.is_empty() {
        spans.push(Span::styled(" ", Style::new().fg(BLACK).bg(CURSOR)));
        return;
    }
    let mut chars = rest.chars();
    let first = chars.next().unwrap().to_string();
    let tail: String = chars.collect();
    spans.push(Span::styled(first, Style::new().fg(BLACK).bg(CURSOR)));
    if !tail.is_empty() {
        spans.push(Span::styled(tail, Style::new().fg(INK).bg(BAR)));
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
    let label = app.presence();
    let room = (width as usize).saturating_sub(UnicodeWidthStr::width(label.as_str()) + 4);
    let cwd = if room > 1 {
        format::brief(&app.cwd, room)
    } else {
        String::new()
    };
    let text = if cwd.is_empty() {
        label
    } else {
        format!("{label} · {cwd}")
    };
    Line::from(vec![
        Span::styled(" ", Style::new().fg(YELLOW).bg(BLACK)),
        Span::styled(text, Style::new().fg(YELLOW).bg(BLACK)),
    ])
}

fn hint_line(app: &App) -> Line<'static> {
    let pairs: &[(&str, &str)] = if app.working {
        &[("esc", " stop"), ("ctrl-c", " quit")]
    } else if !app.suggestions().is_empty() {
        &[("↑↓", " select"), ("tab", " complete"), ("enter", " run")]
    } else if app.overlay == Overlay::Runs {
        &[("↑↓", " select"), ("enter", " open"), ("esc", " close")]
    } else if app.overlay == Overlay::Shortcuts {
        &[("esc", " close")]
    } else {
        &[("←", " for runs"), ("?", " for shortcuts")]
    };
    let mut spans = vec![Span::styled(" ", Style::new().fg(HINT).bg(BLACK))];
    for (index, (key, rest)) in pairs.iter().enumerate() {
        if index > 0 {
            spans.push(Span::styled(" · ", Style::new().fg(HINT).bg(BLACK)));
        }
        spans.push(Span::styled(
            (*key).to_string(),
            Style::new().fg(KEY).bg(BLACK),
        ));
        spans.push(Span::styled(
            (*rest).to_string(),
            Style::new().fg(HINT).bg(BLACK),
        ));
    }
    Line::from(spans)
}

fn render_slash(frame: &mut Frame, body: Rect, app: &App) {
    let suggestions = app.suggestions();
    let shown = suggestions.iter().take(8).collect::<Vec<_>>();
    if shown.is_empty() || body.height == 0 {
        return;
    }
    let height = shown.len() as u16;
    let y = body.y + body.height.saturating_sub(height);
    for (offset, spec) in shown.iter().enumerate() {
        let selected = offset == app.slash_index.min(shown.len() - 1);
        let bg = if selected { SELECT } else { BLACK };
        let name_color = if selected { YELLOW } else { INK };
        let line = Line::from(vec![
            Span::styled(
                format!(" /{:<12}", spec.name),
                Style::new().fg(name_color).bg(bg),
            ),
            Span::styled(
                spec.summary.to_string(),
                Style::new().fg(if selected { INK } else { MUTED }).bg(bg),
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
    let lines: Vec<(Line<'static>, ratatui::style::Color)> =
        if app.runs_loading && app.runs.is_empty() {
            vec![(
                Line::from(Span::styled(
                    " loading runs",
                    Style::new().fg(MUTED).bg(BLACK),
                )),
                BLACK,
            )]
        } else if app.runs.is_empty() {
            vec![(
                Line::from(Span::styled(
                    " no runs yet",
                    Style::new().fg(MUTED).bg(BLACK),
                )),
                BLACK,
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
                    let bg = if selected { SELECT } else { BLACK };
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

fn render_shortcuts(frame: &mut Frame, body: Rect) {
    const ROWS: &[(&str, &str)] = &[
        ("enter", "send"),
        ("esc", "stop, or clear the line"),
        ("ctrl-c", "quit"),
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
        .border_style(Style::new().fg(BORDER))
        .style(Style::new().bg(BLACK));
    let inner = block.inner(rect);
    frame.render_widget(block, rect);
    let mut lines = vec![
        Line::from(Span::styled("shortcuts", Style::new().fg(YELLOW).bg(BLACK))),
        Line::from(Span::raw("")),
    ];
    for (key, rest) in ROWS {
        lines.push(Line::from(vec![
            Span::styled(format!("{key:<8}"), Style::new().fg(KEY).bg(BLACK)),
            Span::styled((*rest).to_string(), Style::new().fg(MUTED).bg(BLACK)),
        ]));
    }
    frame.render_widget(Paragraph::new(lines).style(Style::new().bg(BLACK)), inner);
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
    match tone {
        Tone::Normal => INK,
        Tone::Muted => MUTED,
        Tone::Error => RED,
        Tone::Success => GREEN,
        Tone::Accent => YELLOW,
        Tone::Link => BLUE,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use crate::theme::{BAR, YELLOW};
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;

    fn ready_app() -> App {
        let config = Config {
            origin: Some("http://localhost:8787".into()),
            origin_error: None,
            session: Some("session".into()),
            session_error: None,
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
        assert!(screen.contains("ready · ~"), "{screen}");
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
                if word == "Adamant" && buffer.cell((x, y)).unwrap().style().fg == Some(YELLOW) {
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
            Some(BAR),
            "composer should have padding above the prompt"
        );
        assert_eq!(
            below,
            Some(BAR),
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
                    assert_eq!(buffer.cell((x, y)).unwrap().style().fg, Some(YELLOW));
                    found = true;
                }
            }
        }
        assert!(found);
    }
}
