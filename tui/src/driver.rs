use std::collections::VecDeque;
use std::process::Command as Process;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tokio::sync::{mpsc::UnboundedSender, watch};
use uuid::Uuid;

use crate::api::{Client, LoginPoll, SseParser};
use crate::app::{Effect, Job, Msg, WatchNote};
use crate::config::{self, Config};
use crate::format::{self, Out, Tone};

pub struct Driver {
    client: Option<Client>,
    tx: UnboundedSender<Msg>,
    job: Option<watch::Sender<bool>>,
    feed: Option<watch::Sender<bool>>,
}

impl Driver {
    pub fn new(config: &Config, tx: UnboundedSender<Msg>) -> Self {
        let client = config
            .origin
            .clone()
            .and_then(|origin| Client::new(origin, config.session.clone()).ok());
        Self {
            client,
            tx,
            job: None,
            feed: None,
        }
    }

    pub fn dispatch(&mut self, effect: Effect) {
        match effect {
            Effect::None | Effect::Quit => {}
            Effect::Cancel => self.cancel_all(),
            Effect::Health => self.spawn_health(),
            Effect::Me { epoch } => self.spawn_me(epoch),
            Effect::Watch { gen } => self.spawn_watch(gen),
            Effect::LoadRuns { epoch } => self.spawn_list(true, epoch),
            Effect::Job {
                epoch,
                job: Job::Runs,
            } => self.spawn_list(false, epoch),
            Effect::Job { epoch, job } => self.spawn_job(job, epoch),
        }
    }

    fn cancel_all(&mut self) {
        self.stop_job();
        self.stop_feed();
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

    fn spawn_list(&mut self, quiet: bool, epoch: u64) {
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
                Err(error) => {
                    note_auth(&client, &error, epoch, &tx);
                    let _ = tx.send(Msg::Runs(Err(error.message)));
                }
            }
        });
    }

    fn spawn_job(&mut self, job: Job, epoch: u64) {
        let Some(client) = self.client.clone() else {
            let _ = self.tx.send(Msg::Lines(vec![Out::line(
                Tone::Error,
                "The API client is not available.",
            )]));
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
                if !*cancel.borrow() {
                    note_auth(&client, &error, epoch, &tx);
                    let _ = tx.send(Msg::Lines(vec![Out::line(Tone::Error, error.message)]));
                }
            }
        });
    }

    fn spawn_watch(&mut self, gen: u64) {
        let Some(client) = self.client.clone() else {
            let _ = self.tx.send(Msg::Watch(WatchNote::Down {
                gen,
                message: Some("The API client is not available.".into()),
                unauthorized: false,
            }));
            return;
        };
        self.stop_feed();
        let (sender, mut cancel) = watch::channel(false);
        self.feed = Some(sender);
        let tx = self.tx.clone();
        tokio::spawn(async move {
            follow(client, tx, gen, &mut cancel).await;
        });
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
) -> Result<(), crate::api::ApiError> {
    match job {
        Job::Status { epoch } => status(client, tx, epoch).await,
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
        Job::Repos => repos(client, tx).await,
        Job::Install { owner, name } => install(client, tx, owner, name, cancel).await,
        Job::Trigger {
            repository_id,
            source_sha,
        } => trigger(client, tx, &repository_id, &source_sha).await,
        Job::Runs => Ok(()),
    }
}

async fn status(
    client: &Client,
    tx: &UnboundedSender<Msg>,
    epoch: u64,
) -> Result<(), crate::api::ApiError> {
    client.health().await?;
    let _ = tx.send(Msg::Health(Ok(())));
    let mut lines = vec![Out::line(
        Tone::Success,
        format!("api  {}  ok", client.origin()),
    )];
    match client.me().await {
        Ok(user) => lines.extend(format::format_user(&user)),
        Err(error) if error.status == Some(401) => {
            client.set_session(None);
            let _ = tx.send(Msg::Session {
                epoch,
                signed_in: false,
                username: None,
            });
            lines.push(Out::line(Tone::Muted, "session  signed out"));
        }
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
) -> Result<(), crate::api::ApiError> {
    let (path, login_id, poll_secret) = client.start_login().await?;
    let url = login_url(client.origin(), &path).map_err(|message| crate::api::ApiError {
        status: None,
        message,
    })?;
    let _ = tx.send(Msg::Lines(vec![
        Out::line(Tone::Normal, "Waiting for GitHub. esc cancels."),
        Out::line(Tone::Link, url.clone()),
    ]));
    open_browser(&url);
    let deadline = Instant::now() + Duration::from_secs(15 * 60);
    loop {
        if *cancel.borrow() || Instant::now() > deadline {
            return Ok(());
        }
        match client.poll_login(&login_id, &poll_secret).await? {
            LoginPoll::Pending => {}
            LoginPoll::Token(token) => {
                client.set_session(Some(token.clone()));
                if let Err(error) = config::store_session(&token) {
                    let _ = tx.send(Msg::Lines(vec![Out::line(Tone::Muted, error)]));
                }
                let username = client.me().await.ok().map(|user| user.username);
                let line = match &username {
                    Some(name) => format!("Signed in as {name}."),
                    None => "Signed in.".into(),
                };
                let _ = tx.send(Msg::Session {
                    epoch,
                    signed_in: true,
                    username,
                });
                let _ = tx.send(Msg::Lines(vec![Out::line(Tone::Success, line)]));
                return Ok(());
            }
        }
        tokio::select! {
            _ = cancel.changed() => return Ok(()),
            _ = tokio::time::sleep(Duration::from_secs(1)) => {}
        }
    }
}

async fn logout(
    client: &Client,
    tx: &UnboundedSender<Msg>,
    epoch: u64,
) -> Result<(), crate::api::ApiError> {
    client.logout().await?;
    client.set_session(None);
    config::clear_session_file();
    let _ = tx.send(Msg::Session {
        epoch,
        signed_in: false,
        username: None,
    });
    let _ = tx.send(Msg::Lines(vec![Out::line(Tone::Muted, "Signed out.")]));
    Ok(())
}

async fn repos(client: &Client, tx: &UnboundedSender<Msg>) -> Result<(), crate::api::ApiError> {
    let repos = client.list_repos().await?;
    let lines = if repos.is_empty() {
        vec![Out::line(Tone::Muted, "No installed repositories.")]
    } else {
        repos
            .into_iter()
            .map(|repo| {
                Out::line(
                    Tone::Normal,
                    format!("{}/{}  {}", repo.owner, repo.name, repo.default_branch),
                )
            })
            .collect()
    };
    let _ = tx.send(Msg::Lines(lines));
    Ok(())
}

async fn install(
    client: &Client,
    tx: &UnboundedSender<Msg>,
    owner: Option<String>,
    name: Option<String>,
    cancel: &mut watch::Receiver<bool>,
) -> Result<(), crate::api::ApiError> {
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
        format!("Waiting for {owner}/{name}. esc cancels."),
    )]));
    let deadline = Instant::now() + Duration::from_secs(15 * 60);
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
        if Instant::now() > deadline {
            return Err(crate::api::ApiError {
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
) -> Result<(), crate::api::ApiError> {
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

async fn follow(
    client: Client,
    tx: UnboundedSender<Msg>,
    gen: u64,
    cancel: &mut watch::Receiver<bool>,
) {
    let _ = tx.send(Msg::Watch(WatchNote::Up { gen }));
    let mut last_id = None;
    let mut delay = 1u64;
    let mut seen = VecDeque::new();
    loop {
        if *cancel.borrow() {
            let _ = tx.send(Msg::Watch(WatchNote::Down {
                gen,
                message: None,
                unauthorized: false,
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
                            let _ = tx.send(Msg::Watch(WatchNote::Down { gen, message: None, unauthorized: false }));
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
                                        let _ = tx.send(Msg::Watch(WatchNote::Event { gen, text: format::format_activity(&event) }));
                                    }
                                }
                                _ => break,
                            }
                        }
                    }
                }
            }
            Err(error) if error.status == Some(401) => {
                client.set_session(None);
                let _ = tx.send(Msg::Watch(WatchNote::Down {
                    gen,
                    message: Some(error.message),
                    unauthorized: true,
                }));
                return;
            }
            Err(_) => {}
        }
        let _ = tx.send(Msg::Watch(WatchNote::Wait { gen, secs: delay }));
        tokio::select! {
            _ = cancel.changed() => {
                let _ = tx.send(Msg::Watch(WatchNote::Down { gen, message: None, unauthorized: false }));
                return;
            }
            _ = tokio::time::sleep(Duration::from_secs(delay)) => {}
        }
        delay = (delay * 2).min(15);
    }
}

fn note_auth(client: &Client, error: &crate::api::ApiError, epoch: u64, tx: &UnboundedSender<Msg>) {
    if error.status == Some(401) {
        client.set_session(None);
        let _ = tx.send(Msg::Session {
            epoch,
            signed_in: false,
            username: None,
        });
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
