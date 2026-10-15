use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::watch;
use uuid::Uuid;

use crate::api::Client;
use crate::command::{valid_id, valid_sha};
use crate::format::{self, Out, Tone};

const DEFAULT_TIMEOUT_MS: u64 = 120_000;
const MAX_TIMEOUT_MS: u64 = 600_000;
/// What a command may print before the rest is dropped unread.
const CAPTURE_BYTES: usize = 1_000_000;
/// Every later model call resends tool output, so it is cut to this.
const MODEL_CHARS: usize = 16_000;
const READ_LINES: usize = 2_000;
const LINE_CHARS: usize = 2_000;
const PREVIEW_LINES: usize = 4;
/// Variables this process holds for itself. A command the model writes never sees them.
const WITHHELD_ENV: &[&str] = &["OPENAI_API_KEY", "ADAMANT_SESSION"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow,
    /// Allow this and everything after it: the session switches to auto.
    AllowAll,
    Deny,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Approval {
    pub title: String,
    pub detail: Vec<String>,
}

/// One validated tool call. Anything the model asks for that is not here fails closed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Request {
    Shell {
        command: String,
        workdir: Option<String>,
        timeout_ms: u64,
    },
    Read {
        path: String,
        offset: usize,
        limit: usize,
    },
    Write {
        path: String,
        content: String,
    },
    Edit {
        path: String,
        old: String,
        new: String,
        all: bool,
    },
    Status,
    Runs,
    Run(String),
    Repos,
    Heal {
        repository_id: String,
        commit_sha: String,
    },
}

pub struct Outcome {
    /// What the model reads.
    pub output: String,
    /// What the transcript shows.
    pub lines: Vec<Out>,
}

pub struct Ctx<'a> {
    pub cwd: &'a Path,
    pub client: Option<&'a Client>,
}

pub fn definitions() -> Value {
    let function = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({
            "type": "function",
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
                "additionalProperties": false,
            },
        })
    };
    json!([
        function(
            "shell",
            "Run a command with bash -c on the user's machine. Use it to inspect the project, run builds and tests, use git, gh, and anything else. stdin is closed.",
            json!({
                "command": { "type": "string", "description": "The command line." },
                "workdir": { "type": "string", "description": "Directory to run in. Defaults to the working directory." },
                "timeout_ms": { "type": "integer", "description": "Kill the command after this long. Default 120000, at most 600000." },
            }),
            &["command"],
        ),
        function(
            "read_file",
            "Read a text file. Lines come back numbered.",
            json!({
                "path": { "type": "string" },
                "offset": { "type": "integer", "description": "First line, 1-based." },
                "limit": { "type": "integer", "description": "How many lines. Default 2000." },
            }),
            &["path"],
        ),
        function(
            "write_file",
            "Create or overwrite a file with this content. Parent directories are created.",
            json!({
                "path": { "type": "string" },
                "content": { "type": "string" },
            }),
            &["path", "content"],
        ),
        function(
            "edit_file",
            "Replace old_string with new_string in a file. old_string must match exactly and appear once, unless replace_all is true.",
            json!({
                "path": { "type": "string" },
                "old_string": { "type": "string" },
                "new_string": { "type": "string" },
                "replace_all": { "type": "boolean" },
            }),
            &["path", "old_string", "new_string"],
        ),
        function(
            "adamant_status",
            "Is the hosted Adamant API up, and who is signed in.",
            json!({}),
            &[],
        ),
        function(
            "adamant_runs",
            "List recent heal runs on the hosted Adamant API, newest first.",
            json!({}),
            &[],
        ),
        function(
            "adamant_run",
            "One heal run and its audit trail.",
            json!({ "run_id": { "type": "string" } }),
            &["run_id"],
        ),
        function(
            "adamant_repos",
            "Repositories the Adamant GitHub App is installed on, with the ids adamant_start_heal needs.",
            json!({}),
            &[],
        ),
        function(
            "adamant_start_heal",
            "Start a heal of a red commit. The hosted worker proves a fix in a sandbox, opens a PR on adamant/<run>, and merges it.",
            json!({
                "repository_id": { "type": "string", "description": "Id from adamant_repos." },
                "commit_sha": { "type": "string", "description": "Full 40-character SHA of the failing commit." },
            }),
            &["repository_id", "commit_sha"],
        ),
    ])
}

#[derive(Deserialize)]
struct ShellArgs {
    command: String,
    workdir: Option<String>,
    timeout_ms: Option<u64>,
}

#[derive(Deserialize)]
struct ReadArgs {
    path: String,
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct WriteArgs {
    path: String,
    content: String,
}

#[derive(Deserialize)]
struct EditArgs {
    path: String,
    old_string: String,
    new_string: String,
    replace_all: Option<bool>,
}

#[derive(Deserialize)]
struct RunArgs {
    run_id: String,
}

#[derive(Deserialize)]
struct HealArgs {
    repository_id: String,
    commit_sha: String,
}

impl Request {
    pub fn parse(name: &str, arguments: &str) -> Result<Self, String> {
        let raw = if arguments.trim().is_empty() {
            "{}"
        } else {
            arguments
        };
        fn args<T: for<'de> Deserialize<'de>>(raw: &str, name: &str) -> Result<T, String> {
            serde_json::from_str(raw).map_err(|error| format!("Bad arguments for {name}: {error}"))
        }
        let request = match name {
            "shell" => {
                let parsed: ShellArgs = args(raw, name)?;
                if parsed.command.trim().is_empty() {
                    return Err("shell needs a command.".into());
                }
                Request::Shell {
                    command: parsed.command,
                    workdir: parsed.workdir.filter(|dir| !dir.trim().is_empty()),
                    timeout_ms: parsed
                        .timeout_ms
                        .unwrap_or(DEFAULT_TIMEOUT_MS)
                        .clamp(1_000, MAX_TIMEOUT_MS),
                }
            }
            "read_file" => {
                let parsed: ReadArgs = args(raw, name)?;
                Request::Read {
                    path: parsed.path,
                    offset: parsed.offset.unwrap_or(1).max(1),
                    limit: parsed.limit.unwrap_or(READ_LINES).clamp(1, READ_LINES),
                }
            }
            "write_file" => {
                let parsed: WriteArgs = args(raw, name)?;
                Request::Write {
                    path: parsed.path,
                    content: parsed.content,
                }
            }
            "edit_file" => {
                let parsed: EditArgs = args(raw, name)?;
                if parsed.old_string.is_empty() {
                    return Err(
                        "edit_file needs a non-empty old_string. Use write_file to create a file."
                            .into(),
                    );
                }
                Request::Edit {
                    path: parsed.path,
                    old: parsed.old_string,
                    new: parsed.new_string,
                    all: parsed.replace_all.unwrap_or(false),
                }
            }
            "adamant_status" => Request::Status,
            "adamant_runs" => Request::Runs,
            "adamant_run" => {
                let parsed: RunArgs = args(raw, name)?;
                if !valid_id(&parsed.run_id) {
                    return Err("run_id is not a run id.".into());
                }
                Request::Run(parsed.run_id)
            }
            "adamant_repos" => Request::Repos,
            "adamant_start_heal" => {
                let parsed: HealArgs = args(raw, name)?;
                if !valid_id(&parsed.repository_id) {
                    return Err("repository_id is not a repository id from adamant_repos.".into());
                }
                if !valid_sha(&parsed.commit_sha) {
                    return Err("commit_sha must be a full commit SHA.".into());
                }
                Request::Heal {
                    repository_id: parsed.repository_id,
                    commit_sha: parsed.commit_sha.to_ascii_lowercase(),
                }
            }
            other => {
                return Err(format!(
                    "Unknown tool {other}. Only the listed tools exist."
                ))
            }
        };
        Ok(request)
    }

    /// Manual mode asks before anything that changes the machine or starts a heal.
    pub fn needs_approval(&self) -> bool {
        matches!(
            self,
            Request::Shell { .. }
                | Request::Write { .. }
                | Request::Edit { .. }
                | Request::Heal { .. }
        )
    }

    pub fn approval(&self, cwd: &Path) -> Approval {
        match self {
            Request::Shell {
                command, workdir, ..
            } => {
                let mut detail: Vec<String> = command.lines().take(8).map(str::to_string).collect();
                if let Some(dir) = workdir {
                    detail.push(format!("in {dir}"));
                }
                Approval {
                    title: "Run this command?".into(),
                    detail,
                }
            }
            Request::Write { path, content } => Approval {
                title: "Write this file?".into(),
                detail: vec![
                    shown(cwd, path),
                    format!("{} lines", content.lines().count()),
                ],
            },
            Request::Edit { path, old, new, .. } => Approval {
                title: "Edit this file?".into(),
                detail: vec![
                    shown(cwd, path),
                    format!("- {}", format::brief(old.lines().next().unwrap_or(""), 70)),
                    format!("+ {}", format::brief(new.lines().next().unwrap_or(""), 70)),
                ],
            },
            Request::Heal {
                repository_id,
                commit_sha,
            } => Approval {
                title: "Start a heal?".into(),
                detail: vec![
                    format!("repository {repository_id}"),
                    format!("commit     {commit_sha}"),
                    "It opens a PR on adamant/<run> and merges it after a passing sandbox.".into(),
                ],
            },
            other => Approval {
                title: "Allow this?".into(),
                detail: vec![format!("{other:?}")],
            },
        }
    }

    pub async fn run(self, ctx: &Ctx<'_>, cancel: &mut watch::Receiver<bool>) -> Outcome {
        match self {
            Request::Shell {
                command,
                workdir,
                timeout_ms,
            } => {
                let dir = match &workdir {
                    Some(dir) => resolve(ctx.cwd, dir),
                    None => ctx.cwd.to_path_buf(),
                };
                shell(&command, &dir, Duration::from_millis(timeout_ms), cancel).await
            }
            Request::Read {
                path,
                offset,
                limit,
            } => read(ctx.cwd, &path, offset, limit).await,
            Request::Write { path, content } => write(ctx.cwd, &path, &content).await,
            Request::Edit {
                path,
                old,
                new,
                all,
            } => edit(ctx.cwd, &path, &old, &new, all).await,
            Request::Status
            | Request::Runs
            | Request::Run(_)
            | Request::Repos
            | Request::Heal { .. } => match ctx.client {
                Some(client) => adamant(self, client).await,
                None => failed(
                    "The Adamant API is not configured. Check ADAMANT_API_URL.",
                    "• Adamant API not configured",
                ),
            },
        }
    }
}

fn failed(output: impl Into<String>, line: impl Into<String>) -> Outcome {
    Outcome {
        output: format!("error: {}", output.into()),
        lines: vec![Out::line(Tone::Error, line)],
    }
}

/// Adamant's own credentials. What the file tools read goes to the model, and these
/// must not: the session signs API calls and the key bills the user's OpenAI account.
const CREDENTIAL_FILES: &[&str] = &["session", "openai_key"];

fn is_credential(full: &Path) -> bool {
    std::env::var_os("HOME").is_some_and(|home| is_credential_in(full, Path::new(&home)))
}

/// Compared after resolving links and `..`, so neither reaches the file another way.
fn is_credential_in(full: &Path, home: &Path) -> bool {
    let target = canonical(full);
    let dir = home.join(".adamant");
    CREDENTIAL_FILES
        .iter()
        .any(|name| canonical(&dir.join(name)) == target)
}

/// The real path, or for a file not yet written, its real directory plus its name.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => std::fs::canonicalize(parent)
            .map(|parent| parent.join(name))
            .unwrap_or_else(|_| path.to_path_buf()),
        _ => path.to_path_buf(),
    })
}

fn refused(name: &str, verb: &str) -> Outcome {
    failed(
        format!("{name} holds Adamant's credentials; the agent does not read or change it."),
        format!("• {verb} {name} (refused)"),
    )
}

fn resolve(cwd: &Path, path: &str) -> PathBuf {
    let expanded = match path.strip_prefix("~/") {
        Some(rest) => std::env::var_os("HOME")
            .map(|home| PathBuf::from(home).join(rest))
            .unwrap_or_else(|| PathBuf::from(path)),
        None => PathBuf::from(path),
    };
    if expanded.is_absolute() {
        expanded
    } else {
        cwd.join(expanded)
    }
}

/// The path as the user would type it: relative inside the working directory.
fn shown(cwd: &Path, path: &str) -> String {
    let full = resolve(cwd, path);
    full.strip_prefix(cwd)
        .map(|rest| rest.display().to_string())
        .unwrap_or_else(|_| full.display().to_string())
}

async fn shell(
    command: &str,
    dir: &Path,
    timeout: Duration,
    cancel: &mut watch::Receiver<bool>,
) -> Outcome {
    let title = format!("• Ran {}", format::brief(&one_line(command), 100));
    let mut process = tokio::process::Command::new(if Path::new("/bin/bash").exists() {
        "/bin/bash"
    } else {
        "/bin/sh"
    });
    process
        .arg("-c")
        .arg(command)
        .current_dir(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for name in WITHHELD_ENV {
        process.env_remove(name);
    }
    // Its own process group, so a timeout or esc stops what the command started too.
    #[cfg(unix)]
    process.process_group(0);
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => {
            return failed(
                format!("could not start the command in {}: {error}", dir.display()),
                format!("{title} (did not start)"),
            )
        }
    };
    let pid = child.id();
    let stdout = child.stdout.take().map(|out| tokio::spawn(drain(out)));
    let stderr = child.stderr.take().map(|err| tokio::spawn(drain(err)));

    let mut stopped = None;
    let status = tokio::select! {
        status = child.wait() => status.ok(),
        _ = tokio::time::sleep(timeout) => {
            stopped = Some(format!("timed out after {}s", timeout.as_secs()));
            None
        }
        _ = cancel.changed() => {
            stopped = Some("interrupted by the user".into());
            None
        }
    };
    if stopped.is_some() {
        kill_group(pid);
        let _ = child.kill().await;
    }
    let out = collect(stdout).await;
    let err = collect(stderr).await;

    let code = status.and_then(|status| status.code());
    let mut output = match (&stopped, code) {
        (Some(reason), _) => format!("{reason}\n"),
        (None, Some(code)) => format!("exit code: {code}\n"),
        (None, None) => "killed by a signal\n".to_string(),
    };
    output.push_str(&out);
    if !err.trim().is_empty() {
        if !out.is_empty() && !out.ends_with('\n') {
            output.push('\n');
        }
        output.push_str("[stderr]\n");
        output.push_str(&err);
    }

    let ok = stopped.is_none() && code == Some(0);
    let head = match (&stopped, code) {
        (Some(reason), _) => format!("{title} ({reason})"),
        (None, Some(0)) => title,
        (None, Some(code)) => format!("{title} (exit {code})"),
        (None, None) => format!("{title} (killed)"),
    };
    let mut lines = vec![Out::line(if ok { Tone::Normal } else { Tone::Error }, head)];
    lines.extend(preview(&format!("{out}{err}")));
    Outcome {
        output: clip(&output),
        lines,
    }
}

#[cfg(unix)]
fn kill_group(pid: Option<u32>) {
    if let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) {
        // SAFETY: killpg only sends a signal; the group id is the child we spawned.
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
    }
}

#[cfg(not(unix))]
fn kill_group(_pid: Option<u32>) {}

/// Reads to the end so the command never blocks on a full pipe, keeping the first part.
async fn drain(mut reader: impl AsyncRead + Unpin) -> Vec<u8> {
    let mut kept = Vec::new();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let room = CAPTURE_BYTES.saturating_sub(kept.len());
                kept.extend_from_slice(&buf[..read.min(room)]);
            }
        }
    }
    kept
}

/// A background process that inherited the pipe can hold it open; do not wait on it forever.
async fn collect(handle: Option<tokio::task::JoinHandle<Vec<u8>>>) -> String {
    let Some(handle) = handle else {
        return String::new();
    };
    match tokio::time::timeout(Duration::from_secs(2), handle).await {
        Ok(Ok(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
        _ => String::new(),
    }
}

fn preview(text: &str) -> Vec<Out> {
    let rows: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let mut lines = Vec::new();
    for (index, row) in rows.iter().take(PREVIEW_LINES).enumerate() {
        let lead = if index == 0 { "  └ " } else { "    " };
        lines.push(Out::line(
            Tone::Muted,
            format!("{lead}{}", format::brief(row, 160)),
        ));
    }
    if rows.len() > PREVIEW_LINES {
        lines.push(Out::line(
            Tone::Muted,
            format!("    … +{} lines", rows.len() - PREVIEW_LINES),
        ));
    }
    lines
}

/// Head and tail: the end of a build log is where the error is.
fn clip(text: &str) -> String {
    let count = text.chars().count();
    if count <= MODEL_CHARS {
        return text.to_string();
    }
    let half = MODEL_CHARS / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text.chars().skip(count - half).collect();
    format!(
        "{head}\n… {} characters omitted …\n{tail}",
        count - MODEL_CHARS
    )
}

fn one_line(text: &str) -> String {
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let first = lines.next().unwrap_or("").trim().to_string();
    if lines.next().is_some() {
        format!("{first} …")
    } else {
        first
    }
}

async fn read(cwd: &Path, path: &str, offset: usize, limit: usize) -> Outcome {
    let full = resolve(cwd, path);
    let name = shown(cwd, path);
    if is_credential(&full) {
        return refused(&name, "Read");
    }
    let bytes = match tokio::fs::read(&full).await {
        Ok(bytes) => bytes,
        Err(error) => {
            return failed(
                format!("could not read {name}: {error}"),
                format!("• Read {name} (failed)"),
            )
        }
    };
    let text = String::from_utf8_lossy(&bytes);
    let total = text.lines().count();
    let mut output = String::new();
    for (index, line) in text.lines().enumerate().skip(offset - 1).take(limit) {
        let line: String = line.chars().take(LINE_CHARS).collect();
        output.push_str(&format!("{:>6}\t{line}\n", index + 1));
    }
    let end = (offset - 1 + limit).min(total);
    if end < total {
        output.push_str(&format!(
            "… {} more lines. Read again with offset {}.\n",
            total - end,
            end + 1
        ));
    }
    if total == 0 {
        output.push_str("(empty file)\n");
    }
    Outcome {
        output: clip(&output),
        lines: vec![Out::line(Tone::Normal, format!("• Read {name}"))],
    }
}

async fn write(cwd: &Path, path: &str, content: &str) -> Outcome {
    let full = resolve(cwd, path);
    let name = shown(cwd, path);
    if is_credential(&full) {
        return refused(&name, "Wrote");
    }
    if let Some(parent) = full.parent() {
        if let Err(error) = tokio::fs::create_dir_all(parent).await {
            return failed(
                format!("could not create {}: {error}", parent.display()),
                format!("• Wrote {name} (failed)"),
            );
        }
    }
    match tokio::fs::write(&full, content).await {
        Ok(()) => Outcome {
            output: format!("Wrote {} bytes to {name}.", content.len()),
            lines: vec![Out::line(
                Tone::Normal,
                format!("• Wrote {name} ({} lines)", content.lines().count()),
            )],
        },
        Err(error) => failed(
            format!("could not write {name}: {error}"),
            format!("• Wrote {name} (failed)"),
        ),
    }
}

async fn edit(cwd: &Path, path: &str, old: &str, new: &str, all: bool) -> Outcome {
    let full = resolve(cwd, path);
    let name = shown(cwd, path);
    if is_credential(&full) {
        return refused(&name, "Edited");
    }
    let text = match tokio::fs::read_to_string(&full).await {
        Ok(text) => text,
        Err(error) => {
            return failed(
                format!("could not read {name}: {error}"),
                format!("• Edited {name} (failed)"),
            )
        }
    };
    let found = text.matches(old).count();
    if found == 0 {
        return failed(
            format!("old_string is not in {name}. Read the file and copy the text exactly."),
            format!("• Edited {name} (no match)"),
        );
    }
    if found > 1 && !all {
        return failed(
            format!("old_string appears {found} times in {name}. Add surrounding lines, or set replace_all."),
            format!("• Edited {name} (ambiguous)"),
        );
    }
    let updated = if all {
        text.replace(old, new)
    } else {
        text.replacen(old, new, 1)
    };
    if let Err(error) = tokio::fs::write(&full, &updated).await {
        return failed(
            format!("could not write {name}: {error}"),
            format!("• Edited {name} (failed)"),
        );
    }
    let times = if all { found } else { 1 };
    Outcome {
        output: format!("Edited {name}: replaced {times} occurrence(s)."),
        lines: vec![Out::line(
            Tone::Normal,
            format!(
                "• Edited {name} (+{} -{})",
                new.lines().count() * times,
                old.lines().count() * times
            ),
        )],
    }
}

async fn adamant(request: Request, client: &Client) -> Outcome {
    match request {
        Request::Status => {
            if let Err(error) = client.health().await {
                return failed(error.message, "• Adamant API unreachable");
            }
            let user = client.me().await.ok().map(|user| user.username);
            let line = match &user {
                Some(name) => format!("• Checked Adamant: up, signed in as {name}"),
                None => "• Checked Adamant: up, signed out".into(),
            };
            Outcome {
                output: json!({ "api": client.origin(), "up": true, "user": user }).to_string(),
                lines: vec![Out::line(Tone::Normal, line)],
            }
        }
        Request::Runs => match client.list_runs().await {
            Ok(runs) => {
                let listed: Vec<Value> = runs
                    .iter()
                    .take(30)
                    .map(|run| {
                        json!({
                            "id": run.id, "status": run.status, "repositoryId": run.repository_id,
                            "sourceSha": run.source_sha, "branch": run.target_branch,
                            "updatedAt": run.updated_at,
                        })
                    })
                    .collect();
                Outcome {
                    output: Value::Array(listed).to_string(),
                    lines: vec![Out::line(
                        Tone::Normal,
                        format!("• Listed runs ({})", runs.len()),
                    )],
                }
            }
            Err(error) => failed(error.message, "• Listed runs (failed)"),
        },
        Request::Run(id) => match client.get_run(&id).await {
            Ok(detail) => {
                let events: Vec<Value> = detail
                    .audit_events
                    .iter()
                    .map(|event| json!({ "type": event.event_type, "at": event.created_at }))
                    .collect();
                let run = &detail.run;
                Outcome {
                    output: json!({
                        "id": run.id, "status": run.status, "repositoryId": run.repository_id,
                        "sourceSha": run.source_sha, "branch": run.target_branch,
                        "createdAt": run.created_at, "updatedAt": run.updated_at, "audit": events,
                    })
                    .to_string(),
                    lines: vec![Out::line(
                        Tone::Normal,
                        format!("• Opened run {}", format::short_id(&id)),
                    )],
                }
            }
            Err(error) => failed(error.message, "• Opened run (failed)"),
        },
        Request::Repos => match client.list_repos().await {
            Ok(repos) => {
                let listed: Vec<Value> = repos
                    .iter()
                    .map(|repo| {
                        json!({
                            "id": repo.id, "owner": repo.owner, "name": repo.name,
                            "defaultBranch": repo.default_branch,
                        })
                    })
                    .collect();
                Outcome {
                    output: Value::Array(listed).to_string(),
                    lines: vec![Out::line(
                        Tone::Normal,
                        format!("• Listed installed repositories ({})", repos.len()),
                    )],
                }
            }
            Err(error) => failed(error.message, "• Listed repositories (failed)"),
        },
        Request::Heal {
            repository_id,
            commit_sha,
        } => match client
            .create_run(&repository_id, &commit_sha, &Uuid::new_v4().to_string())
            .await
        {
            Ok(created) => Outcome {
                output: json!({
                    "runId": created.run.id, "status": created.run.status, "created": created.created,
                })
                .to_string(),
                lines: vec![Out::line(
                    Tone::Success,
                    format!(
                        "• Started a heal: run {} {}",
                        format::short_id(&created.run.id),
                        created.run.status
                    ),
                )],
            },
            Err(error) => failed(error.message, "• Start a heal (failed)"),
        },
        _ => failed("not an Adamant request", "• Unknown request"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_tools_fail_closed() {
        assert!(Request::parse("rm_rf", "{}").is_err());
        assert!(Request::parse(
            "adamant_start_heal",
            r#"{"repository_id":"x y","commit_sha":"abc"}"#
        )
        .is_err());
        assert!(Request::parse("shell", r#"{"command":"  "}"#).is_err());
    }

    #[test]
    fn manual_mode_gates_changes_only() {
        let shell = Request::parse("shell", r#"{"command":"ls"}"#).unwrap();
        assert!(shell.needs_approval());
        assert!(!Request::parse("read_file", r#"{"path":"a"}"#)
            .unwrap()
            .needs_approval());
        assert!(!Request::parse("adamant_runs", "").unwrap().needs_approval());
        let heal = Request::parse(
            "adamant_start_heal",
            &format!(
                r#"{{"repository_id":"abc-123","commit_sha":"{}"}}"#,
                "a".repeat(40)
            ),
        )
        .unwrap();
        assert!(heal.needs_approval());
    }

    #[test]
    fn clips_the_middle_of_long_output() {
        let long = format!("{}{}", "a".repeat(MODEL_CHARS), "z".repeat(100));
        let clipped = clip(&long);
        assert!(clipped.starts_with('a'));
        assert!(clipped.ends_with('z'));
        assert!(clipped.contains("characters omitted"));
    }

    #[tokio::test]
    async fn runs_a_command_and_edits_a_file() {
        let dir = std::env::temp_dir().join(format!("adamant-tools-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let ctx = Ctx {
            cwd: &dir,
            client: None,
        };
        let (_tx, mut cancel) = watch::channel(false);

        let ran = Request::parse("shell", r#"{"command":"echo hi; echo oops >&2; exit 3"}"#)
            .unwrap()
            .run(&ctx, &mut cancel)
            .await;
        assert!(ran.output.starts_with("exit code: 3"), "{}", ran.output);
        assert!(ran.output.contains("hi") && ran.output.contains("[stderr]\noops"));

        Request::parse("write_file", r#"{"path":"a/b.txt","content":"one\ntwo\n"}"#)
            .unwrap()
            .run(&ctx, &mut cancel)
            .await;
        let edited = Request::parse(
            "edit_file",
            r#"{"path":"a/b.txt","old_string":"two","new_string":"three"}"#,
        )
        .unwrap()
        .run(&ctx, &mut cancel)
        .await;
        assert!(edited.output.starts_with("Edited"), "{}", edited.output);
        assert_eq!(
            std::fs::read_to_string(dir.join("a/b.txt")).unwrap(),
            "one\nthree\n"
        );
        let read = Request::parse("read_file", r#"{"path":"a/b.txt"}"#)
            .unwrap()
            .run(&ctx, &mut cancel)
            .await;
        assert!(read.output.contains("     2\tthree"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn withholds_the_model_key_from_commands() {
        std::env::set_var("OPENAI_API_KEY", "sk-secret");
        let dir = std::env::temp_dir();
        let ctx = Ctx {
            cwd: &dir,
            client: None,
        };
        let (_tx, mut cancel) = watch::channel(false);
        let ran = Request::parse("shell", r#"{"command":"echo ${OPENAI_API_KEY:-unset}"}"#)
            .unwrap()
            .run(&ctx, &mut cancel)
            .await;
        assert!(ran.output.contains("unset"), "{}", ran.output);
    }
}

#[cfg(test)]
mod credentials {
    use super::*;

    #[test]
    fn the_session_and_key_are_off_limits_by_any_path() {
        let home = std::env::temp_dir().join(format!("adamant-cred-{}", std::process::id()));
        let dir = home.join(".adamant");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("session"), "token").unwrap();
        let project = home.join("project");
        std::fs::create_dir_all(&project).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(dir.join("session"), project.join("innocent.txt")).unwrap();

        assert!(is_credential_in(&dir.join("session"), &home));
        // Not written yet, still refused: the agent cannot plant a key either.
        assert!(is_credential_in(&dir.join("openai_key"), &home));
        assert!(is_credential_in(
            &project.join("../.adamant/session"),
            &home
        ));
        #[cfg(unix)]
        assert!(is_credential_in(&project.join("innocent.txt"), &home));
        assert!(!is_credential_in(&project.join("session"), &home));
        assert!(!is_credential_in(&dir.join("notes"), &home));
        std::fs::remove_dir_all(&home).unwrap();
    }
}
