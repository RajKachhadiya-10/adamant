use std::collections::HashSet;
use std::time::Instant;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use tokio::sync::oneshot;

use crate::api::RunSummary;
use crate::command::{self, Command, Spec};
use crate::config::Config;
use crate::format::{self, Out, Tone};
use crate::github::{GhRepo, Listing, Source};
use crate::theme::FOOTER_ROWS;
use crate::tools::{Approval, Decision};

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
    /// Pick GitHub repositories to install the App on. The composer filters the list.
    Repos,
}

#[derive(Clone, Debug)]
pub struct Notice {
    pub title: String,
    pub lines: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum Job {
    Status,
    Runs,
    Run(String),
    Login {
        epoch: u64,
    },
    Logout {
        epoch: u64,
    },
    Me,
    /// Open GitHub's install page with these picked, then wait for each to be bound.
    InstallRepos(Vec<GhRepo>),
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
    /// Stop the running job or agent turn. The live feed keeps going.
    Cancel,
    StopWatch,
    Batch(Vec<Effect>),
    Health,
    Me {
        epoch: u64,
    },
    Job(Job),
    /// `since` (unix ms) skips the history the feed replays on connect.
    Watch {
        gen: u64,
        since: Option<i64>,
    },
    LoadRuns,
    LoadGithub,
    /// One agent turn. `gen` tags every note it sends back.
    Prompt {
        gen: u64,
        text: String,
    },
    NewChat,
    /// `save` also stores it on the server, which decides whether heals merge their PR.
    /// Off while signed out.
    Mode {
        auto: bool,
        save: bool,
    },
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
    /// The API turned down the session. Sent once per session, whichever call hit it.
    Rejected,
    Lines(Vec<Out>),
    Runs(Result<Vec<RunSummary>, String>),
    JobDone,
    Watch(WatchNote),
    Github(Result<Listing, String>),
    /// Every picked repository is bound: follow the feed so heals show up.
    Installed,
    Agent {
        gen: u64,
        note: AgentNote,
    },
}

pub enum AgentNote {
    /// The next piece of the streaming reply.
    Text(String),
    /// A tool ran; this is what it did.
    Lines(Vec<Out>),
    /// Manual mode: the turn waits on this answer.
    Ask {
        approval: Approval,
        reply: oneshot::Sender<Decision>,
    },
    Error(String),
    Done,
}

pub struct Pending {
    pub approval: Approval,
    reply: Option<oneshot::Sender<Decision>>,
}

pub enum WatchNote {
    Up { gen: u64 },
    Event { gen: u64, line: Out },
    Wait { gen: u64, secs: u64 },
    Down { gen: u64, message: Option<String> },
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
    /// When the slash-command job began. A job can run beside a turn.
    pub job_since: Option<Instant>,
    pub watching: bool,
    pub reconnect_in: Option<u64>,
    pub starting: bool,
    pub notice: Option<Notice>,
    pub overlay: Overlay,
    pub slash_index: usize,
    pub runs: Vec<RunSummary>,
    pub run_index: usize,
    pub runs_loading: bool,
    pub gh_repos: Vec<GhRepo>,
    pub gh_source: Option<Source>,
    pub gh_loading: bool,
    pub repo_index: usize,
    pub picked: HashSet<u64>,
    pub cursor_on: bool,
    reduce_motion: bool,
    pub authed: bool,
    epoch: u64,
    watch_gen: u64,
    can_call: bool,
    /// Commands and edits run without asking.
    pub auto: bool,
    /// Set when an OpenAI key is configured.
    pub model: Option<String>,
    pub turn_started: Option<Instant>,
    pub pending: Option<Pending>,
    turn_gen: u64,
    /// The last line is the reply still streaming in.
    streaming: bool,
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
            job_since: None,
            watching: false,
            reconnect_in: None,
            starting,
            notice,
            overlay: Overlay::None,
            slash_index: 0,
            runs: Vec::new(),
            run_index: 0,
            runs_loading: false,
            gh_repos: Vec::new(),
            gh_source: None,
            gh_loading: false,
            repo_index: 0,
            picked: HashSet::new(),
            cursor_on: true,
            reduce_motion,
            authed,
            epoch: 0,
            watch_gen: 0,
            can_call,
            auto: config.auto,
            model: config.model.as_ref().map(|model| model.model.clone()),
            turn_started: None,
            pending: None,
            turn_gen: 0,
            streaming: false,
        }
    }

    pub fn startup_effects(&mut self) -> Vec<Effect> {
        if !self.can_call {
            return Vec::new();
        }
        let mut effects = vec![Effect::Health];
        if self.authed {
            effects.push(Effect::Me { epoch: self.epoch });
            // Heals on installed repositories show up without typing /watch.
            effects.push(self.follow_quietly(0));
        }
        effects
    }

    /// The live feed from `back_ms` ago on, without replaying older history.
    fn follow_quietly(&mut self, back_ms: i64) -> Effect {
        self.watching = true;
        self.reconnect_in = None;
        self.watch_gen = self.watch_gen.saturating_add(1);
        Effect::Watch {
            gen: self.watch_gen,
            since: Some(format::now_ms() - back_ms),
        }
    }

    pub fn presence(&self) -> String {
        if self.pending.is_some() {
            "waiting for you".into()
        } else if self.working() {
            // The Working row above the composer carries the clock.
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

    /// A turn or a job is running.
    pub fn working(&self) -> bool {
        self.turn_started.is_some() || self.job_since.is_some()
    }

    /// When the work the Working row times began: the turn, else the job.
    pub fn working_since(&self) -> Option<Instant> {
        self.turn_started.or(self.job_since)
    }

    /// The Working row needs frames between ticks to sweep.
    pub fn animating(&self) -> bool {
        self.working() && self.pending.is_none() && !self.reduce_motion
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

    /// The words after `adamant` on the command line.
    pub fn submit_text(&mut self, text: &str) -> Effect {
        self.execute(command::parse_args(text))
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
                if epoch != self.epoch {
                    return Effect::None;
                }
                self.starting = false;
                // A 401 arrives as Msg::Rejected, and an answer that lands after it is stale.
                // Any other failure says nothing about the session, and the health check
                // reports an unreachable API.
                if result.is_err() || !self.authed {
                    return Effect::None;
                }
                self.authed = true;
                self.base = Base::Ready;
                self.notice = None;
                // The server keeps the mode for heals that run while this is closed.
                self.mode_effect()
            }
            Msg::Session {
                epoch,
                signed_in,
                username,
            } => {
                if epoch != self.epoch {
                    return Effect::None;
                }
                self.authed = signed_in;
                self.starting = false;
                if !signed_in {
                    self.base = Base::SignedOut;
                    if self.lines.is_empty() {
                        self.notice = Some(sign_in_notice());
                    }
                    return self.stop_following();
                }
                self.base = Base::Ready;
                self.notice = None;
                let _username = username;
                // Only /login signs in mid-session; next is choosing repositories.
                let mut effects = vec![self.open_repos()];
                if !self.watching {
                    effects.push(self.follow_quietly(0));
                }
                effects.push(self.mode_effect());
                Effect::Batch(effects)
            }
            Msg::Rejected => self.rejected(),
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
                self.job_since = None;
                Effect::None
            }
            Msg::Watch(note) => self.on_watch(note),
            Msg::Github(result) => {
                self.gh_loading = false;
                match result {
                    Ok(listing) => {
                        self.gh_repos = listing.repos;
                        self.gh_source = Some(listing.source);
                        self.repo_index = 0;
                    }
                    Err(error) => {
                        if self.overlay == Overlay::Repos {
                            self.overlay = Overlay::None;
                        }
                        self.push(Tone::Error, error);
                    }
                }
                Effect::None
            }
            Msg::Installed => {
                if self.watching {
                    return Effect::None;
                }
                // The install took minutes; a heal may already have started.
                self.follow_quietly(15 * 60 * 1000)
            }
            Msg::Agent { gen, note } => {
                // A turn that was interrupted can still be sending; its answer is dropped.
                if gen == self.turn_gen {
                    self.on_agent(note);
                }
                Effect::None
            }
        }
    }

    pub fn repo_view(&self) -> Vec<&GhRepo> {
        let filter = self.input.trim().to_ascii_lowercase();
        self.gh_repos
            .iter()
            .filter(|repo| {
                filter.is_empty() || repo.full_name().to_ascii_lowercase().contains(&filter)
            })
            .collect()
    }

    fn open_repos(&mut self) -> Effect {
        self.overlay = Overlay::Repos;
        self.input.clear();
        self.cursor = 0;
        self.picked.clear();
        self.repo_index = 0;
        self.gh_loading = true;
        Effect::LoadGithub
    }

    fn on_repos_key(&mut self, key: KeyEvent, ctrl: bool, alt: bool) -> Effect {
        let shown = self.repo_view().len();
        match key.code {
            KeyCode::Esc => {
                self.overlay = Overlay::None;
                self.input.clear();
                self.cursor = 0;
            }
            KeyCode::Up if shown > 0 => self.repo_index = (self.repo_index + shown - 1) % shown,
            KeyCode::Down if shown > 0 => self.repo_index = (self.repo_index + 1) % shown,
            KeyCode::Char(' ') => {
                if let Some(id) = self.repo_view().get(self.repo_index).map(|repo| repo.id) {
                    if !self.picked.remove(&id) {
                        self.picked.insert(id);
                    }
                }
            }
            KeyCode::Enter => return self.install_picked(),
            KeyCode::Backspace => {
                self.backspace();
                self.repo_index = 0;
            }
            KeyCode::Char('u') if ctrl => {
                self.input.clear();
                self.cursor = 0;
                self.repo_index = 0;
            }
            KeyCode::Char(ch) if !ctrl && !alt && !ch.is_control() => {
                self.input.push(ch);
                self.cursor = self.input.len();
                self.repo_index = 0;
            }
            _ => {}
        }
        Effect::None
    }

    /// The picked repositories, or the highlighted one when nothing is picked.
    fn install_picked(&mut self) -> Effect {
        let mut chosen: Vec<GhRepo> = self
            .gh_repos
            .iter()
            .filter(|repo| self.picked.contains(&repo.id))
            .cloned()
            .collect();
        if chosen.is_empty() {
            if let Some(repo) = self.repo_view().get(self.repo_index) {
                chosen.push((*repo).clone());
            }
        }
        chosen.retain(|repo| !repo.installed);
        self.overlay = Overlay::None;
        self.input.clear();
        self.cursor = 0;
        if chosen.is_empty() {
            self.push(Tone::Muted, "Those repositories already have Adamant.");
            return Effect::None;
        }
        let names: Vec<String> = chosen.iter().map(GhRepo::full_name).collect();
        self.lines
            .push(Out::Ask(format!("/install {}", names.join(" "))));
        if self.job_busy() {
            return Effect::None;
        }
        self.start_job(Job::InstallRepos(chosen))
    }

    /// The driver runs one job at a time and a new one cancels the last, which can be a
    /// long wait on GitHub; say so rather than drop it.
    fn job_busy(&mut self) -> bool {
        if self.job_since.is_none() {
            return false;
        }
        self.push(
            Tone::Muted,
            "Still waiting on the last command. esc stops it.",
        );
        true
    }

    fn start_job(&mut self, job: Job) -> Effect {
        self.job_since = Some(Instant::now());
        self.trim();
        Effect::Job(job)
    }

    fn mode_effect(&self) -> Effect {
        Effect::Mode {
            auto: self.auto,
            save: self.authed && self.can_call,
        }
    }

    /// The feed needs the session; without one it would only reconnect into 401s.
    fn stop_following(&mut self) -> Effect {
        self.watching = false;
        self.reconnect_in = None;
        // Notes the old feed still sends are dropped.
        self.watch_gen = self.watch_gen.saturating_add(1);
        Effect::StopWatch
    }

    /// Every call in flight can hit the same 401; the client reports the first, and the
    /// `authed` check keeps a stray second one quiet.
    fn rejected(&mut self) -> Effect {
        if !self.authed {
            return Effect::None;
        }
        self.authed = false;
        self.base = Base::SignedOut;
        self.starting = false;
        // The calls behind these overlays need the session and send nothing back.
        self.runs_loading = false;
        self.gh_loading = false;
        if matches!(self.overlay, Overlay::Runs | Overlay::Repos) {
            self.overlay = Overlay::None;
        }
        if self.lines.is_empty() {
            self.notice = Some(Notice {
                title: "Sign in to Adamant".into(),
                lines: vec![
                    "The API rejected the saved session: it is unknown, expired, or revoked."
                        .into(),
                    "/login opens GitHub in the browser.".into(),
                ],
            });
        } else {
            let line = format!(
                "{} rejected the session. It is unknown, expired, or revoked. /login signs in again.",
                self.origin
            );
            self.push(Tone::Error, line);
        }
        self.stop_following()
    }

    fn on_agent(&mut self, note: AgentNote) {
        match note {
            AgentNote::Text(delta) => match (self.streaming, self.lines.last_mut()) {
                (true, Some(Out::Agent(text))) => text.push_str(&delta),
                _ => {
                    self.lines.push(Out::Agent(delta));
                    self.streaming = true;
                    self.trim();
                }
            },
            AgentNote::Lines(lines) => {
                self.streaming = false;
                self.lines.extend(lines);
                self.trim();
            }
            AgentNote::Ask { approval, reply } => {
                self.streaming = false;
                self.pending = Some(Pending {
                    approval,
                    reply: Some(reply),
                });
            }
            AgentNote::Error(message) => {
                self.streaming = false;
                self.push(Tone::Error, message);
            }
            AgentNote::Done => {
                if let Some(started) = self.turn_started {
                    let took = format::elapsed(started.elapsed().as_secs());
                    let at = format::local_clock();
                    self.lines.push(Out::Worked(if at.is_empty() {
                        format!("Worked for {took}")
                    } else {
                        format!("Worked for {took} • {at}")
                    }));
                    self.trim();
                }
                self.end_turn();
            }
        }
    }

    fn end_turn(&mut self) {
        self.streaming = false;
        self.turn_started = None;
        // Dropping the reply answers no.
        self.pending = None;
    }

    fn decide(&mut self, decision: Decision) -> Effect {
        if let Some(reply) = self
            .pending
            .take()
            .and_then(|mut pending| pending.reply.take())
        {
            let _ = reply.send(decision);
        }
        if decision == Decision::AllowAll {
            self.auto = true;
            return self.mode_effect();
        }
        Effect::None
    }

    /// Cancel stops the job and the turn together.
    fn interrupt(&mut self) -> Effect {
        let note = if self.turn_started.is_some() {
            self.drop_turn();
            "Interrupted."
        } else {
            "Stopped."
        };
        self.job_since = None;
        self.push(Tone::Muted, note);
        Effect::Cancel
    }

    /// Notes the stopped turn still sends carry the old gen and are dropped.
    fn drop_turn(&mut self) {
        self.turn_gen = self.turn_gen.saturating_add(1);
        self.end_turn();
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
            WatchNote::Event { line, .. } => {
                self.watching = true;
                self.reconnect_in = None;
                self.streaming = false;
                self.lines.push(line);
                self.trim();
            }
            WatchNote::Wait { secs, .. } => {
                self.watching = true;
                self.reconnect_in = Some(secs);
            }
            WatchNote::Down { message, .. } => {
                self.watching = false;
                self.reconnect_in = None;
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
            // Like Codex: the first ctrl-c stops the work, the next one quits.
            if self.working() {
                return self.interrupt();
            }
            return Effect::Quit;
        }
        if matches!(key.code, KeyCode::BackTab) {
            self.auto = !self.auto;
            return self.mode_effect();
        }
        if self.pending.is_some() {
            return match key.code {
                KeyCode::Char('y' | 'Y') | KeyCode::Enter => self.decide(Decision::Allow),
                KeyCode::Char('a' | 'A') => self.decide(Decision::AllowAll),
                KeyCode::Char('n' | 'N') | KeyCode::Esc => self.decide(Decision::Deny),
                KeyCode::PageUp => {
                    self.page(true);
                    Effect::None
                }
                KeyCode::PageDown => {
                    self.page(false);
                    Effect::None
                }
                _ => Effect::None,
            };
        }
        if self.overlay == Overlay::Repos {
            return self.on_repos_key(key, ctrl, alt);
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
            if !self.input.is_empty() {
                self.input.clear();
                self.cursor = 0;
                return Effect::None;
            }
            if self.working() {
                return self.interrupt();
            }
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
            // Loading runs takes the job slot.
            if self.job_since.is_some() {
                return Effect::None;
            }
            if self.overlay == Overlay::Runs {
                self.overlay = Overlay::None;
                return Effect::None;
            }
            self.overlay = Overlay::Runs;
            self.runs_loading = true;
            return Effect::LoadRuns;
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
                    "Unknown command. / lists them; plain text goes to the agent.",
                );
                Effect::None
            }
            Command::Prompt(text) => {
                // Like Codex's steer: a prompt sent mid-turn replaces that turn. The driver
                // cancels the old one when it starts this one.
                if self.turn_started.is_some() {
                    self.drop_turn();
                    self.push(Tone::Muted, "Interrupted to send your new message.");
                }
                self.lines.push(Out::Ask(text.clone()));
                if self.model.is_none() {
                    self.push(
                        Tone::Muted,
                        "The agent needs an OpenAI key: export OPENAI_API_KEY, or save it to ~/.adamant/openai_key, then restart adamant.",
                    );
                    self.push(
                        Tone::Muted,
                        "Slash commands work without one. / lists them.",
                    );
                    return Effect::None;
                }
                self.streaming = false;
                self.turn_gen = self.turn_gen.saturating_add(1);
                self.turn_started = Some(Instant::now());
                self.trim();
                Effect::Prompt {
                    gen: self.turn_gen,
                    text,
                }
            }
            Command::New => {
                if self.turn_started.is_some() {
                    self.drop_turn();
                }
                self.lines.clear();
                Effect::NewChat
            }
            Command::Auto | Command::Manual => {
                self.auto = command == Command::Auto;
                self.lines.push(Out::Ask(command.echo()));
                self.push(
                    Tone::Muted,
                    if self.auto {
                        "Auto: commands, edits and heals run, and heals merge their PR, without asking. shift-tab switches."
                    } else {
                        "Manual: Adamant asks before each command or edit, and heals stop at an open PR for you to review and merge. shift-tab switches."
                    },
                );
                self.mode_effect()
            }
            Command::Repos
            | Command::Install {
                owner: None,
                name: None,
            } => {
                self.lines.push(Out::Ask(command.echo()));
                if let Some(problem) = blocked {
                    self.push(Tone::Error, problem);
                    return Effect::None;
                }
                self.open_repos()
            }
            Command::PickRun => {
                if self.job_busy() {
                    return Effect::None;
                }
                self.overlay = Overlay::Runs;
                self.runs_loading = true;
                Effect::LoadRuns
            }
            Command::Stop => {
                self.watching = false;
                self.reconnect_in = None;
                self.lines.push(Out::Ask("/stop".into()));
                self.push(
                    Tone::Muted,
                    "Stopped the live feed. /watch follows it again.",
                );
                Effect::StopWatch
            }
            Command::Watch => {
                self.lines.push(Out::Ask("/watch".into()));
                self.watching = true;
                self.reconnect_in = None;
                self.watch_gen = self.watch_gen.saturating_add(1);
                self.trim();
                Effect::Watch {
                    gen: self.watch_gen,
                    since: None,
                }
            }
            Command::Login => {
                self.lines.push(Out::Ask("/login".into()));
                if self.job_busy() {
                    return Effect::None;
                }
                if self.authed {
                    self.push(
                        Tone::Muted,
                        "Already signed in. Signing in again replaces this session.",
                    );
                }
                self.epoch = self.epoch.saturating_add(1);
                self.start_job(Job::Login { epoch: self.epoch })
            }
            Command::Logout => {
                self.lines.push(Out::Ask("/logout".into()));
                if self.job_busy() {
                    return Effect::None;
                }
                self.epoch = self.epoch.saturating_add(1);
                self.start_job(Job::Logout { epoch: self.epoch })
            }
            other => {
                if let Some(problem) = blocked {
                    self.lines.push(Out::Ask(other.echo()));
                    self.push(Tone::Error, problem);
                    return Effect::None;
                }
                self.lines.push(Out::Ask(other.echo()));
                if self.job_busy() {
                    return Effect::None;
                }
                self.start_job(match other {
                    Command::Status => Job::Status,
                    Command::Runs => Job::Runs,
                    Command::Run(id) => Job::Run(id),
                    Command::Me => Job::Me,
                    Command::Install { owner, name } => Job::Install { owner, name },
                    Command::Trigger {
                        repository_id,
                        source_sha,
                    } => Job::Trigger {
                        repository_id,
                        source_sha,
                    },
                    Command::Clear
                    | Command::Prompt(_)
                    | Command::PickRun
                    | Command::New
                    | Command::Auto
                    | Command::Manual
                    | Command::Repos
                    | Command::Help
                    | Command::Usage(_)
                    | Command::Unknown(_)
                    | Command::Stop
                    | Command::Watch
                    | Command::Login
                    | Command::Logout => return Effect::None,
                })
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
        self.push(
            Tone::Normal,
            "Type a request and the agent works on it here. Slash commands:",
        );
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

/// The error names where the session came from: the variable or the file.
fn bad_session(error: &str) -> Notice {
    Notice {
        title: "Sign in to Adamant".into(),
        lines: vec![
            error.to_string(),
            "/login opens GitHub in the browser.".into(),
        ],
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ModelConfig;
    use crossterm::event::KeyEvent;

    fn app() -> App {
        let config = Config {
            origin: Some("http://localhost:8787".into()),
            origin_error: None,
            session: Some("session".into()),
            session_error: None,
            model: Some(ModelConfig {
                key: "sk-test".into(),
                base: "http://localhost".into(),
                model: "gpt-6".into(),
                effort: None,
            }),
            auto: true,
        };
        let mut app = App::new("0.1.0", "~", &config, true);
        app.starting = false;
        app.base = Base::Ready;
        app.notice = None;
        app
    }

    fn key(code: KeyCode) -> Msg {
        Msg::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    fn typed(app: &mut App, text: &str) {
        for ch in text.chars() {
            app.on_msg(key(KeyCode::Char(ch)));
        }
    }

    #[test]
    fn a_prompt_streams_into_one_reply() {
        let mut app = app();
        typed(&mut app, "list the files");
        let Effect::Prompt { gen, text } = app.on_msg(key(KeyCode::Enter)) else {
            panic!("plain text should start a turn");
        };
        assert_eq!(text, "list the files");
        assert!(app.working());
        for delta in ["Two ", "files."] {
            app.on_msg(Msg::Agent {
                gen,
                note: AgentNote::Text(delta.into()),
            });
        }
        assert_eq!(app.lines.last(), Some(&Out::Agent("Two files.".into())));
        app.on_msg(Msg::Agent {
            gen,
            note: AgentNote::Done,
        });
        assert!(!app.working());
    }

    #[test]
    fn a_prompt_sent_mid_turn_replaces_the_turn() {
        let mut app = app();
        typed(&mut app, "hello");
        let Effect::Prompt { gen: first, .. } = app.on_msg(key(KeyCode::Enter)) else {
            panic!("expected a turn");
        };
        typed(&mut app, "how are you");
        let Effect::Prompt { gen, text } = app.on_msg(key(KeyCode::Enter)) else {
            panic!("enter mid-turn should send the new prompt");
        };
        assert_eq!(text, "how are you");
        assert_ne!(gen, first);
        assert!(app.working());
        assert!(app.lines.contains(&Out::line(
            Tone::Muted,
            "Interrupted to send your new message."
        )));
        app.on_msg(Msg::Agent {
            gen: first,
            note: AgentNote::Text("stale".into()),
        });
        app.on_msg(Msg::Agent {
            gen: first,
            note: AgentNote::Done,
        });
        assert!(app.working(), "the old turn's Done ended the new one");
        assert!(!app
            .lines
            .iter()
            .any(|line| line == &Out::Agent("stale".into())));
    }

    #[test]
    fn a_prompt_runs_beside_a_job_but_a_second_job_waits() {
        let mut app = app();
        assert!(matches!(app.submit_text("/status"), Effect::Job { .. }));
        typed(&mut app, "why is CI red?");
        assert!(matches!(
            app.on_msg(key(KeyCode::Enter)),
            Effect::Prompt { .. }
        ));
        assert!(matches!(app.submit_text("/runs"), Effect::None));
        assert!(app.lines.contains(&Out::line(
            Tone::Muted,
            "Still waiting on the last command. esc stops it."
        )));
        app.on_msg(Msg::JobDone);
        assert!(app.working(), "the turn is still running");
        assert!(matches!(app.submit_text("/runs"), Effect::Job { .. }));
    }

    #[test]
    fn manual_mode_waits_for_an_answer() {
        let mut app = app();
        assert!(matches!(
            app.on_msg(Msg::Key(KeyEvent::new(
                KeyCode::BackTab,
                KeyModifiers::SHIFT
            ))),
            Effect::Mode {
                auto: false,
                save: true
            }
        ));
        typed(&mut app, "push it");
        let Effect::Prompt { gen, .. } = app.on_msg(key(KeyCode::Enter)) else {
            panic!("expected a turn");
        };
        let (reply, mut answer) = oneshot::channel();
        app.on_msg(Msg::Agent {
            gen,
            note: AgentNote::Ask {
                approval: Approval {
                    title: "Run this command?".into(),
                    detail: vec!["git push".into()],
                },
                reply,
            },
        });
        assert_eq!(app.presence(), "waiting for you");
        // Typing is not an answer; only y, a, n, enter and esc are.
        app.on_msg(key(KeyCode::Char('x')));
        assert!(answer.try_recv().is_err());
        app.on_msg(key(KeyCode::Char('n')));
        assert_eq!(answer.try_recv(), Ok(Decision::Deny));
        assert!(app.pending.is_none());
    }

    #[test]
    fn allow_all_switches_to_auto() {
        let mut app = app();
        app.auto = false;
        let (reply, mut answer) = oneshot::channel();
        app.pending = Some(Pending {
            approval: Approval {
                title: "Write this file?".into(),
                detail: vec![],
            },
            reply: Some(reply),
        });
        assert!(matches!(
            app.on_msg(key(KeyCode::Char('a'))),
            Effect::Mode {
                auto: true,
                save: true
            }
        ));
        assert_eq!(answer.try_recv(), Ok(Decision::AllowAll));
        assert!(app.auto);
    }

    #[test]
    fn notes_from_an_interrupted_turn_are_dropped() {
        let mut app = app();
        typed(&mut app, "do it");
        let Effect::Prompt { gen, .. } = app.on_msg(key(KeyCode::Enter)) else {
            panic!("expected a turn");
        };
        assert!(matches!(app.on_msg(key(KeyCode::Esc)), Effect::Cancel));
        app.on_msg(Msg::Agent {
            gen,
            note: AgentNote::Text("late".into()),
        });
        assert!(!app
            .lines
            .iter()
            .any(|line| line == &Out::Agent("late".into())));
    }

    fn repo(id: u64, name: &str, installed: bool) -> GhRepo {
        GhRepo {
            id,
            owner: "vaish".into(),
            owner_id: 9,
            name: name.into(),
            private: false,
            admin: true,
            installed,
        }
    }

    #[test]
    fn login_opens_the_picker_and_enter_installs_the_picks() {
        let mut app = app();
        let effect = app.on_msg(Msg::Session {
            epoch: 0,
            signed_in: true,
            username: Some("vaish".into()),
        });
        // The picker opens and the live feed starts, so the first heal shows up here.
        let Effect::Batch(effects) = effect else {
            panic!("expected the picker and the feed");
        };
        assert!(matches!(effects[0], Effect::LoadGithub));
        assert!(matches!(effects[1], Effect::Watch { since: Some(_), .. }));
        // The mode goes to the server for the new session too.
        assert!(matches!(
            effects[2],
            Effect::Mode {
                auto: true,
                save: true
            }
        ));
        assert!(app.watching);
        assert_eq!(app.overlay, Overlay::Repos);
        app.on_msg(Msg::Github(Ok(Listing {
            repos: vec![
                repo(1, "adamant", false),
                repo(2, "site", false),
                repo(3, "old", true),
            ],
            source: Source::Gh,
        })));
        typed(&mut app, "si");
        assert_eq!(app.repo_view().len(), 1);
        app.on_msg(key(KeyCode::Char(' ')));
        assert!(app.picked.contains(&2));
        let Effect::Job(Job::InstallRepos(chosen)) = app.on_msg(key(KeyCode::Enter)) else {
            panic!("enter should install");
        };
        assert_eq!(chosen, vec![repo(2, "site", false)]);
        assert_eq!(app.overlay, Overlay::None);
        assert!(app.working());
    }

    #[test]
    fn esc_clears_the_line_and_never_stops_the_feed() {
        let mut app = app();
        app.startup_effects();
        assert!(app.watching);
        typed(&mut app, "half a thought");
        assert!(matches!(app.on_msg(key(KeyCode::Esc)), Effect::None));
        assert!(app.input.is_empty());
        assert!(matches!(app.on_msg(key(KeyCode::Esc)), Effect::None));
        assert!(app.watching);
        assert!(matches!(app.submit_text("/stop"), Effect::StopWatch));
        assert!(!app.watching);
    }

    fn signed_out() -> App {
        let config = Config {
            session: None,
            ..app_config()
        };
        App::new("0.1.0", "~", &config, true)
    }

    fn app_config() -> Config {
        Config {
            origin: Some("http://localhost:8787".into()),
            origin_error: None,
            session: Some("session".into()),
            session_error: None,
            model: None,
            auto: true,
        }
    }

    fn shift_tab() -> Msg {
        Msg::Key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT))
    }

    #[test]
    fn the_mode_is_saved_only_when_signed_in() {
        let mut app = app();
        assert!(matches!(
            app.on_msg(shift_tab()),
            Effect::Mode {
                auto: false,
                save: true
            }
        ));
        assert!(matches!(
            app.submit_text("/auto"),
            Effect::Mode {
                auto: true,
                save: true
            }
        ));
        assert!(app.lines.contains(&Out::line(
            Tone::Muted,
            "Auto: commands, edits and heals run, and heals merge their PR, without asking. shift-tab switches."
        )));
        assert!(matches!(
            app.submit_text("/manual"),
            Effect::Mode {
                auto: false,
                save: true
            }
        ));
        assert!(app.lines.contains(&Out::line(
            Tone::Muted,
            "Manual: Adamant asks before each command or edit, and heals stop at an open PR for you to review and merge. shift-tab switches."
        )));

        let mut app = signed_out();
        assert!(matches!(
            app.on_msg(shift_tab()),
            Effect::Mode {
                auto: false,
                save: false
            }
        ));
        // A session with no usable API has nowhere to save it either.
        let config = Config {
            origin: None,
            origin_error: Some("ADAMANT_API_URL must be a valid absolute URL.".into()),
            ..app_config()
        };
        let mut app = App::new("0.1.0", "~", &config, true);
        assert!(matches!(
            app.on_msg(shift_tab()),
            Effect::Mode { save: false, .. }
        ));
    }

    #[test]
    fn a_confirmed_session_pushes_the_mode_once_known_good() {
        let mut app = App::new(
            "0.1.0",
            "~",
            &Config {
                auto: false,
                ..app_config()
            },
            true,
        );
        let stale = app.on_msg(Msg::Identified {
            epoch: 7,
            result: Ok("vaish".into()),
        });
        assert!(matches!(stale, Effect::None));
        assert!(app.starting);
        assert!(matches!(
            app.on_msg(Msg::Identified {
                epoch: 0,
                result: Ok("vaish".into()),
            }),
            Effect::Mode {
                auto: false,
                save: true
            }
        ));
        assert_eq!(app.base, Base::Ready);
    }

    #[test]
    fn a_late_confirmation_does_not_undo_a_rejection() {
        let mut app = App::new("0.1.0", "~", &app_config(), true);
        app.on_msg(Msg::Rejected);
        assert!(matches!(
            app.on_msg(Msg::Identified {
                epoch: 0,
                result: Ok("vaish".into()),
            }),
            Effect::None
        ));
        assert!(!app.authed);
        assert_eq!(app.base, Base::SignedOut);
    }

    #[test]
    fn an_unreachable_api_does_not_sign_you_out() {
        let mut app = App::new("0.1.0", "~", &app_config(), true);
        app.on_msg(Msg::Health(Err("Could not reach the Adamant API.".into())));
        assert!(matches!(
            app.on_msg(Msg::Identified {
                epoch: 0,
                result: Err("Could not reach the Adamant API.".into()),
            }),
            Effect::None
        ));
        assert!(app.authed);
        assert!(!app.starting);
        assert_eq!(app.presence(), "offline");
    }

    #[test]
    fn a_rejected_session_signs_out_once_and_stops_the_feed() {
        let mut app = app();
        let started = app.startup_effects();
        let Some(Effect::Watch { gen, .. }) = started.last().cloned() else {
            panic!("expected the feed");
        };
        app.push(Tone::Normal, "earlier work");
        assert!(matches!(app.on_msg(Msg::Rejected), Effect::StopWatch));
        assert!(!app.authed);
        assert!(!app.watching);
        assert_eq!(app.presence(), "signed out");
        let rejected = |line: &Out| line.plain().contains("rejected the session");
        assert_eq!(app.lines.iter().filter(|line| rejected(line)).count(), 1);

        // Another call that hit the same 401, and the old feed going down, add nothing.
        assert!(matches!(app.on_msg(Msg::Rejected), Effect::None));
        app.on_msg(Msg::Watch(WatchNote::Down {
            gen,
            message: Some("stale".into()),
        }));
        app.on_msg(Msg::Watch(WatchNote::Wait { gen, secs: 2 }));
        assert_eq!(app.lines.iter().filter(|line| rejected(line)).count(), 1);
        assert!(!app.lines.iter().any(|line| line.plain() == "stale"));
        assert_eq!(app.reconnect_in, None);
        assert!(!app.watching);

        // Signed out, mode changes stay local.
        assert!(matches!(
            app.on_msg(shift_tab()),
            Effect::Mode { save: false, .. }
        ));
    }

    #[test]
    fn a_rejected_session_on_an_empty_screen_shows_the_notice() {
        let mut app = app();
        app.on_msg(key(KeyCode::Left));
        assert_eq!(app.overlay, Overlay::Runs);
        assert!(app.runs_loading);
        app.on_msg(Msg::Rejected);
        assert_eq!(app.overlay, Overlay::None);
        assert!(!app.runs_loading);
        let notice = app.notice.clone().expect("notice");
        assert_eq!(notice.title, "Sign in to Adamant");
        assert!(notice.lines[0].contains("rejected the saved session"));
        assert!(app.lines.is_empty());
    }

    #[test]
    fn login_while_signed_in_says_it_replaces_the_session() {
        let mut app = app();
        assert!(matches!(
            app.submit_text("/login"),
            Effect::Job(Job::Login { epoch: 1 })
        ));
        assert!(app.lines.contains(&Out::line(
            Tone::Muted,
            "Already signed in. Signing in again replaces this session."
        )));
        app.on_msg(Msg::JobDone);

        let mut app = signed_out();
        assert!(matches!(
            app.submit_text("/login"),
            Effect::Job(Job::Login { .. })
        ));
        assert!(!app
            .lines
            .iter()
            .any(|line| line.plain().contains("Already signed in")));
    }

    #[test]
    fn logout_stops_the_feed() {
        let mut app = app();
        app.startup_effects();
        let Effect::Job(Job::Logout { epoch }) = app.submit_text("/logout") else {
            panic!("expected the logout job");
        };
        assert!(matches!(
            app.on_msg(Msg::Session {
                epoch,
                signed_in: false,
                username: None,
            }),
            Effect::StopWatch
        ));
        assert!(!app.authed);
        assert!(!app.watching);
        assert_eq!(app.base, Base::SignedOut);
    }

    #[test]
    fn a_bad_session_says_where_it_came_from_and_the_way_out() {
        let error = "~/.adamant/session does not hold a valid session. /login replaces it.";
        let config = Config {
            session: None,
            session_error: Some(error.into()),
            ..app_config()
        };
        let app = App::new("0.1.0", "~", &config, true);
        assert!(!app.authed);
        let notice = app.notice.expect("notice");
        assert_eq!(notice.lines[0], error);
        assert!(notice.lines[1].contains("/login"));
    }

    #[test]
    fn installed_repositories_are_not_installed_again() {
        let mut app = app();
        app.open_repos();
        app.on_msg(Msg::Github(Ok(Listing {
            repos: vec![repo(3, "old", true)],
            source: Source::Gh,
        })));
        assert!(matches!(app.on_msg(key(KeyCode::Enter)), Effect::None));
        assert!(!app.working());
    }
}
