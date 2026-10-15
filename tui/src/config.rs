use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use url::Url;

const DEFAULT_ORIGIN: &str = "http://localhost:8787";
const DEFAULT_OPENAI_BASE: &str = "https://api.openai.com/v1";
/// What the worker runs in this repo's .env; plain `gpt-6` is not on every key.
const DEFAULT_MODEL: &str = "gpt-6-sol";
const DEFAULT_EFFORT: &str = "medium";

#[derive(Clone)]
pub struct Config {
    pub origin: Option<String>,
    pub origin_error: Option<String>,
    pub session: Option<String>,
    pub session_error: Option<String>,
    pub model: Option<ModelConfig>,
    /// Commands and edits run without asking. `ADAMANT_APPROVALS=manual` starts in manual.
    pub auto: bool,
}

/// The terminal agent calls the model itself. The key never goes to the Adamant API.
#[derive(Clone)]
pub struct ModelConfig {
    pub key: String,
    pub base: String,
    pub model: String,
    /// `None` for a model without reasoning (`ADAMANT_REASONING=none`).
    pub effort: Option<String>,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("origin", &self.origin)
            .field("origin_error", &self.origin_error)
            .field("session", &self.session.as_ref().map(|_| "set"))
            .field("session_error", &self.session_error)
            .field("model", &self.model.as_ref().map(|model| &model.model))
            .field("auto", &self.auto)
            .finish()
    }
}

pub fn load() -> Config {
    let mut config = load_from(
        std::env::var("ADAMANT_API_URL").ok().as_deref(),
        std::env::var("ADAMANT_SESSION").ok().as_deref(),
    );
    config.model = load_model(|name| std::env::var(name).ok(), read_key_file);
    config.auto = !std::env::var("ADAMANT_APPROVALS")
        .map(|value| value.trim().eq_ignore_ascii_case("manual"))
        .unwrap_or(false);
    config
}

pub fn load_model(
    env: impl Fn(&str) -> Option<String>,
    key_file: impl Fn() -> Option<String>,
) -> Option<ModelConfig> {
    let present = |name: &str| {
        env(name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let key = present("OPENAI_API_KEY").or_else(key_file)?;
    if key.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
        return None;
    }
    let base = present("OPENAI_BASE_URL")
        .unwrap_or_else(|| DEFAULT_OPENAI_BASE.into())
        .trim_end_matches('/')
        .to_string();
    let model = present("ADAMANT_MODEL")
        .or_else(|| present("OPENAI_MODEL"))
        .unwrap_or_else(|| DEFAULT_MODEL.into());
    let effort = match present("ADAMANT_REASONING") {
        Some(value) if value.eq_ignore_ascii_case("none") => None,
        Some(value) => Some(value.to_ascii_lowercase()),
        None => Some(DEFAULT_EFFORT.into()),
    };
    Some(ModelConfig {
        key,
        base,
        model,
        effort,
    })
}

/// `~/.adamant/openai_key`, for a shell that does not export the key.
fn read_key_file() -> Option<String> {
    let home = std::env::var_os("HOME")?;
    let path = PathBuf::from(home).join(".adamant").join("openai_key");
    let value = fs::read_to_string(path).ok()?;
    let key = value.trim();
    (!key.is_empty()).then(|| key.to_string())
}

pub fn load_from(api_url: Option<&str>, session_env: Option<&str>) -> Config {
    let raw_origin = api_url.map(str::trim).filter(|value| !value.is_empty());
    let (origin, origin_error) = match normalize_origin(raw_origin.unwrap_or(DEFAULT_ORIGIN)) {
        Ok(origin) => (Some(origin), None),
        Err(error) => (None, Some(error)),
    };

    let (session, session_error) = match resolve_session(session_env, read_session_file) {
        Ok(session) => (session, None),
        Err(error) => (None, Some(error)),
    };

    Config {
        origin,
        origin_error,
        session,
        session_error,
        model: None,
        auto: true,
    }
}

pub fn normalize_origin(value: &str) -> Result<String, String> {
    let url = Url::parse(value)
        .map_err(|_| "ADAMANT_API_URL must be a valid absolute URL.".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("ADAMANT_API_URL must start with https:// (or http:// for localhost).".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("ADAMANT_API_URL must not contain credentials. Use ADAMANT_SESSION.".into());
    }
    if url.path() != "/" && url.path() != "" {
        return Err("ADAMANT_API_URL must be an origin without a path, query, or fragment.".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("ADAMANT_API_URL must be an origin without a path, query, or fragment.".into());
    }
    let host = url
        .host_str()
        .ok_or_else(|| "ADAMANT_API_URL must include a host.".to_string())?;
    if url.scheme() != "https" && !is_loopback(host) {
        return Err(
            "ADAMANT_API_URL must use HTTPS outside explicit localhost development.".into(),
        );
    }
    let port = match url.port() {
        Some(port) => format!(":{port}"),
        None => String::new(),
    };
    let host = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    };
    Ok(format!("{}://{host}{port}", url.scheme()))
}

/// `ADAMANT_SESSION` wins over the file. A blank variable counts as unset, so an empty
/// `export` does not hide a stored session.
pub fn resolve_session(
    env: Option<&str>,
    file: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<Option<String>, String> {
    match env.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => check_session(value).map(Some),
        None => file(),
    }
}

/// The API issues base64url tokens, and the value goes into a header. The error never
/// repeats the value: it is a secret even when it is malformed.
pub fn check_session(value: &str) -> Result<String, String> {
    if value.is_empty() || !value.chars().all(|ch| ch.is_ascii_graphic()) {
        return Err("ADAMANT_SESSION must be a session token: printable ASCII, no spaces.".into());
    }
    Ok(value.to_string())
}

/// Set after /login, so it can say the variable will win over the file next time.
pub fn session_in_env() -> bool {
    std::env::var("ADAMANT_SESSION").is_ok_and(|value| !value.trim().is_empty())
}

pub fn store_session(token: &str) -> Result<(), String> {
    let path = session_path()
        .ok_or_else(|| "Could not find a home directory for the session.".to_string())?;
    store_session_at(&path, token)
}

/// Writes a private temporary file and renames it over the session, so a failed or
/// interrupted write never leaves half a token, and a file someone created with looser
/// permissions is replaced rather than reused.
pub fn store_session_at(path: &Path, token: &str) -> Result<(), String> {
    let token =
        check_session(token).map_err(|_| "The API sent an unusable session.".to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Could not store the session.".to_string())?;
    fs::create_dir_all(parent).map_err(|_| "Could not create ~/.adamant.".to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    }
    let temp = parent.join(format!(".session-{}", std::process::id()));
    // One a crashed run with the same pid left behind.
    let _ = fs::remove_file(&temp);
    let written = (|| {
        let mut options = fs::OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(token.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temp);
        return Err("Could not store the session in ~/.adamant/session.".into());
    }
    Ok(())
}

pub fn clear_session_file() -> Result<(), String> {
    match session_path() {
        Some(path) => clear_session_at(&path),
        None => Ok(()),
    }
}

pub fn clear_session_at(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("Could not delete ~/.adamant/session.".into()),
    }
}

pub fn display_cwd() -> String {
    let path = std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| "~".into());
    let home = std::env::var("HOME").unwrap_or_default();
    shorten_path(&path, &home)
}

pub fn shorten_path(path: &str, home: &str) -> String {
    if home.is_empty() {
        return path.to_string();
    }
    if path == home {
        return "~".into();
    }
    let prefix = format!("{home}/");
    if let Some(rest) = path.strip_prefix(&prefix) {
        format!("~/{rest}")
    } else {
        path.to_string()
    }
}

fn read_session_file() -> Result<Option<String>, String> {
    match session_path() {
        Some(path) => read_session_at(&path),
        None => Ok(None),
    }
}

/// A missing or blank file is signed out, not an error.
pub fn read_session_at(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(value) => {
            let token = value.trim();
            if token.is_empty() {
                Ok(None)
            } else {
                check_session(token).map(Some).map_err(|_| {
                    "~/.adamant/session does not hold a valid session. /login replaces it."
                        .to_string()
                })
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not read ~/.adamant/session. /login replaces it.".into()),
    }
}

#[cfg(not(test))]
fn session_path() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    Some(PathBuf::from(home).join(".adamant").join("session"))
}

#[cfg(test)]
thread_local! {
    static SESSION_FILE: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

/// Tests never touch the real session: each names its own file, or has none.
#[cfg(test)]
fn session_path() -> Option<PathBuf> {
    SESSION_FILE.with(|cell| cell.borrow().clone())
}

#[cfg(test)]
pub fn use_session_file_for_test(path: PathBuf) {
    SESSION_FILE.with(|cell| *cell.borrow_mut() = Some(path));
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_localhost_and_https() {
        assert_eq!(
            normalize_origin("http://localhost:8787").unwrap(),
            "http://localhost:8787"
        );
        assert_eq!(
            normalize_origin("http://127.0.0.1:8787/").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert_eq!(
            normalize_origin("https://api.example.com").unwrap(),
            "https://api.example.com"
        );
    }

    #[test]
    fn rejects_non_local_http_and_credentials() {
        assert!(normalize_origin("http://example.com").is_err());
        assert!(normalize_origin("http://user:pw@localhost:8787").is_err());
        assert!(normalize_origin("http://localhost:8787/v1").is_err());
        assert!(normalize_origin("localhost:8787").is_err());
    }

    #[test]
    fn reads_the_model_from_the_environment() {
        let env = |name: &str| match name {
            "OPENAI_API_KEY" => Some("sk-test".to_string()),
            "OPENAI_MODEL" => Some("gpt-6-sol".to_string()),
            "ADAMANT_REASONING" => Some("none".to_string()),
            _ => None,
        };
        let model = load_model(env, || None).unwrap();
        assert_eq!(model.model, "gpt-6-sol");
        assert_eq!(model.base, "https://api.openai.com/v1");
        assert_eq!(model.effort, None);
        assert!(load_model(|_| None, || None).is_none());
        assert_eq!(
            load_model(|_| None, || Some("sk-file".into())).unwrap().key,
            "sk-file"
        );
    }

    #[test]
    fn the_variable_wins_over_the_file() {
        let never = || -> Result<Option<String>, String> { panic!("read the file") };
        assert_eq!(
            resolve_session(Some("  env-token\n"), never),
            Ok(Some("env-token".into()))
        );
        assert_eq!(
            resolve_session(Some(" \n"), || Ok(Some("file-token".into()))),
            Ok(Some("file-token".into()))
        );
        assert_eq!(
            resolve_session(None, || Ok(Some("file-token".into()))),
            Ok(Some("file-token".into()))
        );
        assert_eq!(resolve_session(None, || Ok(None)), Ok(None));
        // A broken variable is reported, not quietly replaced by the file.
        assert!(resolve_session(Some("two words"), never).is_err());
    }

    #[test]
    fn a_malformed_token_is_refused_without_repeating_it() {
        for bad in ["two words", "tab\there", "nul\0", "émoji-✓", "bell\x07"] {
            let error = check_session(bad).unwrap_err();
            assert!(!error.contains(bad), "{error}");
        }
        assert_eq!(check_session("aZ09-_x.~").as_deref(), Ok("aZ09-_x.~"));
    }

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("adamant-session-{}", uuid::Uuid::new_v4()));
        dir.join(".adamant").join("session")
    }

    #[test]
    fn reads_the_file_trimmed_and_treats_blank_as_signed_out() {
        let path = scratch();
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        assert_eq!(read_session_at(&path), Ok(None));
        fs::write(&path, "token-123\r\n").unwrap();
        assert_eq!(read_session_at(&path), Ok(Some("token-123".into())));
        fs::write(&path, "  \n").unwrap();
        assert_eq!(read_session_at(&path), Ok(None));
        fs::write(&path, "").unwrap();
        assert_eq!(read_session_at(&path), Ok(None));
        fs::write(&path, "secret part\n").unwrap();
        let error = read_session_at(&path).unwrap_err();
        assert!(error.contains("~/.adamant/session"), "{error}");
        assert!(!error.contains("secret"), "{error}");
        fs::remove_file(&path).unwrap();
        // A directory where the file should be cannot be read.
        fs::create_dir(&path).unwrap();
        assert!(read_session_at(&path).is_err());
        fs::remove_dir_all(path.parent().unwrap().parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stores_the_session_privately_and_whole() {
        use std::os::unix::fs::PermissionsExt;
        let path = scratch();
        let dir = path.parent().unwrap();
        let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;

        store_session_at(&path, "first-token").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "first-token");
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(dir), 0o700);

        // A file left readable by others is replaced, not reused.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        store_session_at(&path, "second-token").unwrap();
        assert_eq!(read_session_at(&path), Ok(Some("second-token".into())));
        assert_eq!(mode(&path), 0o600);

        // A refused token leaves the stored one alone, and nothing else behind.
        assert!(store_session_at(&path, "bad token").is_err());
        assert_eq!(read_session_at(&path), Ok(Some("second-token".into())));
        let names: Vec<_> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("session")]);

        clear_session_at(&path).unwrap();
        assert!(!path.exists());
        // Signing out twice, or with no file, is fine.
        clear_session_at(&path).unwrap();
        fs::remove_dir_all(dir.parent().unwrap()).unwrap();
    }

    #[test]
    fn shortens_home() {
        assert_eq!(shorten_path("/Users/avaish", "/Users/avaish"), "~");
        assert_eq!(
            shorten_path("/Users/avaish/adamant", "/Users/avaish"),
            "~/adamant"
        );
    }
}
