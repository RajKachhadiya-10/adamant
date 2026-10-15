use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Command as Process;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tokio::sync::{mpsc::UnboundedSender, oneshot, watch, Mutex};
use uuid::Uuid;

use crate::agent::{Agent, Call, Outcome};
use crate::api::{ApiError, Client, LoginPoll, SseParser};
use crate::app::{AgentNote, Effect, Job, Msg, WatchNote};
use crate::config::{self, Config};
use crate::format::{self, Out, Tone};
use crate::github::{self, GhRepo, Listing, Source};
use crate::tools::{self, Ctx, Decision, Request};

pub struct Driver {
    client: Option<Client>,
    tx: UnboundedSender<Msg>,
    job: Option<watch::Sender<bool>>,
    feed: Option<watch::Sender<bool>>,
    agent: Option<Arc<Mutex<Agent>>>,
    turn: Option<watch::Sender<bool>>,
    /// Read by the running turn before each command or edit.
    auto: Arc<AtomicBool>,
    /// Set by /new; the next turn clears the history before it starts.
    reset: Arc<AtomicBool>,
    /// The latest mode to store on the server. One task sends them in order, so quick
    /// shift-tabs cannot land out of order.
    saving: Option<watch::Sender<bool>>,
    cwd: PathBuf,
}

impl Driver {
    pub fn new(config: &Config, tx: UnboundedSender<Msg>) -> Self {
        let rejected = tx.clone();
        let client = config.origin.clone().and_then(|origin| {
            Client::new(origin, config.session.clone())
                .ok()
                .map(|client| {
                    client.when_rejected(move || {
                        let _ = rejected.send(Msg::Rejected);
                    })
                })
        });
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let agent = config.model.clone().and_then(|model| {
            Agent::new(
                model,
                crate::prompt::instructions(&cwd),
                tools::definitions(),
            )
            .ok()
            .map(|agent| Arc::new(Mutex::new(agent)))
        });
        Self {
            client,
            tx,
            job: None,
            feed: None,
            agent,
            turn: None,
            auto: Arc::new(AtomicBool::new(config.auto)),
            reset: Arc::new(AtomicBool::new(false)),
            saving: None,
            cwd,
        }
    }

    pub fn dispatch(&mut self, effect: Effect) {
        match effect {
            Effect::None | Effect::Quit => {}
            Effect::Cancel => {
                self.stop_job();
                self.stop_turn();
            }
            Effect::StopWatch => self.stop_feed(),
            Effect::Batch(effects) => {
                for effect in effects {
                    self.dispatch(effect);
                }
            }
            Effect::Health => self.spawn_health(),
            Effect::Me { epoch } => self.spawn_me(epoch),
            Effect::Watch { gen, since } => self.spawn_watch(gen, since),
            Effect::LoadRuns => self.spawn_list(true),
            Effect::LoadGithub => self.spawn_github(),
            Effect::Job(Job::Runs) => self.spawn_list(false),
            Effect::Job(job) => self.spawn_job(job),
            Effect::Prompt { gen, text } => self.spawn_turn(gen, text),
            Effect::NewChat => {
                self.stop_turn();
                self.reset.store(true, Ordering::SeqCst);
            }
            Effect::Mode { auto, save } => {
                self.auto.store(auto, Ordering::SeqCst);
                if save {
                    self.save_mode(auto);
                }
            }
        }
    }

    /// Fire and forget. Signed out there is nothing to save it to.
    fn save_mode(&mut self, auto: bool) {
        let Some(client) = self.client.clone().filter(Client::signed_in) else {
            return;
        };
        if let Some(sender) = &self.saving {
            if sender.send(auto).is_ok() {
                return;
            }
        }
        let (sender, mut wanted) = watch::channel(auto);
        wanted.mark_changed();
        self.saving = Some(sender);
        let tx = self.tx.clone();
        tokio::spawn(async move {
            // A server that keeps failing the same way says so once, not on every switch.
            let mut said = None;
            while wanted.changed().await.is_ok() {
                let auto = *wanted.borrow_and_update();
                let line = store_mode(&client, auto).await;
                if line.is_some() && line != said {
                    let _ = tx.send(Msg::Lines(line.iter().cloned().collect()));
                }
                said = line;
            }
        });
    }

    fn stop_turn(&mut self) {
        if let Some(sender) = self.turn.take() {
            let _ = sender.send(true);
        }
    }

    fn spawn_turn(&mut self, gen: u64, text: String) {
        let note = |note| Msg::Agent { gen, note };
        let Some(agent) = self.agent.clone() else {
            let _ = self.tx.send(note(AgentNote::Error(
                "The agent needs an OpenAI key.".into(),
            )));
            let _ = self.tx.send(note(AgentNote::Done));
            return;
        };
        self.stop_turn();
        let (sender, mut cancel) = watch::channel(false);
        self.turn = Some(sender);
        let turn = Turn {
            gen,
            tx: self.tx.clone(),
            client: self.client.clone(),
            auto: self.auto.clone(),
            cwd: self.cwd.clone(),
        };
        let reset = self.reset.clone();
        tokio::spawn(async move {
            let _done = TurnDone(Some((turn.tx.clone(), gen)));
            // The turn it interrupted lets go of the agent as soon as it sees the cancel.
            let mut agent = agent.lock().await;
            if reset.swap(false, Ordering::SeqCst) {
                agent.reset();
            }
            if *cancel.borrow() {
                return;
            }
            agent.push_user(&text);
            turn.run(&mut agent, &mut cancel).await;
        });
    }

    fn stop_job(&mut self) {
        if let Some(sender) = self.job.take() {
            let _ = sender.send(true);
        }
    }

    fn stop_feed(&mut self) {
        if let Some(sender) = self.feed.take() {
            let _ = sender.send(true);
        }
    }

    fn job_cancel(&mut self) -> watch::Receiver<bool> {
        self.stop_job();
        let (sender, receiver) = watch::channel(false);
        self.job = Some(sender);
        receiver
    }

    fn spawn_health(&self) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .health()
                .await
                .map(|_| ())
                .map_err(|error| error.message);
            let _ = tx.send(Msg::Health(result));
        });
    }

    fn spawn_me(&self, epoch: u64) {
        let Some(client) = self.client.clone() else {
            return;
        };
        let tx = self.tx.clone();
        tokio::spawn(async move {
            let result = client
                .me()
                .await
                .map(|user| user.username)
                .map_err(|error| error.message);
            let _ = tx.send(Msg::Identified { epoch, result });
        });
    }

    fn spawn_list(&mut self, quiet: bool) {
        let Some(client) = self.client.clone() else {
            let _ = self
                .tx
                .send(Msg::Runs(Err("The API client is not available.".into())));
            return;
        };
        let tx = self.tx.clone();
        let cancel = self.job_cancel();
        tokio::spawn(async move {
            let _finish = (!quiet).then(|| Finish(Some(tx.clone())));
            if *cancel.borrow() {
                return;
            }
            match client.list_runs().await {
                Ok(runs) => {
                    if !quiet {
                        let lines = if runs.is_empty() {
                            vec![Out::line(Tone::Muted, "No runs yet.")]
                        } else {
                            let now = format::now_ms();
                            runs.iter()
                                .map(|run| {
                                    Out::line(
                                        format::status_tone(&run.status),
                                        format::format_run_row(run, now),
                                    )
                                })
                                .collect()
                        };
                        let _ = tx.send(Msg::Lines(lines));
                    }
                    let _ = tx.send(Msg::Runs(Ok(runs)));
                }
                // Msg::Rejected says so, and closes the list.
                Err(error) if error.status == Some(401) => {}
                Err(error) => {
                    let _ = tx.send(Msg::Runs(Err(error.message)));
                }
            }
        });
    }

    /// Not on the job slot: it opens right as /login finishes, and must not cancel it.
    fn spawn_github(&self) {
        let Some(client) = self.client.clone() else {
            let _ = self
                .tx
                .send(Msg::Github(Err("The API client is not available.".into())));
            return;
        };
        let tx = self.tx.clone();
        tokio::spawn(async move {
            match github_listing(&client).await {
                // Msg::Rejected says so, and closes the picker.
                Err(error) if error.status == Some(401) => {}
                result => {
                    let _ = tx.send(Msg::Github(result.map_err(|error| error.message)));
                }
            }
        });
    }

    fn spawn_job(&mut self, job: Job) {
        let Some(client) = self.client.clone() else {
            let lines = match job {
                // The file goes even when ADAMANT_API_URL is unusable.
                Job::Logout { epoch } => sign_out_here(&self.tx, epoch),
                _ => vec![Out::line(Tone::Error, "The API client is not available.")],
            };
            let _ = self.tx.send(Msg::Lines(lines));
            let _ = self.tx.send(Msg::JobDone);
            return;
        };
        let tx = self.tx.clone();
        let mut cancel = self.job_cancel();
        tokio::spawn(async move {
            let _finish = Finish(Some(tx.clone()));
            if *cancel.borrow() {
                return;
            }
            if let Err(error) = run_job(job, &client, &tx, &mut cancel).await {
                // A rejected session is announced once, by Msg::Rejected.
                if !*cancel.borrow() && error.status != Some(401) {
                    let _ = tx.send(Msg::Lines(vec![Out::line(Tone::Error, error.message)]));
                }
            }
        });
    }

    fn spawn_watch(&mut self, gen: u64, since: Option<i64>) {
        let Some(client) = self.client.clone() else {
            let _ = self.tx.send(Msg::Watch(WatchNote::Down {
                gen,
                message: Some("The API client is not available.".into()),
            }));
            return;
        };
        self.stop_feed();
        let (sender, mut cancel) = watch::channel(false);
        self.feed = Some(sender);
        let tx = self.tx.clone();
        tokio::spawn(async move {
            follow(client, tx, gen, since, &mut cancel).await;
        });
    }
}

struct Turn {
    gen: u64,
    tx: UnboundedSender<Msg>,
    client: Option<Client>,
    auto: Arc<AtomicBool>,
    cwd: PathBuf,
}

/// Each step resends the history; this bounds a model that never stops calling tools.
const MAX_STEPS: usize = 200;

impl Turn {
    fn note(&self, note: AgentNote) {
        let _ = self.tx.send(Msg::Agent {
            gen: self.gen,
            note,
        });
    }

    async fn run(&self, agent: &mut Agent, cancel: &mut watch::Receiver<bool>) {
        for _ in 0..MAX_STEPS {
            let outcome = agent
                .respond(
                    |delta| self.note(AgentNote::Text(delta.to_string())),
                    cancel,
                )
                .await;
            let calls = match outcome {
                Ok(Outcome::Done(calls)) => calls,
                Ok(Outcome::Cancelled) => return,
                Err(message) => {
                    self.note(AgentNote::Error(message));
                    return;
                }
            };
            if calls.is_empty() {
                return;
            }
            // Every call gets an answer, even after esc, or the next request is rejected.
            for call in calls {
                let output = if *cancel.borrow() {
                    "Interrupted by the user.".to_string()
                } else {
                    self.call(&call, cancel).await
                };
                agent.push_output(&call.call_id, &output);
            }
            if *cancel.borrow() {
                return;
            }
        }
        self.note(AgentNote::Error(format!(
            "Stopped after {MAX_STEPS} steps. Ask again to continue."
        )));
    }

    async fn call(&self, call: &Call, cancel: &mut watch::Receiver<bool>) -> String {
        let request = match Request::parse(&call.name, &call.arguments) {
            Ok(request) => request,
            Err(message) => {
                self.note(AgentNote::Lines(vec![Out::line(
                    Tone::Error,
                    format!("• {message}"),
                )]));
                return format!("error: {message}");
            }
        };
        if request.needs_approval() && !self.auto.load(Ordering::SeqCst) {
            let approval = request.approval(&self.cwd);
            let (reply, answer) = oneshot::channel();
            self.note(AgentNote::Ask {
                approval: approval.clone(),
                reply,
            });
            let decision = tokio::select! {
                decision = answer => decision.unwrap_or(Decision::Deny),
                _ = cancel.changed() => return "Interrupted by the user.".into(),
            };
            match decision {
                Decision::Allow => {}
                Decision::AllowAll => self.auto.store(true, Ordering::SeqCst),
                Decision::Deny => {
                    let what = approval.detail.first().cloned().unwrap_or_default();
                    self.note(AgentNote::Lines(vec![Out::line(
                        Tone::Muted,
                        format!("✗ Declined {}", format::brief(&what, 100)),
                    )]));
                    return "The user declined this call. Do not retry it; ask what they want instead."
                        .into();
                }
            }
        }
        let ctx = Ctx {
            cwd: &self.cwd,
            client: self.client.as_ref(),
        };
        let outcome = request.run(&ctx, cancel).await;
        self.note(AgentNote::Lines(outcome.lines));
        outcome.output
    }
}

struct TurnDone(Option<(UnboundedSender<Msg>, u64)>);

impl Drop for TurnDone {
    fn drop(&mut self) {
        if let Some((tx, gen)) = self.0.take() {
            let _ = tx.send(Msg::Agent {
                gen,
                note: AgentNote::Done,
            });
        }
    }
}

struct Finish(Option<UnboundedSender<Msg>>);

impl Drop for Finish {
    fn drop(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(Msg::JobDone);
        }
    }
}

async fn run_job(
    job: Job,
    client: &Client,
    tx: &UnboundedSender<Msg>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), ApiError> {
    match job {
        Job::Status => status(client, tx).await,
        Job::Run(id) => {
            let detail = client.get_run(&id).await?;
            let _ = tx.send(Msg::Lines(format::format_run_detail(&detail)));
            Ok(())
        }
        Job::Login { epoch } => login(client, tx, epoch, cancel).await,
        Job::Logout { epoch } => logout(client, tx, epoch).await,
        Job::Me => {
            let user = client.me().await?;
            let _ = tx.send(Msg::Lines(format::format_user(&user)));
            Ok(())
        }
        Job::InstallRepos(repos) => install_many(client, tx, repos, cancel).await,
        Job::Install { owner, name } => install(client, tx, owner, name, cancel).await,
        Job::Trigger {
            repository_id,
            source_sha,
        } => trigger(client, tx, &repository_id, &source_sha).await,
        Job::Runs => Ok(()),
    }
}

async fn status(client: &Client, tx: &UnboundedSender<Msg>) -> Result<(), ApiError> {
    client.health().await?;
    let _ = tx.send(Msg::Health(Ok(())));
    let mut lines = vec![Out::line(
        Tone::Success,
        format!("api  {}  ok", client.origin()),
    )];
    // A 401 here also signs the app out, through Msg::Rejected.
    match client.me().await {
        Ok(user) => lines.extend(format::format_user(&user)),
        Err(_) => lines.push(Out::line(Tone::Muted, "session  signed out")),
    }
    let _ = tx.send(Msg::Lines(lines));
    Ok(())
}

async fn login(
    client: &Client,
    tx: &UnboundedSender<Msg>,
    epoch: u64,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), ApiError> {
    let start = client.start_login().await?;
    let url = login_url(client.origin(), &start.begin_path).map_err(|message| ApiError {
        status: None,
        message,
    })?;
    let _ = tx.send(Msg::Lines(login_prompt(&start.user_code, &url)));
    open_browser(&url);
    let deadline = Instant::now() + Duration::from_secs(15 * 60);
    match wait_for_token(
        client,
        &start.login_id,
        &start.poll_secret,
        deadline,
        cancel,
    )
    .await?
    {
        Some(token) => signed_in(client, tx, epoch, token).await,
        None => Ok(()),
    }
}

/// The code comes first and stands out: after GitHub the browser shows a code and
/// asks whether it is this one, and that answer is all that keeps a sign-in link
/// someone else sent from signing their terminal in as you.
fn login_prompt(code: &str, url: &str) -> Vec<Out> {
    vec![
        Out::line(
            Tone::Accent,
            format!("Confirm the code {code} in your browser."),
        ),
        Out::line(
            Tone::Muted,
            "If the page shows any other code, cancel there.",
        ),
        Out::line(Tone::Normal, "Waiting for GitHub. esc cancels."),
        Out::line(Tone::Link, url.to_string()),
    ]
}

/// `None` when esc stopped it. esc mid-poll drops the answer, so a cancelled sign-in
/// stores nothing.
async fn wait_for_token(
    client: &Client,
    login_id: &str,
    poll_secret: &str,
    deadline: Instant,
    cancel: &mut watch::Receiver<bool>,
) -> Result<Option<String>, ApiError> {
    loop {
        if *cancel.borrow() {
            return Ok(None);
        }
        if Instant::now() > deadline {
            return Err(ApiError {
                status: None,
                message: "Sign-in timed out. /login starts another.".into(),
            });
        }
        let poll = tokio::select! {
            _ = cancel.changed() => return Ok(None),
            poll = client.poll_login(login_id, poll_secret) => poll?,
        };
        if let LoginPoll::Token(token) = poll {
            return Ok(Some(token));
        }
        tokio::select! {
            _ = cancel.changed() => return Ok(None),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

async fn signed_in(
    client: &Client,
    tx: &UnboundedSender<Msg>,
    epoch: u64,
    token: String,
) -> Result<(), ApiError> {
    client.set_session(Some(token.clone()));
    // Checked before it is stored, so a session the API turns down never reaches the disk.
    let username = match client.me().await {
        Ok(user) => Some(user.username),
        Err(error) if error.status == Some(401) => {
            return Err(ApiError {
                status: None,
                message: "The API turned down the session it just issued. /login tries again."
                    .into(),
            })
        }
        Err(_) => None,
    };
    let mut lines = vec![Out::line(
        Tone::Success,
        match &username {
            Some(name) => format!("Signed in as {name}."),
            None => "Signed in.".into(),
        },
    )];
    if let Err(error) = config::store_session(&token) {
        lines.push(Out::line(Tone::Muted, error));
    } else if config::session_in_env() {
        lines.push(Out::line(
            Tone::Muted,
            "ADAMANT_SESSION is set in this shell and wins over ~/.adamant/session. Unset it to keep this sign-in next time.",
        ));
    }
    let _ = tx.send(Msg::Session {
        epoch,
        signed_in: true,
        username,
    });
    let _ = tx.send(Msg::Lines(lines));
    Ok(())
}

/// Signs out here first, so an unreachable API or a session it already revoked still
/// leaves the terminal signed out.
async fn logout(client: &Client, tx: &UnboundedSender<Msg>, epoch: u64) -> Result<(), ApiError> {
    let token = client.take_session();
    let mut lines = sign_out_here(tx, epoch);
    if let Some(token) = token {
        match client.revoke(&token).await {
            Ok(()) => {}
            // The API had already let it go.
            Err(error) if error.status == Some(401) => {}
            Err(error) => lines.push(Out::line(
                Tone::Muted,
                format!(
                    "{} The session stays valid on the server until it expires.",
                    error.message
                ),
            )),
        }
    }
    let _ = tx.send(Msg::Lines(lines));
    Ok(())
}

fn sign_out_here(tx: &UnboundedSender<Msg>, epoch: u64) -> Vec<Out> {
    let _ = tx.send(Msg::Session {
        epoch,
        signed_in: false,
        username: None,
    });
    let mut lines = vec![Out::line(Tone::Muted, "Signed out.")];
    if let Err(error) = config::clear_session_file() {
        lines.push(Out::line(Tone::Error, error));
    }
    lines
}

async fn github_listing(client: &Client) -> Result<Listing, ApiError> {
    // Without Postgres the API cannot say what is installed; the list still helps.
    let installed: std::collections::HashSet<String> = match client.list_repos().await {
        Ok(repos) => repos
            .iter()
            .map(|repo| format!("{}/{}", repo.owner, repo.name).to_ascii_lowercase())
            .collect(),
        Err(error) if error.status == Some(401) => return Err(error),
        Err(_) => Default::default(),
    };
    let (mut repos, source) = match github::list_with_gh().await {
        Ok(repos) => (repos, Source::Gh),
        Err(_) => {
            let user = client.me().await?;
            let repos = github::list_public(&user.username)
                .await
                .map_err(|message| ApiError {
                    status: None,
                    message,
                })?;
            (repos, Source::Public)
        }
    };
    github::mark_installed(&mut repos, &installed);
    Ok(Listing { repos, source })
}

/// Seconds of waiting before the transcript says why the install is taking a while.
const INSTALL_HINT_SECS: u64 = 45;

/// The webhook is the fast path; the worker's sync asks GitHub directly as well.
fn still_waiting(origin: &str) -> Out {
    Out::line(
        Tone::Muted,
        format!(
            "Still waiting. Adamant also checks GitHub directly, so this finishes within about a minute even if the webhook never arrives. Instant updates need the App's webhook to reach {origin}/webhooks/github."
        ),
    )
}

async fn install_many(
    client: &Client,
    tx: &UnboundedSender<Msg>,
    repos: Vec<GhRepo>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), ApiError> {
    let url = client.install_url().await.map_err(|mut error| {
        if error.status == Some(503) && error.message.contains("slug") {
            error.message = format!(
                "{} Set GITHUB_APP_SLUG (the <slug> in github.com/apps/<slug>) in the API's .env and restart the API.",
                error.message
            );
        }
        error
    })?;
    let slug = github::app_slug(&url).ok_or_else(|| ApiError {
        status: None,
        message: "The install URL from the API was not usable.".into(),
    })?;

    // GitHub installs per account, so each owner gets its own page.
    let mut owners: Vec<(u64, String, Vec<u64>)> = Vec::new();
    for repo in &repos {
        match owners.iter_mut().find(|(id, ..)| *id == repo.owner_id) {
            Some((_, _, ids)) => ids.push(repo.id),
            None => owners.push((repo.owner_id, repo.owner.clone(), vec![repo.id])),
        }
    }
    let mut lines = vec![Out::line(
        Tone::Normal,
        "Approve the install on GitHub. The repositories are already picked there.",
    )];
    for (owner_id, owner, ids) in &owners {
        let link = github::install_link(slug, *owner_id, ids);
        lines.push(Out::line(Tone::Muted, format!("{owner}:")));
        lines.push(Out::line(Tone::Link, link.clone()));
        open_browser(&link);
    }
    if repos.iter().any(|repo| !repo.admin) {
        lines.push(Out::line(
            Tone::Muted,
            "Where you are not an admin, GitHub sends the owner a request instead.",
        ));
    }
    lines.push(Out::line(
        Tone::Muted,
        "Waiting for GitHub to confirm the install. esc cancels.",
    ));
    let _ = tx.send(Msg::Lines(lines));

    let started = Instant::now();
    let deadline = started + Duration::from_secs(15 * 60);
    let mut hinted = false;
    let mut waiting: Vec<GhRepo> = repos;
    while !waiting.is_empty() {
        if *cancel.borrow() {
            return Ok(());
        }
        let mut still = Vec::new();
        for repo in waiting {
            match client.install_status(&repo.owner, &repo.name).await {
                Ok((_, branch)) => {
                    let _ = tx.send(Msg::Lines(vec![Out::line(
                        Tone::Success,
                        format!("Installed on {} ({branch}).", repo.full_name()),
                    )]));
                }
                Err(error) if error.status == Some(404) => still.push(repo),
                Err(error) => return Err(error),
            }
        }
        waiting = still;
        if waiting.is_empty() {
            break;
        }
        if !hinted && started.elapsed() > Duration::from_secs(INSTALL_HINT_SECS) {
            hinted = true;
            let _ = tx.send(Msg::Lines(vec![still_waiting(client.origin())]));
        }
        if Instant::now() > deadline {
            return Err(ApiError {
                status: None,
                message: "Still waiting on the GitHub install. /repos shows what landed.".into(),
            });
        }
        tokio::select! {
            _ = cancel.changed() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
    }
    let _ = tx.send(Msg::Lines(vec![Out::line(
        Tone::Success,
        "Adamant is on. A failing check on the default branch starts a heal; it shows up here.",
    )]));
    let _ = tx.send(Msg::Installed);
    Ok(())
}

async fn install(
    client: &Client,
    tx: &UnboundedSender<Msg>,
    owner: Option<String>,
    name: Option<String>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), ApiError> {
    let url = client.install_url().await?;
    let _ = tx.send(Msg::Lines(vec![Out::line(Tone::Link, url.clone())]));
    if url.starts_with("https://github.com/apps/")
        && !url.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    {
        open_browser(&url);
    }
    let (Some(owner), Some(name)) = (owner, name) else {
        return Ok(());
    };
    let _ = tx.send(Msg::Lines(vec![Out::line(
        Tone::Muted,
        format!("Waiting for GitHub to confirm the install on {owner}/{name}. esc cancels."),
    )]));
    let started = Instant::now();
    let deadline = started + Duration::from_secs(15 * 60);
    let mut hinted = false;
    loop {
        if *cancel.borrow() {
            return Ok(());
        }
        match client.install_status(&owner, &name).await {
            Ok((_, branch)) => {
                let _ = tx.send(Msg::Lines(vec![Out::line(
                    Tone::Success,
                    format!("Installed on {owner}/{name} ({branch})."),
                )]));
                return Ok(());
            }
            Err(error) if error.status == Some(404) => {}
            Err(error) => return Err(error),
        }
        if !hinted && started.elapsed() > Duration::from_secs(INSTALL_HINT_SECS) {
            hinted = true;
            let _ = tx.send(Msg::Lines(vec![still_waiting(client.origin())]));
        }
        if Instant::now() > deadline {
            return Err(ApiError {
                status: None,
                message: "Still waiting on the GitHub install.".into(),
            });
        }
        tokio::select! {
            _ = cancel.changed() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_secs(2)) => {}
        }
    }
}

async fn trigger(
    client: &Client,
    tx: &UnboundedSender<Msg>,
    repository_id: &str,
    source_sha: &str,
) -> Result<(), ApiError> {
    let created = client
        .create_run(repository_id, source_sha, &Uuid::new_v4().to_string())
        .await?;
    let verb = if created.created {
        "Queued"
    } else {
        "Already queued"
    };
    let _ = tx.send(Msg::Lines(vec![Out::line(
        format::status_tone(&created.run.status),
        format!("{verb} {}  {}", created.run.status, created.run.id),
    )]));
    Ok(())
}

/// `since`: drop what the feed replays from before this moment (unix ms).
async fn follow(
    client: Client,
    tx: UnboundedSender<Msg>,
    gen: u64,
    since: Option<i64>,
    cancel: &mut watch::Receiver<bool>,
) {
    let _ = tx.send(Msg::Watch(WatchNote::Up { gen }));
    let mut last_id = None;
    let mut delay = 1u64;
    let mut seen = VecDeque::new();
    loop {
        if *cancel.borrow() {
            let _ = tx.send(Msg::Watch(WatchNote::Down { gen, message: None }));
            return;
        }
        if !client.signed_in() {
            let _ = tx.send(Msg::Watch(WatchNote::Down {
                gen,
                message: Some(crate::api::NOT_SIGNED_IN.into()),
            }));
            return;
        }
        match client.open_activity(last_id.clone()).await {
            Ok(mut stream) => {
                delay = 1;
                let _ = tx.send(Msg::Watch(WatchNote::Up { gen }));
                let mut parser = SseParser::default();
                loop {
                    tokio::select! {
                        _ = cancel.changed() => {
                            let _ = tx.send(Msg::Watch(WatchNote::Down { gen, message: None }));
                            return;
                        }
                        chunk = stream.next() => {
                            match chunk {
                                Some(Ok(bytes)) => {
                                    for event in parser.push(&bytes) {
                                        if let Some(id) = &event.id {
                                            if seen.iter().any(|seen_id| seen_id == id) {
                                                continue;
                                            }
                                            seen.push_back(id.clone());
                                            if seen.len() > 2_000 {
                                                seen.pop_front();
                                            }
                                            last_id = Some(id.clone());
                                        }
                                        let old = since.zip(format::activity_ms(&event)).is_some_and(|(since, at)| at < since);
                                        if old {
                                            continue;
                                        }
                                        if let Some(line) = format::activity_line(&event) {
                                            let _ = tx.send(Msg::Watch(WatchNote::Event { gen, line }));
                                        }
                                    }
                                }
                                _ => break,
                            }
                        }
                    }
                }
            }
            // Msg::Rejected has said so, and reconnecting would only collect more 401s.
            Err(error) if error.status == Some(401) => {
                let _ = tx.send(Msg::Watch(WatchNote::Down { gen, message: None }));
                return;
            }
            Err(_) => {}
        }
        let _ = tx.send(Msg::Watch(WatchNote::Wait { gen, secs: delay }));
        tokio::select! {
            _ = cancel.changed() => {
                let _ = tx.send(Msg::Watch(WatchNote::Down { gen, message: None }));
                return;
            }
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
        }
        delay = (delay * 2).min(15);
    }
}

/// What to tell the user when the server did not take the mode, if anything.
async fn store_mode(client: &Client, auto: bool) -> Option<Out> {
    match client.put_settings(auto).await {
        Ok(_) => None,
        // 503: the API runs without Postgres, so no heal merges anything. 401: the
        // signed-out notice covers it.
        Err(error) if matches!(error.status, Some(401 | 503)) => None,
        Err(error) => Some(Out::line(
            Tone::Muted,
            format!("Could not save the mode on the server: {}", error.message),
        )),
    }
}

fn login_url(origin: &str, path: &str) -> Result<String, String> {
    let safe = path.starts_with("/auth/github/cli/begin?login=")
        && path.len() < 300
        && path
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '?' | '=' | '_' | '-'));
    if !safe {
        return Err("The sign-in URL from the API was not usable.".into());
    }
    Ok(format!("{origin}{path}"))
}

fn open_browser(url: &str) {
    let mut command = if cfg!(target_os = "macos") {
        let mut command = Process::new("open");
        command.arg(url);
        command
    } else if cfg!(target_os = "windows") {
        let mut command = Process::new("cmd");
        command.args(["/C", "start", "", url]);
        command
    } else {
        let mut command = Process::new("xdg-open");
        command.arg(url);
        command
    };
    let _ = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn();
}

#[cfg(test)]
mod live {
    use super::*;

    /// `OPENAI_API_KEY=… cargo test live -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn a_turn_runs_a_tool_and_answers() {
        let config = Config {
            model: crate::config::load_model(|name| std::env::var(name).ok(), || None),
            ..crate::config::load_from(None, Some("none"))
        };
        assert!(config.model.is_some(), "set OPENAI_API_KEY");
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut driver = Driver::new(&config, tx);
        driver.dispatch(Effect::Prompt {
            gen: 1,
            text: "Use the shell tool to run `echo adamant-$((40+2))`, then tell me exactly what it printed.".into(),
        });
        let mut reply = String::new();
        let mut tools = Vec::new();
        while let Some(msg) = rx.recv().await {
            let Msg::Agent { note, .. } = msg else {
                continue;
            };
            match note {
                AgentNote::Text(delta) => reply.push_str(&delta),
                AgentNote::Lines(lines) => tools.extend(lines.iter().map(Out::plain)),
                AgentNote::Error(error) => panic!("{error}"),
                AgentNote::Ask { .. } => panic!("auto mode asked"),
                AgentNote::Done => break,
            }
        }
        println!("tools: {tools:?}\nreply: {reply}");
        assert!(tools.iter().any(|line| line.starts_with("• Ran echo")));
        assert!(reply.contains("adamant-42"), "{reply}");
    }
}

#[cfg(test)]
mod feed {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn a_quiet_watch_shows_new_heal_events_only() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 2048];
            let _ = socket.read(&mut request).await;
            let old =
                r#"{"runId":"0ld00000-1","createdAt":"2020-01-01T00:00:00.000Z","payload":{}}"#;
            let new = format!(
                r#"{{"runId":"1a2b3c4d-1","createdAt":"{}","payload":{{"repository":"vaish/app","sourceSha":"abcdef1234"}}}}"#,
                "2999-01-01T00:00:00.000Z"
            );
            let body = format!(
                "id: audit_old\nevent: audit:run.failed\ndata: {old}\n\nid: wh_1\nevent: webhook:workflow_run\ndata: {{\"receivedAt\":\"2999-01-01T00:00:00.000Z\"}}\n\nid: audit_new\nevent: audit:run.queued\ndata: {new}\n\n"
            );
            let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n";
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(body.as_bytes()).await.unwrap();
            tokio::time::sleep(Duration::from_secs(5)).await;
        });

        let client = Client::new(origin, Some("token".into())).unwrap();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let (stop, mut cancel) = watch::channel(false);
        let since = Some(format::now_ms());
        tokio::spawn(async move { follow(client, tx, 1, since, &mut cancel).await });

        let mut shown = Vec::new();
        while shown.is_empty() {
            match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
                Ok(Some(Msg::Watch(WatchNote::Event { line, .. }))) => shown.push(line.plain()),
                Ok(Some(_)) => {}
                _ => break,
            }
        }
        let _ = stop.send(true);
        assert_eq!(
            shown,
            vec!["00:00  ● Heal 1a2b3c4d queued · vaish/app @ abcdef1"]
        );
    }
}

#[cfg(test)]
mod auth {
    use super::*;
    use crate::api::fake;
    use tokio::sync::mpsc::UnboundedReceiver;

    const UNAUTHORIZED: &str = r#"{"error":"Unauthorized"}"#;

    fn channel() -> (UnboundedSender<Msg>, UnboundedReceiver<Msg>) {
        tokio::sync::mpsc::unbounded_channel()
    }

    fn client(origin: String, token: Option<&str>, tx: &UnboundedSender<Msg>) -> Client {
        let tx = tx.clone();
        Client::new(origin, token.map(str::to_string))
            .unwrap()
            .when_rejected(move || {
                let _ = tx.send(Msg::Rejected);
            })
    }

    fn drain(rx: &mut UnboundedReceiver<Msg>) -> Vec<Msg> {
        let mut msgs = Vec::new();
        while let Ok(msg) = rx.try_recv() {
            msgs.push(msg);
        }
        msgs
    }

    fn texts(msgs: &[Msg]) -> Vec<String> {
        msgs.iter()
            .filter_map(|msg| match msg {
                Msg::Lines(lines) => Some(lines.iter().map(Out::plain).collect::<Vec<_>>()),
                _ => None,
            })
            .flatten()
            .collect()
    }

    fn scratch_session() -> PathBuf {
        let path = std::env::temp_dir()
            .join(format!("adamant-auth-{}", Uuid::new_v4()))
            .join("session");
        config::use_session_file_for_test(path.clone());
        path
    }

    #[tokio::test]
    async fn a_rejected_feed_stops_instead_of_reconnecting() {
        let (origin, seen) = fake::serve(vec![(401, UNAUTHORIZED), (401, UNAUTHORIZED)]).await;
        let (tx, mut rx) = channel();
        let client = client(origin, Some("tok-123"), &tx);
        let (_stop, mut cancel) = watch::channel(false);
        tokio::time::timeout(
            Duration::from_secs(3),
            follow(client.clone(), tx, 1, None, &mut cancel),
        )
        .await
        .expect("the feed kept retrying a rejected session");
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(!client.signed_in());
        let msgs = drain(&mut rx);
        assert_eq!(
            msgs.iter()
                .filter(|msg| matches!(msg, Msg::Rejected))
                .count(),
            1
        );
        // Msg::Rejected explains it; the feed adds nothing.
        assert!(msgs
            .iter()
            .any(|msg| matches!(msg, Msg::Watch(WatchNote::Down { message: None, .. }))));
    }

    #[tokio::test]
    async fn a_signed_out_feed_says_so_without_calling() {
        let (origin, seen) = fake::serve(vec![(200, "")]).await;
        let (tx, mut rx) = channel();
        let (_stop, mut cancel) = watch::channel(false);
        follow(client(origin, None, &tx), tx, 1, None, &mut cancel).await;
        assert!(seen.lock().unwrap().is_empty());
        assert!(drain(&mut rx).iter().any(|msg| matches!(
            msg,
            Msg::Watch(WatchNote::Down { message: Some(message), .. })
                if message == crate::api::NOT_SIGNED_IN
        )));
    }

    #[tokio::test]
    async fn only_unexpected_save_failures_are_shown() {
        let (origin, _) = fake::serve(vec![
            (200, r#"{"autoMerge":true}"#),
            (
                503,
                r#"{"error":"Settings need the hosted API with Postgres."}"#,
            ),
            (500, r#"{"error":"Failed to save settings"}"#),
            (401, UNAUTHORIZED),
        ])
        .await;
        let (tx, mut rx) = channel();
        let client = client(origin, Some("tok-123"), &tx);
        assert_eq!(store_mode(&client, true).await, None);
        assert_eq!(store_mode(&client, true).await, None);
        assert_eq!(
            store_mode(&client, false).await.map(|line| line.plain()),
            Some("Could not save the mode on the server: Failed to save settings".into())
        );
        assert_eq!(store_mode(&client, false).await, None);
        assert!(matches!(drain(&mut rx)[..], [Msg::Rejected]));
    }

    #[tokio::test]
    async fn mode_changes_reach_the_server_in_order() {
        let (origin, seen) = fake::serve(vec![
            (200, r#"{"autoMerge":false}"#),
            (200, r#"{"autoMerge":true}"#),
            (200, r#"{"autoMerge":false}"#),
        ])
        .await;
        let (tx, _rx) = channel();
        let config = Config {
            session: Some("tok-123".into()),
            ..config::load_from(Some(&origin), None)
        };
        let mut driver = Driver::new(&config, tx);
        for auto in [false, true, false] {
            driver.dispatch(Effect::Mode { auto, save: true });
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
        // Not saved: the app says when it is signed out.
        driver.dispatch(Effect::Mode {
            auto: true,
            save: false,
        });
        let deadline = Instant::now() + Duration::from_secs(3);
        while seen.lock().unwrap().len() < 3 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let bodies: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .map(|request| request.rsplit("\r\n").next().unwrap().to_string())
            .collect();
        // Quick switches may fold into fewer requests, but the last one always wins.
        assert!(!bodies.is_empty() && bodies.len() <= 3, "{bodies:?}");
        assert_eq!(bodies.last().unwrap(), r#"{"autoMerge":false}"#);
        // The unsaved switch still changes the mode here.
        assert!(driver.auto.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_save_that_keeps_failing_is_reported_once() {
        let broken = r#"{"error":"Failed to save settings"}"#;
        let (origin, seen) = fake::serve(vec![(500, broken), (500, broken), (500, broken)]).await;
        let (tx, mut rx) = channel();
        let config = Config {
            session: Some("tok-123".into()),
            ..config::load_from(Some(&origin), None)
        };
        let mut driver = Driver::new(&config, tx);
        for auto in [false, true, false] {
            driver.dispatch(Effect::Mode { auto, save: true });
            let deadline = Instant::now() + Duration::from_secs(3);
            let sent = seen.lock().unwrap().len();
            while seen.lock().unwrap().len() == sent && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(seen.lock().unwrap().len(), 3);
        assert_eq!(
            texts(&drain(&mut rx)),
            vec!["Could not save the mode on the server: Failed to save settings"]
        );
    }

    #[tokio::test]
    async fn logout_signs_out_here_when_the_api_already_revoked_it() {
        let path = scratch_session();
        config::store_session_at(&path, "tok-123").unwrap();
        let (origin, _) = fake::serve(vec![(401, UNAUTHORIZED)]).await;
        let (tx, mut rx) = channel();
        let client = client(origin, Some("tok-123"), &tx);
        logout(&client, &tx, 4).await.unwrap();
        assert!(!path.exists());
        assert!(!client.signed_in());
        let msgs = drain(&mut rx);
        assert!(!msgs.iter().any(|msg| matches!(msg, Msg::Rejected)));
        assert!(msgs.iter().any(|msg| matches!(
            msg,
            Msg::Session {
                epoch: 4,
                signed_in: false,
                ..
            }
        )));
        assert_eq!(texts(&msgs), vec!["Signed out."]);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn logout_signs_out_here_when_the_api_is_down() {
        let path = scratch_session();
        config::store_session_at(&path, "tok-123").unwrap();
        // Nothing listens here once the fake server has answered no one.
        let (origin, _) = fake::serve(vec![]).await;
        let (tx, mut rx) = channel();
        let client = client(origin, Some("tok-123"), &tx);
        logout(&client, &tx, 1).await.unwrap();
        assert!(!path.exists());
        let shown = texts(&drain(&mut rx));
        assert_eq!(shown[0], "Signed out.");
        assert!(
            shown[1].contains("stays valid on the server until it expires"),
            "{shown:?}"
        );
        assert!(shown.iter().all(|line| !line.contains("tok-123")));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn logout_without_an_api_still_deletes_the_file() {
        let path = scratch_session();
        config::store_session_at(&path, "tok-123").unwrap();
        let (tx, mut rx) = channel();
        let config = Config {
            session: Some("tok-123".into()),
            ..config::load_from(Some("not a url"), None)
        };
        let mut driver = Driver::new(&config, tx);
        driver.dispatch(Effect::Job(Job::Logout { epoch: 2 }));
        assert!(!path.exists());
        let msgs = drain(&mut rx);
        assert_eq!(texts(&msgs), vec!["Signed out."]);
        assert!(matches!(msgs.last(), Some(Msg::JobDone)));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn a_new_session_is_stored_privately_and_never_shown() {
        let path = scratch_session();
        let (origin, _) = fake::serve(vec![(
            200,
            r#"{"user":{"username":"vaish","email":null,"providers":["github"]}}"#,
        )])
        .await;
        let (tx, mut rx) = channel();
        let client = client(origin, None, &tx);
        signed_in(&client, &tx, 3, "tok-secret".into())
            .await
            .unwrap();
        assert_eq!(
            config::read_session_at(&path),
            Ok(Some("tok-secret".into()))
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        assert!(client.signed_in());
        let msgs = drain(&mut rx);
        assert!(msgs.iter().any(|msg| matches!(
            msg,
            Msg::Session {
                epoch: 3,
                signed_in: true,
                username: Some(name),
            } if name == "vaish"
        )));
        let shown = texts(&msgs);
        assert_eq!(shown[0], "Signed in as vaish.");
        assert!(shown.iter().all(|line| !line.contains("tok-secret")));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[tokio::test]
    async fn a_session_turned_down_at_once_is_not_stored() {
        let path = scratch_session();
        let (origin, _) = fake::serve(vec![(401, UNAUTHORIZED)]).await;
        let (tx, mut rx) = channel();
        let client = client(origin, None, &tx);
        let error = signed_in(&client, &tx, 3, "tok-secret".into())
            .await
            .unwrap_err();
        assert!(!error.message.contains("tok-secret"));
        assert!(!path.exists());
        assert!(!client.signed_in());
        assert!(!drain(&mut rx).iter().any(|msg| matches!(
            msg,
            Msg::Session {
                signed_in: true,
                ..
            }
        )));
    }

    #[tokio::test]
    async fn esc_during_sign_in_stores_nothing() {
        let path = scratch_session();
        let pending = r#"{"status":"pending"}"#;
        let (origin, _) = fake::serve(vec![(202, pending), (202, pending), (202, pending)]).await;
        let (tx, _rx) = channel();
        let client = client(origin, None, &tx);
        let (stop, mut cancel) = watch::channel(false);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let _ = stop.send(true);
        });
        let deadline = Instant::now() + Duration::from_secs(60);
        let waited = tokio::time::timeout(
            Duration::from_secs(3),
            wait_for_token(&client, "login", "secret", deadline, &mut cancel),
        )
        .await
        .expect("esc did not stop the sign-in");
        assert_eq!(waited.unwrap(), None);
        assert!(!path.exists());
        assert!(!client.signed_in());
    }

    #[test]
    fn sign_in_shows_the_code_before_the_link() {
        let url = "http://127.0.0.1:8787/auth/github/cli/begin?login=lid";
        let lines = login_prompt("WDJB-MJHT", url);
        assert_eq!(
            lines[0],
            Out::line(Tone::Accent, "Confirm the code WDJB-MJHT in your browser.")
        );
        let shown: Vec<String> = lines.iter().map(Out::plain).collect();
        assert!(shown.iter().any(|line| line.contains("esc cancels")));
        assert_eq!(shown.last().map(String::as_str), Some(url));
    }

    #[tokio::test]
    async fn a_browser_cancel_ends_the_wait_with_the_api_message() {
        let cancelled = r#"{"error":"Sign-in was cancelled or failed in the browser."}"#;
        let (origin, _) =
            fake::serve(vec![(202, r#"{"status":"pending"}"#), (403, cancelled)]).await;
        let (tx, _rx) = channel();
        let client = client(origin, None, &tx);
        let (_stop, mut cancel) = watch::channel(false);
        let deadline = Instant::now() + Duration::from_secs(60);
        let error = tokio::time::timeout(
            Duration::from_secs(5),
            wait_for_token(&client, "login", "secret", deadline, &mut cancel),
        )
        .await
        .expect("a cancelled sign-in kept polling")
        .unwrap_err();
        assert_eq!(error.status, Some(403));
        assert_eq!(
            error.message,
            "Sign-in was cancelled or failed in the browser."
        );
        assert!(!client.signed_in());
    }

    #[tokio::test]
    async fn a_sign_in_that_runs_out_of_time_says_so() {
        let (tx, _rx) = channel();
        let client = client("http://127.0.0.1:9".into(), None, &tx);
        let (_stop, mut cancel) = watch::channel(false);
        let past = Instant::now() - Duration::from_secs(1);
        let error = wait_for_token(&client, "login", "secret", past, &mut cancel)
            .await
            .unwrap_err();
        assert!(error.message.contains("timed out"), "{}", error.message);
    }
}
