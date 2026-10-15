use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::Stream;
use reqwest::header::AUTHORIZATION;
use reqwest::StatusCode;
use serde::Deserialize;
use serde_json::Value;

const TIMEOUT: Duration = Duration::from_secs(10);

pub const NOT_SIGNED_IN: &str = "Not signed in. /login opens GitHub in the browser.";

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    live: reqwest::Client,
    origin: String,
    session: Arc<Mutex<Option<String>>>,
    /// Runs once each time the API turns down the session this client holds.
    on_rejected: Option<Arc<dyn Fn() + Send + Sync>>,
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
    pub id: String,
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

/// What `POST /auth/github/cli/start` hands the terminal.
#[derive(Debug, PartialEq, Eq)]
pub struct LoginStart {
    pub begin_path: String,
    pub login_id: String,
    pub poll_secret: String,
    /// `XXXX-XXXX`. The browser shows it too and signs the terminal in only after the
    /// user says the two match, so a sign-in link sent to someone else gets nowhere.
    pub user_code: String,
}

/// RFC 8628's alphabet, as the contract's `CLI_LOGIN_CODE_ALPHABET`.
const LOGIN_CODE_ALPHABET: &str = "BCDFGHJKLMNPQRSTVWXZ";

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
            on_rejected: None,
        })
    }

    /// Every call that can get a 401 goes through this client, so the app hears about a
    /// dead session in one place, however many calls were in flight.
    pub fn when_rejected(mut self, hook: impl Fn() + Send + Sync + 'static) -> Self {
        self.on_rejected = Some(Arc::new(hook));
        self
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn set_session(&self, token: Option<String>) {
        if let Ok(mut guard) = self.session.lock() {
            *guard = token;
        }
    }

    /// For /logout: after this nothing sends the session, and a 401 for it is not news.
    pub fn take_session(&self) -> Option<String> {
        self.session.lock().ok().and_then(|mut guard| guard.take())
    }

    pub fn signed_in(&self) -> bool {
        self.token().is_some()
    }

    /// Forgets the session the API turned down, unless /login replaced it meanwhile. The
    /// hook runs under the lock, so its message is queued before anyone sees the session gone.
    fn reject(&self, sent: &str) {
        let Ok(mut guard) = self.session.lock() else {
            return;
        };
        if guard.as_deref() != Some(sent) {
            return;
        }
        *guard = None;
        if let Some(hook) = &self.on_rejected {
            hook();
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

    /// Takes the token rather than the client's session: /logout has already dropped that.
    pub async fn revoke(&self, token: &str) -> Result<(), ApiError> {
        self.send_as("POST", "/auth/logout", Some(token), None, None)
            .await
            .map(|_| ())
    }

    /// Manual mode stops a heal at an open PR; auto merges it. The worker reads this, so
    /// heals that run while the terminal is closed follow it too.
    pub async fn put_settings(&self, auto_merge: bool) -> Result<bool, ApiError> {
        let (_, value) = self
            .send(
                "PUT",
                "/settings",
                true,
                Some(serde_json::json!({ "autoMerge": auto_merge })),
                None,
            )
            .await?;
        value
            .get("autoMerge")
            .and_then(Value::as_bool)
            .ok_or_else(|| misunderstood("PUT /settings"))
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
            .send(
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

    pub async fn start_login(&self) -> Result<LoginStart, ApiError> {
        let value = self.get_json_post("/auth/github/cli/start").await?;
        parse_login_start(value).ok_or_else(|| misunderstood("POST /auth/github/cli/start"))
    }

    pub async fn poll_login(
        &self,
        login_id: &str,
        poll_secret: &str,
    ) -> Result<LoginPoll, ApiError> {
        let (status, value) = self
            .send(
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
            Some(token) if crate::config::check_session(token).is_ok() => {
                Ok(LoginPoll::Token(token.to_string()))
            }
            _ => Err(misunderstood("POST /auth/github/cli/token")),
        }
    }

    pub async fn open_activity(&self, last_id: Option<String>) -> Result<ByteStream, ApiError> {
        let token = self.token().ok_or_else(not_signed_in)?;
        let url = format!("{}/activity", self.origin);
        let mut request = self
            .live
            .get(url)
            .header(reqwest::header::ACCEPT, "text/event-stream")
            // Bearer, not ADAMANT_SESSION: proxies drop header names that contain underscores.
            .header(AUTHORIZATION, format!("Bearer {token}"));
        if let Some(last_id) = last_id {
            request = request.header("Last-Event-ID", last_id);
        }
        let response = request
            .send()
            .await
            .map_err(|error| network(&self.origin, &error))?;
        let status = response.status();
        if !status.is_success() {
            if status == StatusCode::UNAUTHORIZED {
                self.reject(&token);
            }
            let text = response.text().await.unwrap_or_default();
            return Err(http_error("GET", "/activity", &self.origin, status, &text));
        }
        Ok(Box::pin(response.bytes_stream()))
    }

    async fn get_json(&self, path: &str, auth: bool) -> Result<Value, ApiError> {
        self.send("GET", path, auth, None, None)
            .await
            .map(|(_, value)| value)
    }

    async fn get_json_post(&self, path: &str) -> Result<Value, ApiError> {
        self.send("POST", path, false, Some(serde_json::json!({})), None)
            .await
            .map(|(_, value)| value)
    }

    /// Every route that wants a session answers 401 without one, so a signed-out call
    /// stops here instead of reading as a session the API rejected.
    async fn send(
        &self,
        method: &str,
        path: &str,
        auth: bool,
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<(StatusCode, Value), ApiError> {
        let token = if auth {
            Some(self.token().ok_or_else(not_signed_in)?)
        } else {
            None
        };
        self.send_as(method, path, token.as_deref(), body, idempotency_key)
            .await
    }

    async fn send_as(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> Result<(StatusCode, Value), ApiError> {
        let url = format!("{}{path}", self.origin);
        let mut request = match method {
            "POST" => self.http.post(url),
            "PUT" => self.http.put(url),
            _ => self.http.get(url),
        };
        request = request.header(reqwest::header::ACCEPT, "application/json");
        if let Some(key) = idempotency_key {
            request = request.header("Idempotency-Key", key);
        }
        if let Some(token) = token {
            request = request.header(AUTHORIZATION, format!("Bearer {token}"));
        }
        if let Some(body) = body {
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body.to_string());
        }
        let response = request
            .send()
            .await
            .map_err(|error| network(&self.origin, &error))?;
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if !status.is_success() {
            if let (StatusCode::UNAUTHORIZED, Some(token)) = (status, token) {
                self.reject(token);
            }
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
    user_code: String,
}

/// The code is printed as is, so anything but `XXXX-XXXX` from the alphabet (an escape
/// sequence from a hostile or broken API included) is refused rather than shown.
fn parse_login_start(value: Value) -> Option<LoginStart> {
    let body: LoginStartBody = serde_json::from_value(value).ok()?;
    if !is_login_code(&body.user_code) {
        return None;
    }
    Some(LoginStart {
        begin_path: body.begin_path,
        login_id: body.login_id,
        poll_secret: body.poll_secret,
        user_code: body.user_code,
    })
}

fn is_login_code(code: &str) -> bool {
    code.len() == 9
        && code.char_indices().all(|(index, ch)| {
            if index == 4 {
                ch == '-'
            } else {
                LOGIN_CODE_ALPHABET.contains(ch)
            }
        })
}

fn not_signed_in() -> ApiError {
    ApiError {
        status: None,
        message: NOT_SIGNED_IN.into(),
    }
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

    fn login_start(code: Value) -> Value {
        serde_json::json!({
            "loginId": "lid",
            "pollSecret": "secret",
            "beginPath": "/auth/github/cli/begin?login=lid",
            "userCode": code,
        })
    }

    #[test]
    fn reads_the_login_code_with_the_start() {
        assert_eq!(
            parse_login_start(login_start("WDJB-MJHT".into())),
            Some(LoginStart {
                begin_path: "/auth/github/cli/begin?login=lid".into(),
                login_id: "lid".into(),
                poll_secret: "secret".into(),
                user_code: "WDJB-MJHT".into(),
            })
        );
    }

    #[test]
    fn refuses_a_start_without_a_usable_code() {
        let mut missing = login_start(Value::Null);
        missing.as_object_mut().unwrap().remove("userCode");
        assert_eq!(parse_login_start(missing), None);
        for code in [
            Value::Null,
            1234.into(),
            "".into(),
            "wdjb-mjht".into(),
            "WDJBMJHT".into(),
            "WDJB-MJH".into(),
            "WDJB-MJHTX".into(),
            "WDJB_MJHT".into(),
            // Vowels and digits are not in the alphabet: 0/O and 1/I must not be confusable.
            "ABCD-EFGH".into(),
            "WDJB-MJH0".into(),
            "WDJB-MJHÉ".into(),
            "\u{1b}[2J-MJHT".into(),
            "WDJB-\u{1b}]8;".into(),
        ] {
            assert_eq!(parse_login_start(login_start(code.clone())), None, "{code}");
        }
    }
}

/// A one-request-per-connection HTTP server for tests.
#[cfg(test)]
pub mod fake {
    use std::sync::{Arc, Mutex};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    pub type Seen = Arc<Mutex<Vec<String>>>;

    /// Answers each request with the next reply, then stops listening. Returns the origin
    /// and every request it read.
    pub async fn serve(replies: Vec<(u16, &'static str)>) -> (String, Seen) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen: Seen = Arc::default();
        let log = seen.clone();
        tokio::spawn(async move {
            for (status, body) in replies {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let request = read_request(&mut socket).await;
                log.lock().unwrap().push(request);
                let head = format!(
                    "HTTP/1.1 {status} X\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = socket.write_all(head.as_bytes()).await;
                let _ = socket.write_all(body.as_bytes()).await;
                let _ = socket.shutdown().await;
            }
        });
        (origin, seen)
    }

    async fn read_request(socket: &mut tokio::net::TcpStream) -> String {
        let mut raw = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            let text = String::from_utf8_lossy(&raw).to_string();
            if let Some(end) = text.find("\r\n\r\n") {
                let length = text[..end]
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                if raw.len() >= end + 4 + length {
                    return text;
                }
            }
            match socket.read(&mut buf).await {
                Ok(0) | Err(_) => return String::from_utf8_lossy(&raw).to_string(),
                Ok(read) => raw.extend_from_slice(&buf[..read]),
            }
        }
    }
}

#[cfg(test)]
mod session {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn counted(origin: String, token: Option<&str>) -> (Client, Arc<AtomicUsize>) {
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let client = Client::new(origin, token.map(str::to_string))
            .unwrap()
            .when_rejected(move || {
                seen.fetch_add(1, Ordering::SeqCst);
            });
        (client, count)
    }

    #[tokio::test]
    async fn a_rejected_session_is_reported_once_and_not_sent_again() {
        let unauthorized = r#"{"error":"Unauthorized"}"#;
        let (origin, seen) = fake::serve(vec![(401, unauthorized), (401, unauthorized)]).await;
        let (client, rejected) = counted(origin, Some("tok-123"));

        let first = client.list_runs().await.unwrap_err();
        assert_eq!(first.status, Some(401));
        assert!(!first.message.contains("tok-123"));
        assert!(!client.signed_in());
        assert_eq!(rejected.load(Ordering::SeqCst), 1);

        // Signed out now: the next call stops here instead of collecting another 401.
        let second = client.me().await.unwrap_err();
        assert_eq!(second.status, None);
        assert_eq!(second.message, NOT_SIGNED_IN);
        assert!(client.open_activity(None).await.is_err());
        assert_eq!(rejected.load(Ordering::SeqCst), 1);
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert!(seen.lock().unwrap()[0].contains("authorization: Bearer tok-123"));
    }

    #[test]
    fn a_401_for_a_replaced_session_keeps_the_new_one() {
        let (client, rejected) = counted("http://127.0.0.1:9".into(), Some("old"));
        client.set_session(Some("new".into()));
        client.reject("old");
        assert!(client.signed_in());
        assert_eq!(rejected.load(Ordering::SeqCst), 0);
        client.reject("new");
        client.reject("new");
        assert!(!client.signed_in());
        assert_eq!(rejected.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn revoking_a_dead_session_is_not_a_rejection() {
        let (origin, seen) = fake::serve(vec![(401, r#"{"error":"Unauthorized"}"#)]).await;
        let (client, rejected) = counted(origin, Some("tok-123"));
        let token = client.take_session().unwrap();
        assert!(!client.signed_in());
        let error = client.revoke(&token).await.unwrap_err();
        assert_eq!(error.status, Some(401));
        assert_eq!(rejected.load(Ordering::SeqCst), 0);
        let request = seen.lock().unwrap()[0].clone();
        assert!(request.starts_with("POST /auth/logout "), "{request}");
        assert!(request.contains("authorization: Bearer tok-123"));
    }

    #[tokio::test]
    async fn saves_the_mode_with_a_put() {
        let (origin, seen) = fake::serve(vec![(200, r#"{"autoMerge":false}"#)]).await;
        let (client, _) = counted(origin, Some("tok-123"));
        assert_eq!(client.put_settings(false).await.unwrap(), false);
        let request = seen.lock().unwrap()[0].clone();
        assert!(request.starts_with("PUT /settings "), "{request}");
        assert!(request.contains("authorization: Bearer tok-123"));
        assert!(request.contains("content-type: application/json"));
        assert!(request.ends_with(r#"{"autoMerge":false}"#), "{request}");
    }

    #[tokio::test]
    async fn a_signed_out_client_does_not_save_the_mode() {
        let (origin, seen) = fake::serve(vec![(200, r#"{"autoMerge":true}"#)]).await;
        let (client, _) = counted(origin, None);
        let error = client.put_settings(true).await.unwrap_err();
        assert_eq!(error.message, NOT_SIGNED_IN);
        assert!(seen.lock().unwrap().is_empty());
    }
}
