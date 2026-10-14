use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::Stream;
use reqwest::header::AUTHORIZATION;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;

const TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    live: reqwest::Client,
    origin: String,
    session: Arc<Mutex<Option<String>>>,
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: Option<u16>,
    pub message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub username: String,
    pub email: Option<String>,
    pub providers: Vec<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub repository_id: String,
    pub source_sha: String,
    pub target_branch: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub event_type: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: RunSummary,
    pub audit_events: Vec<AuditEvent>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub owner: String,
    pub name: String,
    pub default_branch: String,
}

#[derive(Clone, Debug)]
pub struct CreatedRun {
    pub run: RunSummary,
    pub created: bool,
}

#[derive(Clone, Debug)]
pub enum LoginPoll {
    Pending,
    Token(String),
}

#[derive(Debug)]
struct LoginStart {
    begin_path: String,
    login_id: String,
    poll_secret: String,
}

pub type ByteStream = Pin<Box<dyn Stream<Item = Result<bytes::Bytes, reqwest::Error>> + Send>>;

#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseEvent {
    pub id: Option<String>,
    pub event: Option<String>,
    pub data: String,
}

impl Client {
    pub fn new(origin: String, session: Option<String>) -> Result<Self, ApiError> {
        let http = reqwest::Client::builder()
            .connect_timeout(TIMEOUT)
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(4))
            .user_agent(concat!("adamant/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ApiError {
                status: None,
                message: "Could not build the HTTP client.".into(),
            })?;
        let live = reqwest::Client::builder()
            .connect_timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(4))
            .user_agent(concat!("adamant/", env!("CARGO_PKG_VERSION")))
            .build()
            .map_err(|_| ApiError {
                status: None,
                message: "Could not build the HTTP client.".into(),
            })?;
        Ok(Self {
            http,
            live,
            origin,
            session: Arc::new(Mutex::new(session)),
        })
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn set_session(&self, token: Option<String>) {
        if let Ok(mut guard) = self.session.lock() {
            *guard = token;
        }
    }

    pub async fn health(&self) -> Result<(), ApiError> {
        let value = self.get_json("/health", false).await?;
        match value.get("status").and_then(Value::as_str) {
            Some("ok") => Ok(()),
            _ => Err(misunderstood("GET /health")),
        }
    }

    pub async fn me(&self) -> Result<User, ApiError> {
        let value = self.get_json("/auth/me", true).await?;
        serde_json::from_value(value.get("user").cloned().unwrap_or(Value::Null))
            .map_err(|_| misunderstood("GET /auth/me"))
    }

    pub async fn logout(&self) -> Result<(), ApiError> {
        self.send("POST", "/auth/logout", true, None)
            .await
            .map(|_| ())
    }

    pub async fn list_runs(&self) -> Result<Vec<RunSummary>, ApiError> {
        let value = self.get_json("/runs", true).await?;
        serde_json::from_value(value.get("runs").cloned().unwrap_or(Value::Null))
            .map_err(|_| misunderstood("GET /runs"))
    }

    pub async fn get_run(&self, id: &str) -> Result<RunDetail, ApiError> {
        let value = self.get_json(&format!("/runs/{id}"), true).await?;
        serde_json::from_value(value).map_err(|_| misunderstood("GET /runs/:id"))
    }

    pub async fn create_run(
        &self,
        repository_id: &str,
        source_sha: &str,
        idempotency_key: &str,
    ) -> Result<CreatedRun, ApiError> {
        let (status, value) = self
            .send_json(
                "POST",
                "/runs",
                true,
                Some(serde_json::json!({ "repositoryId": repository_id, "sourceSha": source_sha })),
                Some(idempotency_key),
            )
            .await?;
        let run = serde_json::from_value(value.get("run").cloned().unwrap_or(Value::Null))
            .map_err(|_| misunderstood("POST /runs"))?;
        Ok(CreatedRun {
            run,
            created: status == StatusCode::ACCEPTED,
        })
    }

    pub async fn list_repos(&self) -> Result<Vec<Repo>, ApiError> {
        let value = self.get_json("/github/repositories", true).await?;
        serde_json::from_value(value.get("repositories").cloned().unwrap_or(Value::Null))
            .map_err(|_| misunderstood("GET /github/repositories"))
    }

    pub async fn install_url(&self) -> Result<String, ApiError> {
        let value = self.get_json("/github/install", true).await?;
        value
            .get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| misunderstood("GET /github/install"))
    }

    pub async fn install_status(
        &self,
        owner: &str,
        name: &str,
    ) -> Result<(String, String), ApiError> {
        let path = format!("/github/installations/status?owner={owner}&name={name}");
        let value = self.get_json(&path, true).await?;
        let branch = value
            .get("defaultBranch")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let owner = value
            .get("owner")
            .and_then(Value::as_str)
            .unwrap_or(owner)
            .to_string();
        let _ = name;
        Ok((owner, branch))
    }

    pub async fn start_login(&self) -> Result<(String, String, String), ApiError> {
        let value = self.get_json_post("/auth/github/cli/start").await?;
        let parsed: LoginStartBody = serde_json::from_value(value)
            .map_err(|_| misunderstood("POST /auth/github/cli/start"))?;
        let start = LoginStart {
            begin_path: parsed.begin_path,
            login_id: parsed.login_id,
            poll_secret: parsed.poll_secret,
        };
        Ok((start.begin_path, start.login_id, start.poll_secret))
    }

    pub async fn poll_login(
        &self,
        login_id: &str,
        poll_secret: &str,
    ) -> Result<LoginPoll, ApiError> {
        let (status, value) = self
            .send_json(
                "POST",
                "/auth/github/cli/token",
                false,
                Some(serde_json::json!({ "loginId": login_id, "pollSecret": poll_secret })),
                None,
            )
            .await?;
        if status == StatusCode::ACCEPTED {
            return Ok(LoginPoll::Pending);
        }
        match value.get("token").and_then(Value::as_str) {
            Some(token)
                if !token
                    .chars()
                    .any(|ch| ch.is_whitespace() || ch.is_control()) =>
            {
                Ok(LoginPoll::Token(token.to_string()))
            }
            _ => Err(misunderstood("POST /auth/github/cli/token")),
        }
    }

    pub async fn open_activity(&self, last_id: Option<String>) -> Result<ByteStream, ApiError> {
        let url = format!("{}/activity", self.origin);
        let mut request = self
            .live
            .get(url)
            .header(reqwest::header::ACCEPT, "text/event-stream");
        if let Some(token) = self.token() {
            // Bearer, not ADAMANT_SESSION: proxies drop header names that contain underscores.
            request = request.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(last_id) = last_id {
            request = request.header("Last-Event-ID", last_id);
        }
        let response = request
            .send()
            .await
            .map_err(|error| network(&self.origin, &error))?;
        let status = response.status();
        if !status.is_success() {
            let text = response.text().await.unwrap_or_default();
            return Err(http_error("GET", "/activity", &self.origin, status, &text));
        }
        Ok(Box::pin(response.bytes_stream()))
    }

    async fn get_json(&self, path: &str, auth: bool) -> Result<Value, ApiError> {
        self.send("GET", path, auth, None)
            .await
            .map(|(_, value)| value)
    }

    async fn get_json_post(&self, path: &str) -> Result<Value, ApiError> {
        self.send("POST", path, false, Some("{}".into()))
            .await
            .map(|(_, value)| value)
    }

    async fn send_json(
        &self,
        method: &str,
        path: &str,
        auth: bool,
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<(StatusCode, Value), ApiError> {
        let encoded = body.map(|value| value.to_string());
        let url = format!("{}{path}", self.origin);
        let client = &self.http;
        let mut request = match method {
            "POST" => client.post(url),
            _ => client.get(url),
        };
        request = request.header(reqwest::header::ACCEPT, "application/json");
        if encoded.is_some() {
            request = request.header(reqwest::header::CONTENT_TYPE, "application/json");
        }
        if let Some(key) = idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        if auth {
            if let Some(token) = self.token() {
                request = request.header(AUTHORIZATION, format!("Bearer {token}"));
            }
        }
        if let Some(body) = encoded {
            request = request.body(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| network(&self.origin, &error))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(http_error(method, path, &self.origin, status, &text));
        }
        if text.trim().is_empty() {
            return Ok((status, Value::Null));
        }
        serde_json::from_str(&text)
            .map(|value| (status, value))
            .map_err(|_| misunderstood(path))
    }

    async fn send(
        &self,
        method: &str,
        path: &str,
        auth: bool,
        body: Option<String>,
    ) -> Result<(StatusCode, Value), ApiError> {
        let url = format!("{}{path}", self.origin);
        let mut request = match method {
            "POST" => self.http.post(url),
            _ => self.http.get(url),
        };
        request = request.header(reqwest::header::ACCEPT, "application/json");
        if body.is_some() {
            request = request.header(reqwest::header::CONTENT_TYPE, "application/json");
        }
        if auth {
            if let Some(token) = self.token() {
                request = request.header(AUTHORIZATION, format!("Bearer {token}"));
            }
        }
        if let Some(body) = body {
            request = request.body(body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| network(&self.origin, &error))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            return Err(http_error(method, path, &self.origin, status, &text));
        }
        if text.trim().is_empty() {
            return Ok((status, Value::Null));
        }
        serde_json::from_str(&text)
            .map(|value| (status, value))
            .map_err(|_| misunderstood(path))
    }

    fn token(&self) -> Option<String> {
        self.session.lock().ok().and_then(|guard| guard.clone())
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginStartBody {
    login_id: String,
    poll_secret: String,
    begin_path: String,
}

fn misunderstood(call: &str) -> ApiError {
    ApiError {
        status: None,
        message: format!("{call} returned a response this client does not understand."),
    }
}

fn network(origin: &str, error: &reqwest::Error) -> ApiError {
    let message = if error.is_timeout() {
        format!("{origin} did not answer within 10s.")
    } else {
        format!("Could not reach the Adamant API at {origin}. Is it running?")
    };
    ApiError {
        status: None,
        message,
    }
}

fn http_error(method: &str, path: &str, origin: &str, status: StatusCode, body: &str) -> ApiError {
    let message = if status == StatusCode::UNAUTHORIZED {
        format!("{origin} rejected the session (401). It is unknown, expired, or revoked. /login issues another.")
    } else if let Some(error) = serde_json::from_str::<Value>(body).ok().and_then(|value| {
        value
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_string)
    }) {
        error
    } else if body.trim_start().starts_with('<') || body.trim().is_empty() {
        format!("{method} {path} failed with {status}.")
    } else {
        let trimmed = body.trim();
        let short: String = trimmed.chars().take(300).collect();
        if trimmed.chars().count() > 300 {
            format!("{short}…")
        } else {
            short
        }
    };
    ApiError {
        status: Some(status.as_u16()),
        message,
    }
}

impl SseParser {
    pub fn push(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut events = Vec::new();
        while let Some(end) = frame_end(&self.buf) {
            let frame: Vec<u8> = self.buf.drain(..end).collect();
            if let Some(event) = parse_frame(&frame) {
                events.push(event);
            }
        }
        if self.buf.len() > 1_000_000 {
            self.buf.clear();
        }
        events
    }
}

fn frame_end(buf: &[u8]) -> Option<usize> {
    let lf = buf
        .windows(2)
        .position(|pair| pair == b"\n\n")
        .map(|index| index + 2);
    let crlf = buf
        .windows(4)
        .position(|pair| pair == b"\r\n\r\n")
        .map(|index| index + 4);
    match (lf, crlf) {
        (Some(lf), Some(crlf)) => Some(lf.min(crlf)),
        (Some(end), None) | (None, Some(end)) => Some(end),
        (None, None) => None,
    }
}

fn parse_frame(frame: &[u8]) -> Option<SseEvent> {
    let text = String::from_utf8_lossy(frame);
    let mut id = None;
    let mut event = None;
    let mut data = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() || line.starts_with(':') {
            continue;
        }
        if let Some(rest) = line.strip_prefix("id:") {
            id = Some(rest.trim_start().to_string());
        } else if let Some(rest) = line.strip_prefix("event:") {
            event = Some(rest.trim_start().to_string());
        } else if let Some(rest) = line.strip_prefix("data:") {
            data.push(rest.trim_start().to_string());
        }
    }
    if data.is_empty() && event.is_none() {
        return None;
    }
    Some(SseEvent {
        id,
        event,
        data: data.join("\n"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_activity_frames_and_skips_pings() {
        let mut parser = SseParser::default();
        let raw = b"id: audit_1\nevent: audit:run.queued\ndata: {\"runId\":\"abc\"}\n\n: ping\n\n";
        let events = parser.push(raw);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id.as_deref(), Some("audit_1"));
        assert_eq!(events[0].event.as_deref(), Some("audit:run.queued"));
        assert!(events[0].data.contains("abc"));
    }

    #[test]
    fn reassembles_a_split_frame() {
        let mut parser = SseParser::default();
        assert!(parser.push(b"event: audit:x\ndata: {}").is_empty());
        let events = parser.push(b"\n\n");
        assert_eq!(events.len(), 1);
    }
}
