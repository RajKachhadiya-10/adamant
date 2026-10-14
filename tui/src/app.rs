use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::api::RunSummary;
use crate::command::{self, Command, Spec};
use crate::config::Config;
use crate::format::{self, Out, Tone};
use crate::theme::FOOTER_ROWS;

const MAX_LINES: usize = 1_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Base {
    Ready,
    SignedOut,
    Offline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Overlay {
    None,
    Shortcuts,
    Runs,
}

#[derive(Clone, Debug)]
pub struct Notice {
    pub title: String,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum Job {
    Status {
        epoch: u64,
    },
    Runs,
    Run(String),
    Login {
        epoch: u64,
    },
    Logout {
        epoch: u64,
    },
    Me,
    Repos,
    Install {
        owner: Option<String>,
        name: Option<String>,
    },
    Trigger {
        repository_id: String,
        source_sha: String,
    },
}

#[derive(Clone, Debug)]
pub enum Effect {
    None,
    Quit,
    Cancel,
    Health,
    Me { epoch: u64 },
    Job { epoch: u64, job: Job },
    Watch { gen: u64 },
    LoadRuns { epoch: u64 },
}

pub enum Msg {
    Key(KeyEvent),
    Paste(String),
    Resize(u16, u16),
    Health(Result<(), String>),
    Identified {
        epoch: u64,
        result: Result<String, String>,
    },
    Session {
        epoch: u64,
        signed_in: bool,
        username: Option<String>,
    },
    Lines(Vec<Out>),
    Runs(Result<Vec<RunSummary>, String>),
    JobDone,
    Watch(WatchNote),
}

pub enum WatchNote {
    Up {
        gen: u64,
    },
    Event {
        gen: u64,
        text: String,
    },
    Wait {
        gen: u64,
        secs: u64,
    },
    Down {
        gen: u64,
        message: Option<String>,
        unauthorized: bool,
    },
}

pub struct App {
    pub version: String,
    pub cwd: String,
    pub origin: String,
    pub input: String,
    cursor: usize,
    pub lines: Vec<Out>,
    pub scroll: usize,
    pub cols: u16,
    pub body_rows: u16,
    pub base: Base,
    pub working: bool,
    pub watching: bool,
    pub reconnect_in: Option<u64>,
    pub starting: bool,
    pub notice: Option<Notice>,
    pub overlay: Overlay,
    pub slash_index: usize,
    pub runs: Vec<RunSummary>,
    pub run_index: usize,
    pub runs_loading: bool,
    pub cursor_on: bool,
    reduce_motion: bool,
    pub authed: bool,
    epoch: u64,
    watch_gen: u64,
    can_call: bool,
}

impl App {
    pub fn new(version: &str, cwd: &str, config: &Config, reduce_motion: bool) -> Self {
        let can_call = config.origin.is_some();
        let authed = config.session.is_some();
        let (base, notice, starting) = if let Some(error) = &config.origin_error {
            (Base::Offline, Some(bad_origin(error)), false)
        } else if let Some(error) = &config.session_error {
            (Base::SignedOut, Some(bad_session(error)), false)
        } else if authed {
            (Base::Ready, None, true)
        } else {
            (Base::SignedOut, Some(sign_in_notice()), false)
        };
        Self {
            version: version.to_string(),
            cwd: cwd.to_string(),
            origin: config.origin.clone().unwrap_or_else(|| "unset".into()),
            input: String::new(),
            cursor: 0,
            lines: Vec::new(),
            scroll: 0,
            cols: 80,
            body_rows: 21,
            base,
            working: false,
            watching: false,
            reconnect_in: None,
            starting,
            notice,
            overlay: Overlay::None,
            slash_index: 0,
            runs: Vec::new(),
            run_index: 0,
            runs_loading: false,
            cursor_on: true,
            reduce_motion,
            authed,
            epoch: 0,
            watch_gen: 0,
            can_call,
        }
    }

    pub fn startup_effects(&self) -> Vec<Effect> {
        if !self.can_call {
            return Vec::new();
        }
        let mut effects = vec![Effect::Health];
        if self.authed {
            effects.push(Effect::Me { epoch: self.epoch });
        }
        effects
    }

    pub fn presence(&self) -> String {
        if self.working {
            "working".into()
        } else if let Some(secs) = self.reconnect_in {
            format!("reconnecting {secs}s")
        } else if self.watching {
            "watching".into()
        } else if self.starting {
            "connecting".into()
        } else {
            match self.base {
                Base::Ready => "ready",
                Base::SignedOut => "signed out",
                Base::Offline => "offline",
            }
            .into()
        }
    }

    pub fn suggestions(&self) -> Vec<&'static Spec> {
        if self.overlay == Overlay::Shortcuts {
            return Vec::new();
        }
        command::suggestions(&self.input)
    }

    pub fn cursor_byte(&self) -> usize {
        self.cursor.min(self.input.len())
    }

    pub fn show_cursor(&self) -> bool {
        self.cursor_on || self.reduce_motion
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        self.cols = cols;
        self.body_rows = rows.saturating_sub(FOOTER_ROWS);
    }

    pub fn on_tick(&mut self) {
        if !self.reduce_motion {
            self.cursor_on = !self.cursor_on;
        }
    }

    pub fn submit_text(&mut self, text: &str) -> Effect {
        self.input = text.to_string();
        self.cursor = self.input.len();
        self.submit()
    }

    pub fn on_msg(&mut self, msg: Msg) -> Effect {
        match msg {
            Msg::Key(key) => self.on_key(key),
            Msg::Paste(text) => {
                let flat: String = text
                    .chars()
                    .map(|ch| {
                        if ch == '\n' || ch == '\r' || ch == '\t' {
                            ' '
                        } else {
                            ch
                        }
                    })
                    .filter(|ch| !ch.is_control())
                    .collect();
                self.insert(&flat);
                Effect::None
            }
            Msg::Resize(cols, rows) => {
                self.resize(cols, rows);
                Effect::None
            }
            Msg::Health(result) => {
                self.starting = false;
                match result {
                    Ok(()) => {
                        if self.base == Base::Offline {
                            self.base = if self.authed {
                                Base::Ready
                            } else {
                                Base::SignedOut
                            };
                        }
                        if self.authed {
                            self.notice = None;
                        } else if self.lines.is_empty() && self.notice.is_none() {
                            self.notice = Some(sign_in_notice());
                        }
                    }
                    Err(error) => {
                        self.base = Base::Offline;
                        if self.lines.is_empty() {
                            self.notice = Some(offline_notice(&self.origin, &error));
                        } else {
                            self.push(Tone::Error, error);
                        }
                    }
                }
                Effect::None
            }
            Msg::Identified { epoch, result } => {
                if epoch == self.epoch {
                    match result {
                        Ok(_username) => {
                            self.authed = true;
                            self.base = Base::Ready;
                            self.starting = false;
                            self.notice = None;
                        }
                        Err(_) => {
                            self.authed = false;
                            self.base = Base::SignedOut;
                            self.starting = false;
                            if self.lines.is_empty() {
                                self.notice = Some(sign_in_notice());
                            }
                        }
                    }
                }
                Effect::None
            }
            Msg::Session {
                epoch,
                signed_in,
                username,
            } => {
                if epoch == self.epoch {
                    self.authed = signed_in;
                    self.starting = false;
                    if signed_in {
                        self.base = Base::Ready;
                        self.notice = None;
                        let _username = username;
                    } else {
                        self.base = Base::SignedOut;
                        if self.lines.is_empty() {
                            self.notice = Some(sign_in_notice());
                        }
                    }
                }
                Effect::None
            }
            Msg::Lines(lines) => {
                self.lines.extend(lines);
                self.trim();
                if self.scroll == 0 {
                    self.scroll = 0;
                }
                Effect::None
            }
            Msg::Runs(result) => {
                self.runs_loading = false;
                match result {
                    Ok(runs) => {
                        self.runs = runs;
                        self.run_index = self.run_index.min(self.runs.len().saturating_sub(1));
                    }
                    Err(error) => {
                        if self.overlay == Overlay::Runs {
                            self.overlay = Overlay::None;
                        }
                        self.push(Tone::Error, error);
                    }
                }
                Effect::None
            }
            Msg::JobDone => {
                self.working = false;
                Effect::None
            }
            Msg::Watch(note) => self.on_watch(note),
        }
    }

    fn on_watch(&mut self, note: WatchNote) -> Effect {
        let gen = match &note {
            WatchNote::Up { gen }
            | WatchNote::Event { gen, .. }
            | WatchNote::Wait { gen, .. }
            | WatchNote::Down { gen, .. } => *gen,
        };
        if gen != self.watch_gen {
            return Effect::None;
        }
        match note {
            WatchNote::Up { .. } => {
                self.watching = true;
                self.reconnect_in = None;
            }
            WatchNote::Event { text, .. } => {
                self.watching = true;
                self.reconnect_in = None;
                self.push(Tone::Normal, text);
            }
            WatchNote::Wait { secs, .. } => {
                self.watching = true;
                self.reconnect_in = Some(secs);
            }
            WatchNote::Down {
                message,
                unauthorized,
                ..
            } => {
                self.watching = false;
                self.reconnect_in = None;
                if unauthorized {
                    self.authed = false;
                    self.base = Base::SignedOut;
                    self.epoch = self.epoch.saturating_add(1);
                }
                if let Some(message) = message {
                    self.push(Tone::Error, message);
                }
            }
        }
        Effect::None
    }

    fn on_key(&mut self, key: KeyEvent) -> Effect {
        if key.kind == KeyEventKind::Release {
            return Effect::None;
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        if ctrl && matches!(key.code, KeyCode::Char('c')) {
            return Effect::Quit;
        }
        if ctrl && matches!(key.code, KeyCode::Char('l')) {
            self.lines.clear();
            self.scroll = 0;
            self.overlay = Overlay::None;
            return Effect::None;
        }
        if matches!(key.code, KeyCode::Char('?'))
            && !ctrl
            && !alt
            && (self.input.is_empty() || self.overlay == Overlay::Shortcuts)
        {
            self.overlay = if self.overlay == Overlay::Shortcuts {
                Overlay::None
            } else {
                Overlay::Shortcuts
            };
            return Effect::None;
        }
        if matches!(key.code, KeyCode::Esc) {
            if self.overlay != Overlay::None {
                self.overlay = Overlay::None;
                return Effect::None;
            }
            if self.working || self.watching {
                self.working = false;
                self.watching = false;
                self.reconnect_in = None;
                self.push(Tone::Muted, "Stopped.");
                return Effect::Cancel;
            }
            self.input.clear();
            self.cursor = 0;
            return Effect::None;
        }
        if matches!(key.code, KeyCode::PageUp) {
            self.page(true);
            return Effect::None;
        }
        if matches!(key.code, KeyCode::PageDown) {
            self.page(false);
            return Effect::None;
        }
        if matches!(key.code, KeyCode::Tab) && !self.suggestions().is_empty() {
            if let Some(spec) = self.suggestions().get(self.slash_index) {
                self.input = format!("/{} ", spec.name);
                self.cursor = self.input.len();
            }
            return Effect::None;
        }
        let plain = !ctrl && !alt && self.input.is_empty();
        let up =
            matches!(key.code, KeyCode::Up) || (plain && matches!(key.code, KeyCode::Char('k')));
        let down =
            matches!(key.code, KeyCode::Down) || (plain && matches!(key.code, KeyCode::Char('j')));
        if up || down {
            let suggestions = self.suggestions();
            if !suggestions.is_empty() {
                let len = suggestions.len();
                self.slash_index = (self.slash_index + if up { len - 1 } else { 1 }) % len;
                return Effect::None;
            }
            if self.overlay == Overlay::Runs && !self.runs.is_empty() {
                let len = self.runs.len();
                self.run_index = (self.run_index + if up { len - 1 } else { 1 }) % len;
                return Effect::None;
            }
            if plain {
                self.page(up);
                return Effect::None;
            }
        }
        if matches!(key.code, KeyCode::Left) && self.cursor == 0 && self.input.is_empty() && !ctrl {
            if self.working {
                return Effect::None;
            }
            if self.overlay == Overlay::Runs {
                self.overlay = Overlay::None;
                return Effect::None;
            }
            self.overlay = Overlay::Runs;
            self.runs_loading = true;
            return Effect::LoadRuns { epoch: self.epoch };
        }
        if matches!(key.code, KeyCode::Enter) {
            return self.submit();
        }
        if ctrl && matches!(key.code, KeyCode::Char('u')) {
            self.input.clear();
            self.cursor = 0;
            self.slash_index = 0;
            return Effect::None;
        }
        if ctrl && matches!(key.code, KeyCode::Char('w')) {
            self.delete_word();
            return Effect::None;
        }
        if matches!(key.code, KeyCode::Backspace) {
            self.backspace();
            return Effect::None;
        }
        if matches!(key.code, KeyCode::Delete) {
            self.delete_forward();
            return Effect::None;
        }
        if matches!(key.code, KeyCode::Left) {
            self.cursor = prev_boundary(&self.input, self.cursor);
            return Effect::None;
        }
        if matches!(key.code, KeyCode::Right) {
            self.cursor = next_boundary(&self.input, self.cursor);
            return Effect::None;
        }
        if matches!(key.code, KeyCode::Home) || (ctrl && matches!(key.code, KeyCode::Char('a'))) {
            self.cursor = 0;
            return Effect::None;
        }
        if matches!(key.code, KeyCode::End) || (ctrl && matches!(key.code, KeyCode::Char('e'))) {
            self.cursor = self.input.len();
            return Effect::None;
        }
        if let KeyCode::Char(ch) = key.code {
            if !ctrl && !alt && !ch.is_control() {
                self.insert(&ch.to_string());
            }
        }
        Effect::None
    }

    fn submit(&mut self) -> Effect {
        if self.working {
            return Effect::None;
        }
        if self.input.trim().is_empty() {
            if self.overlay == Overlay::Runs {
                if let Some(run) = self.runs.get(self.run_index) {
                    let id = run.id.clone();
                    return self.execute(Command::Run(id));
                }
            }
            self.scroll = 0;
            return Effect::None;
        }
        let chosen = self
            .suggestions()
            .get(self.slash_index)
            .map(|spec| spec.name);
        if let Some(name) = chosen {
            if !self.input.trim().contains(' ') {
                if command::needs_more(name) {
                    self.input = format!("/{name} ");
                    self.cursor = self.input.len();
                    return Effect::None;
                }
                let command = command::parse(&format!("/{name}"));
                self.input.clear();
                self.cursor = 0;
                return self.execute(command);
            }
        }
        let command = command::parse(&self.input);
        self.input.clear();
        self.cursor = 0;
        self.execute(command)
    }

    fn execute(&mut self, command: Command) -> Effect {
        let blocked = if self.can_call {
            None
        } else {
            Some(self.origin_problem())
        };
        self.overlay = Overlay::None;
        self.notice = None;
        self.scroll = 0;
        match command {
            Command::Clear => {
                self.lines.clear();
                Effect::None
            }
            Command::Help => {
                self.push_help();
                Effect::None
            }
            Command::Usage(text) => {
                self.push(Tone::Muted, text);
                Effect::None
            }
            Command::Unknown(text) => {
                self.lines.push(Out::Ask(text));
                self.push(
                    Tone::Muted,
                    "Adamant does not chat. Try /runs, /watch, or /login.",
                );
                self.push(Tone::Muted, "/ for commands · ? for shortcuts");
                Effect::None
            }
            Command::Stop => {
                self.watching = false;
                self.reconnect_in = None;
                self.lines.push(Out::Ask("/stop".into()));
                self.push(Tone::Muted, "Stopped.");
                Effect::Cancel
            }
            Command::Watch => {
                self.lines.push(Out::Ask("/watch".into()));
                self.watching = true;
                self.reconnect_in = None;
                self.watch_gen = self.watch_gen.saturating_add(1);
                self.trim();
                Effect::Watch {
                    gen: self.watch_gen,
                }
            }
            Command::Login => {
                self.lines.push(Out::Ask("/login".into()));
                self.working = true;
                self.epoch = self.epoch.saturating_add(1);
                self.trim();
                Effect::Job {
                    epoch: self.epoch,
                    job: Job::Login { epoch: self.epoch },
                }
            }
            Command::Logout => {
                self.lines.push(Out::Ask("/logout".into()));
                self.working = true;
                self.epoch = self.epoch.saturating_add(1);
                self.trim();
                Effect::Job {
                    epoch: self.epoch,
                    job: Job::Logout { epoch: self.epoch },
                }
            }
            other => {
                if let Some(problem) = blocked {
                    self.lines.push(Out::Ask(other.echo()));
                    self.push(Tone::Error, problem);
                    return Effect::None;
                }
                self.lines.push(Out::Ask(other.echo()));
                self.working = true;
                self.trim();
                let epoch = self.epoch;
                Effect::Job {
                    epoch,
                    job: match other {
                        Command::Status => Job::Status { epoch: self.epoch },
                        Command::Runs => Job::Runs,
                        Command::Run(id) => Job::Run(id),
                        Command::Me => Job::Me,
                        Command::Repos => Job::Repos,
                        Command::Install { owner, name } => Job::Install { owner, name },
                        Command::Trigger {
                            repository_id,
                            source_sha,
                        } => Job::Trigger {
                            repository_id,
                            source_sha,
                        },
                        Command::Clear
                        | Command::Help
                        | Command::Usage(_)
                        | Command::Unknown(_)
                        | Command::Stop
                        | Command::Watch
                        | Command::Login
                        | Command::Logout => return Effect::None,
                    },
                }
            }
        }
    }

    fn origin_problem(&self) -> String {
        self.notice
            .as_ref()
            .map(|notice| {
                notice
                    .lines
                    .first()
                    .cloned()
                    .unwrap_or_else(|| notice.title.clone())
            })
            .unwrap_or_else(|| "ADAMANT_API_URL is not usable.".into())
    }

    fn push_help(&mut self) {
        self.push(Tone::Normal, "Ask Adamant with a slash command.");
        for spec in command::SPECS {
            self.push(Tone::Muted, format!("/{:<10} {}", spec.name, spec.summary));
        }
    }

    fn push(&mut self, tone: Tone, text: impl Into<String>) {
        self.lines.push(Out::line(tone, text));
        self.trim();
    }

    fn trim(&mut self) {
        if self.lines.len() > MAX_LINES {
            let extra = self.lines.len() - MAX_LINES;
            self.lines.drain(..extra);
        }
    }

    fn page(&mut self, up: bool) {
        let width = self.cols.saturating_sub(2).max(1) as usize;
        let rows: usize = self
            .lines
            .iter()
            .map(|line| format::row_count(&line.plain(), width))
            .sum();
        let max = rows.saturating_sub(self.body_rows as usize);
        let step = (self.body_rows as usize).saturating_sub(1).max(1);
        if up {
            self.scroll = (self.scroll + step).min(max);
        } else {
            self.scroll = self.scroll.saturating_sub(step);
        }
    }

    fn insert(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        self.overlay = if self.overlay == Overlay::Shortcuts {
            Overlay::Shortcuts
        } else {
            Overlay::None
        };
        if self.overlay == Overlay::Shortcuts {
            return;
        }
        let cursor = self.cursor.min(self.input.len());
        self.input.insert_str(cursor, text);
        self.cursor = cursor + text.len();
        self.slash_index = 0;
    }

    fn backspace(&mut self) {
        let cursor = self.cursor.min(self.input.len());
        let prev = prev_boundary(&self.input, cursor);
        if prev != cursor {
            self.input.replace_range(prev..cursor, "");
            self.cursor = prev;
            self.slash_index = 0;
        }
    }

    fn delete_forward(&mut self) {
        let cursor = self.cursor.min(self.input.len());
        let next = next_boundary(&self.input, cursor);
        if next != cursor {
            self.input.replace_range(cursor..next, "");
        }
    }

    fn delete_word(&mut self) {
        let cursor = self.cursor.min(self.input.len());
        let bytes = self.input.as_bytes();
        let mut index = cursor;
        while index > 0 && bytes[index - 1].is_ascii_whitespace() {
            index -= 1;
        }
        while index > 0 && !bytes[index - 1].is_ascii_whitespace() {
            index -= 1;
        }
        self.input.replace_range(index..cursor, "");
        self.cursor = index;
        self.slash_index = 0;
    }
}

fn sign_in_notice() -> Notice {
    Notice {
        title: "Sign in to Adamant".into(),
        lines: vec![
            "/login opens GitHub in the browser.".into(),
            "ADAMANT_SESSION works too.".into(),
        ],
    }
}

fn offline_notice(origin: &str, error: &str) -> Notice {
    Notice {
        title: "API unreachable".into(),
        lines: vec![origin.to_string(), error.to_string()],
    }
}

fn bad_origin(error: &str) -> Notice {
    Notice {
        title: "Check ADAMANT_API_URL".into(),
        lines: vec![error.to_string()],
    }
}

fn bad_session(error: &str) -> Notice {
    Notice {
        title: "Check ADAMANT_SESSION".into(),
        lines: vec![error.to_string()],
    }
}

fn prev_boundary(text: &str, index: usize) -> usize {
    let index = index.min(text.len());
    text[..index]
        .char_indices()
        .next_back()
        .map(|(at, _)| at)
        .unwrap_or(0)
}

fn next_boundary(text: &str, index: usize) -> usize {
    let index = index.min(text.len());
    text[index..]
        .chars()
        .next()
        .map(|ch| index + ch.len_utf8())
        .unwrap_or(index)
}
