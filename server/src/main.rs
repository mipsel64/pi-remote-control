use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, State,
    },
    http::{header, HeaderMap, Method, Request, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use clap::{Parser, Subcommand};
use futures_util::{SinkExt, StreamExt};
use include_dir::{include_dir, Dir};
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, value::RawValue, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{mpsc as std_mpsc, Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::mpsc;
use url::Url;
use uuid::Uuid;
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, VapidSignatureBuilder, WebPushClient,
    WebPushError, WebPushMessageBuilder,
};

static ASSETS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web/dist");
const BROWSER_LIMIT: usize = 64 * 1024;
const AGENT_LIMIT: usize = 32 * 1024 * 1024;
const COOKIE_AGE: u64 = 604800;
const MAX_STORED_SESSIONS: usize = 50;
const MAX_SNAPSHOT_CHUNKS: u64 = 256;
const MAX_SNAPSHOT_BYTES: usize = 64 << 20;
const MAX_MODELS: usize = 2000;
const MAX_SUBSCRIPTIONS: usize = 100;
const THINKING_LEVELS: [&str; 7] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
type Sender = mpsc::UnboundedSender<Message>;

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    host: Option<String>,
    port: Option<u16>,
    public_origin: Option<String>,
    agent_token: Option<String>,
    admin_password: Option<String>,
    vapid_public_key: Option<String>,
    vapid_private_key: Option<String>,
    vapid_subject: Option<String>,
}
fn path() -> PathBuf {
    if let Some(p) = env::var_os("RC_CONFIG") {
        return p.into();
    }
    let base = env::var_os("XDG_CONFIG_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".config"));
    base.join("prc/config.json")
}
fn check_legacy_config() -> Result<(), String> {
    if env::var_os("RC_CONFIG").is_some() {
        return Ok(());
    }
    let file = path();
    match fs::symlink_metadata(&file) {
        Ok(_) => return Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("Cannot check private config: {e}")),
    }
    let old_dir = file.parent().unwrap().with_file_name("pi-remote-control");
    for name in ["config.json", "client.json"] {
        match fs::symlink_metadata(old_dir.join(name)) {
            Ok(_) => return Err(format!("Legacy private config found in {}. Move config.json and client.json (if present) to {} manually without overwriting files; keep mode 0600. Do not run setup until migrated.", old_dir.display(), file.parent().unwrap().display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("Cannot check legacy private config: {e}")),
        }
    }
    Ok(())
}
fn random_secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn setup() -> Result<(), String> {
    check_legacy_config()?;
    let file = path();
    let dir = file.parent().ok_or("Invalid config path")?;
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)
        .map_err(|e| e.to_string())?;
    if fs::symlink_metadata(dir)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Config directory must not be a symlink".into());
    }
    let temp = dir.join(format!(".config-{}.tmp", Uuid::new_v4()));
    let mut out = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let password = random_secret();
    let origin = "http://127.0.0.1:8787";
    let data =
        json!({"agentToken":random_secret(), "adminPassword":password, "publicOrigin":origin});
    let result = (|| -> std::io::Result<()> {
        out.set_permissions(fs::Permissions::from_mode(0o600))?;
        out.write_all(format!("{}\n", serde_json::to_string_pretty(&data).unwrap()).as_bytes())?;
        out.sync_all()?;
        fs::hard_link(&temp, &file)?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result.map_err(|e| e.to_string())?;
    println!("Admin password (save it now): {password}\nOpen {origin}/");
    Ok(())
}
fn read_config() -> Result<Config, String> {
    check_legacy_config()?;
    let file = path();
    let mut f = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&file)
    {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(e) => return Err(format!("Cannot read private config: {e}")),
    };
    let meta = f.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.permissions().mode() & 0o777 != 0o600 {
        return Err("Config must be a regular file with mode 0600".into());
    }
    let mut data = String::new();
    f.read_to_string(&mut data).map_err(|e| e.to_string())?;
    serde_json::from_str(&data).map_err(|_| "Invalid RC config".into())
}
fn override_string(name: &str, value: Option<String>) -> Option<String> {
    env::var(name).ok().or(value)
}
struct Settings {
    host: String,
    port: u16,
    origin: String,
    token: String,
    password: String,
    push: Option<Push>,
    state_dir: PathBuf,
}
#[derive(Clone)]
struct Push {
    public: String,
    private: String,
    subject: String,
    client: IsahcWebPushClient,
}
fn settings() -> Result<Settings, String> {
    let c = read_config()?;
    let host = override_string("RC_HOST", c.host).unwrap_or_else(|| "127.0.0.1".into());
    let port = env::var("RC_PORT")
        .ok()
        .map(|s| s.parse::<u16>().map_err(|_| "Invalid RC_PORT".to_string()))
        .transpose()?
        .or(c.port)
        .unwrap_or(8787);
    let explicit = override_string("RC_PUBLIC_ORIGIN", c.public_origin);
    if explicit.is_none() && !["127.0.0.1", "localhost", "::1"].contains(&host.as_str()) {
        return Err("RC_PUBLIC_ORIGIN is required for a non-loopback bind".into());
    }
    let origin = explicit.unwrap_or_else(|| format!("http://{host}:{port}"));
    let parsed = Url::parse(&origin).map_err(|_| "Invalid RC_PUBLIC_ORIGIN")?;
    if !["http", "https"].contains(&parsed.scheme())
        || parsed.origin().ascii_serialization() != origin
        || parsed.username() != ""
        || parsed.password().is_some()
    {
        return Err("Invalid RC_PUBLIC_ORIGIN".into());
    }
    if loopback_port_mismatch(&host, &parsed, port) {
        return Err("RC_PORT differs from the configured publicOrigin".into());
    }
    let token = override_string("RC_AGENT_TOKEN", c.agent_token)
        .filter(|s| !s.is_empty())
        .ok_or(
            "Credentials are required; run prc setup or set RC_AGENT_TOKEN and RC_ADMIN_PASSWORD",
        )?;
    let password = override_string("RC_ADMIN_PASSWORD", c.admin_password)
        .filter(|s| !s.is_empty())
        .ok_or(
            "Credentials are required; run prc setup or set RC_AGENT_TOKEN and RC_ADMIN_PASSWORD",
        )?;
    let (public, private, subject) = (
        override_string("VAPID_PUBLIC_KEY", c.vapid_public_key).filter(|s| !s.is_empty()),
        override_string("VAPID_PRIVATE_KEY", c.vapid_private_key).filter(|s| !s.is_empty()),
        override_string("VAPID_SUBJECT", c.vapid_subject).filter(|s| !s.is_empty()),
    );
    let subject = match subject {
        Some(s) if !s.starts_with("mailto:") && !s.starts_with("https://") => {
            return Err("Invalid VAPID subject".into())
        }
        Some(s) => s,
        None if origin.starts_with("https://") => origin.clone(),
        None => "mailto:prc@localhost".into(),
    };
    let state_dir = env::var_os("XDG_STATE_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env::var_os("HOME").unwrap_or_default()).join(".local/state")
        })
        .join("prc");
    let push = match (public, private) {
        (Some(public), Some(private)) => push_keys(public, private, subject)?,
        (None, None) => generated_push(&state_dir, subject)?,
        _ => return Err("Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY together".into()),
    };
    Ok(Settings {
        host,
        port,
        origin,
        token,
        password,
        push: Some(push),
        state_dir,
    })
}
fn push_keys(public: String, private: String, subject: String) -> Result<Push, String> {
    VapidSignatureBuilder::from_base64_no_sub(&private).map_err(|_| "Invalid VAPID private key")?;
    let public_bytes = URL_SAFE_NO_PAD
        .decode(&public)
        .map_err(|_| "Invalid VAPID public key")?;
    if public_bytes.len() != 65 || public_bytes[0] != 4 {
        return Err("Invalid VAPID public key".into());
    }
    Ok(Push {
        public,
        private,
        subject,
        client: IsahcWebPushClient::new().map_err(|_| "Cannot initialize push client")?,
    })
}
// Loads or creates <state_dir>/vapid.json; an unreadable or invalid file is an error, never overwritten.
fn generated_push(state_dir: &Path, subject: String) -> Result<Push, String> {
    use openssl::{
        bn::BigNumContext,
        ec::{EcGroup, EcKey, PointConversionForm},
        nid::Nid,
    };
    let file = state_dir.join("vapid.json");
    let failed = |e: String| format!("{}: {e}", file.display());
    ensure_state_dir(state_dir).map_err(|e| failed(e.to_string()))?;
    let (public, private) = match read_private(&file) {
        Ok(data) => {
            let v: Value = serde_json::from_slice(&data).map_err(|e| failed(e.to_string()))?;
            match (v["publicKey"].as_str(), v["privateKey"].as_str()) {
                (Some(public), Some(private)) => (public.to_string(), private.to_string()),
                _ => return Err(failed("publicKey and privateKey are required".into())),
            }
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let generate = || -> Result<(String, String), openssl::error::ErrorStack> {
                let group = EcGroup::from_curve_name(Nid::X9_62_PRIME256V1)?;
                let key = EcKey::generate(&group)?;
                let public = key.public_key().to_bytes(
                    &group,
                    PointConversionForm::UNCOMPRESSED,
                    &mut *BigNumContext::new()?,
                )?;
                Ok((
                    URL_SAFE_NO_PAD.encode(public),
                    URL_SAFE_NO_PAD.encode(key.private_key().to_vec_padded(32)?),
                ))
            };
            let (public, private) = generate().map_err(|e| failed(e.to_string()))?;
            let data = json!({"publicKey":public,"privateKey":private}).to_string();
            write_atomic(state_dir, "vapid.json", data.as_bytes())
                .map_err(|e| failed(e.to_string()))?;
            (public, private)
        }
        Err(e) => return Err(failed(e.to_string())),
    };
    push_keys(public, private, subject).map_err(failed)
}
// A non-loopback bind (e.g. Docker with -p 18787:8787) may legitimately serve a different browser port.
fn loopback_port_mismatch(host: &str, origin: &Url, port: u16) -> bool {
    ["127.0.0.1", "localhost", "::1"].contains(&host)
        && origin.scheme() == "http"
        && ["127.0.0.1", "localhost", "[::1]"].contains(&origin.host_str().unwrap_or(""))
        && origin.port_or_known_default() != Some(port)
}
fn equal_secret(candidate: Option<&str>, expected: &str) -> bool {
    let a = Sha256::digest(candidate.unwrap_or("").as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    bool::from(a.ct_eq(&b)) && candidate.is_some()
}
fn valid_id(v: &Value) -> Option<&str> {
    v.as_str()
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 256)
}
fn short_str(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| s.encode_utf16().count() <= 256)
}
fn thinking_level(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| THINKING_LEVELS.contains(s))
}
// Rebuilds an agent-supplied model with only known, bounded fields; anything invalid is treated as absent.
fn model_value(v: &Value, with_levels: bool) -> Option<Value> {
    let mut model = json!({"provider":valid_id(&v["provider"])?,"id":valid_id(&v["id"])?,"name":short_str(&v["name"])?,"reasoning":v["reasoning"].as_bool()?});
    if with_levels {
        let levels = v["thinkingLevels"].as_array().filter(|levels| {
            levels.len() <= THINKING_LEVELS.len()
                && levels.iter().all(|level| thinking_level(level).is_some())
        })?;
        model["thinkingLevels"] = json!(levels);
    }
    Some(model)
}
// Drops invalid entries individually; an oversized or non-list value is treated as absent.
fn model_list(v: &Value) -> Option<Vec<Value>> {
    v.as_array()
        .filter(|models| models.len() <= MAX_MODELS)
        .map(|models| {
            models
                .iter()
                .filter_map(|m| model_value(m, false))
                .collect()
        })
}
// Agent-reported context occupancy; tokens is null while the agent cannot tell (e.g. right after compaction).
fn context_value(v: &Value) -> Option<Value> {
    let window = v["contextWindow"].as_u64().filter(|n| *n > 0)?;
    let tokens = if v["tokens"].is_null() {
        Value::Null
    } else {
        json!(v["tokens"].as_u64()?)
    };
    Some(json!({"tokens":tokens,"contextWindow":window}))
}
fn send(tx: &Sender, v: Value) {
    let _ = tx.send(Message::Text(v.to_string().into()));
}
fn json_response(status: StatusCode, value: Value) -> Response {
    let mut response = (status, Json(value)).into_response();
    let h = response.headers_mut();
    h.insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    h.insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}
fn err(status: StatusCode, message: &str) -> Response {
    json_response(status, json!({"error":message}))
}
fn cookie_valid(h: &HeaderMap, inner: &mut Inner) -> bool {
    let candidate = h
        .get(header::COOKIE)
        .and_then(|s| s.to_str().ok())
        .unwrap_or("")
        .split(';')
        .map(str::trim)
        .find_map(|p| p.strip_prefix("rc_session="));
    let Some(value) = candidate else { return false };
    match inner.cookies.get(value) {
        Some(t) if *t > Instant::now() => true,
        _ => {
            inner.cookies.remove(value);
            false
        }
    }
}
struct Session {
    id: String,
    connection: String,
    name: String,
    cwd: String,
    branch: Option<String>,
    busy: bool,
    waiting: bool,
    asking: bool,
    updated_at: u64,
    model: Option<Value>,
    thinking_level: Option<String>,
    context: Option<Value>,
    models: Vec<Value>,
    owner: Option<Uuid>,
    tx: Option<Sender>,
    pending: Option<PendingSnapshot>,
}
impl Session {
    fn info(&self, process: &str) -> Value {
        json!({"processId":process,"sessionId":self.id,"connectionId":self.connection,"name":self.name,"cwd":self.cwd,"branch":self.branch,"busy":self.busy,"waiting":(self.waiting || self.asking) && self.tx.is_some(),"online":self.tx.is_some(),"updatedAt":self.updated_at,"model":self.model,"thinkingLevel":self.thinking_level,"context":self.context})
    }
    fn stored(&self, process: &str) -> StoredMeta {
        StoredMeta {
            process_id: process.into(),
            session_id: self.id.clone(),
            name: self.name.clone(),
            cwd: self.cwd.clone(),
            branch: self.branch.clone(),
            updated_at: self.updated_at,
            model: self.model.clone(),
            thinking_level: self.thinking_level.clone(),
            context: self.context.clone(),
        }
    }
}
struct PendingSnapshot {
    snapshot_id: String,
    total: u64,
    chunks: Vec<String>,
    bytes: usize,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredMeta {
    process_id: String,
    session_id: String,
    name: String,
    cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    branch: Option<String>,
    updated_at: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    context: Option<Value>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSnapshot<'a> {
    session_id: String,
    #[serde(borrow)]
    entries: Option<&'a RawValue>,
    #[serde(borrow)]
    chunks: Option<Vec<&'a RawValue>>,
}
enum SnapshotData {
    Entries(Value),
    Chunks(Vec<String>),
}
// One worker thread applies jobs in queue order, so a later snapshot is never overwritten
// by an earlier one and a replay sees every write queued before it.
enum Job {
    Meta(StoredMeta),
    Snapshot(String, String, SnapshotData),
    Remove(String),
    Replay(String, String, Sender),
    Subscriptions(Vec<Subscription>),
}
fn file_stem(process: &str) -> String {
    Sha256::digest(process.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn log_once(kind: &'static str, e: impl std::fmt::Display) {
    static LOGGED: Mutex<Vec<&str>> = Mutex::new(Vec::new());
    let mut logged = LOGGED.lock().unwrap();
    if !logged.contains(&kind) {
        logged.push(kind);
        eprintln!("State persistence ({kind}) failed: {e}");
    }
}
fn ensure_state_dir(dir: &Path) -> io::Result<PathBuf> {
    let sessions = dir.join("sessions");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&sessions)?;
    for d in [dir, &sessions] {
        if fs::symlink_metadata(d)?.file_type().is_symlink() {
            return Err(io::Error::other("state directory must not be a symlink"));
        }
    }
    Ok(sessions)
}
fn write_atomic(dir: &Path, name: &str, data: &[u8]) -> io::Result<()> {
    let temp = dir.join(format!(".{}.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)?;
        out.write_all(data)?;
        out.sync_all()?;
        fs::rename(&temp, dir.join(name))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}
fn read_private(path: &Path) -> io::Result<Vec<u8>> {
    let mut f = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    if !f.metadata()?.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    let mut data = Vec::new();
    f.read_to_end(&mut data)?;
    Ok(data)
}
fn remove_missing_ok(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}
fn persist_worker(dir: PathBuf, jobs: std_mpsc::Receiver<Job>, inner: Arc<Mutex<Inner>>) {
    for job in jobs {
        let sessions = match ensure_state_dir(&dir) {
            Ok(sessions) => sessions,
            Err(e) => {
                log_once("state directory", e);
                continue;
            }
        };
        let result = match job {
            Job::Meta(meta) => write_atomic(
                &sessions,
                &format!("{}.json", file_stem(&meta.process_id)),
                &serde_json::to_vec(&meta).unwrap(),
            )
            .map_err(|e| ("save session", e)),
            Job::Snapshot(process, session, data) => {
                let body = match data {
                    SnapshotData::Entries(entries) => {
                        format!("{{\"sessionId\":{},\"entries\":{entries}}}", json!(session))
                    }
                    SnapshotData::Chunks(chunks) => format!(
                        "{{\"sessionId\":{},\"chunks\":[{}]}}",
                        json!(session),
                        chunks.join(",")
                    ),
                };
                write_atomic(
                    &sessions,
                    &format!("{}.snapshot.json", file_stem(&process)),
                    body.as_bytes(),
                )
                .map_err(|e| ("save snapshot", e))
            }
            Job::Remove(process) => {
                let stem = file_stem(&process);
                remove_missing_ok(&sessions.join(format!("{stem}.snapshot.json")))
                    .and_then(|_| remove_missing_ok(&sessions.join(format!("{stem}.json"))))
                    .map_err(|e| ("remove session", e))
            }
            Job::Replay(process, session, tx) => replay(&sessions, &process, &session)
                .map(|frames| {
                    // Send under the lock only while still offline, so a reconnected agent's
                    // live snapshot can never be followed by this older stored one.
                    let inner = inner.lock().unwrap();
                    if inner
                        .sessions
                        .get(&process)
                        .is_some_and(|s| s.tx.is_none() && s.id == session)
                    {
                        for frame in frames {
                            let _ = tx.send(Message::Text(frame.into()));
                        }
                    }
                })
                .map_err(|e| ("read snapshot", e)),
            Job::Subscriptions(subscriptions) => write_atomic(
                &dir,
                "subscriptions.json",
                &serde_json::to_vec(&subscriptions).unwrap(),
            )
            .map_err(|e| ("save subscriptions", e)),
        };
        if let Err((kind, e)) = result {
            log_once(kind, e);
        }
    }
}
fn replay(sessions: &Path, process: &str, session: &str) -> io::Result<Vec<String>> {
    let data = match read_private(&sessions.join(format!("{}.snapshot.json", file_stem(process)))) {
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        other => other?,
    };
    let stored: StoredSnapshot = serde_json::from_slice(&data).map_err(io::Error::other)?;
    if stored.session_id != session {
        return Ok(Vec::new());
    }
    let (p, s) = (json!(process), json!(session));
    let mut frames = Vec::new();
    if let Some(entries) = stored.entries {
        frames.push(format!(
            "{{\"type\":\"snapshot\",\"processId\":{p},\"sessionId\":{s},\"entries\":{}}}",
            entries.get()
        ));
    } else if let Some(chunks) = stored.chunks {
        let id = json!(Uuid::new_v4().to_string());
        for (index, data) in chunks.iter().enumerate() {
            frames.push(format!("{{\"type\":\"snapshot_chunk\",\"processId\":{p},\"sessionId\":{s},\"snapshotId\":{id},\"index\":{index},\"total\":{},\"data\":{}}}", chunks.len(), data.get()));
        }
    }
    Ok(frames)
}
fn load_sessions(dir: &Path) -> HashMap<String, Session> {
    let mut sessions = HashMap::new();
    let entries = match ensure_state_dir(dir).and_then(fs::read_dir) {
        Ok(entries) => entries,
        Err(e) => {
            log_once("state directory", e);
            return sessions;
        }
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        // Temp files left by a crash or SIGTERM mid-write hold transcript data; skip fresh ones in case another instance is writing.
        if name
            .to_str()
            .is_some_and(|n| n.starts_with('.') && n.ends_with(".tmp"))
            && entry
                .metadata()
                .and_then(|m| m.modified())
                .is_ok_and(|t| t.elapsed().unwrap_or_default() > Duration::from_secs(60))
        {
            let _ = fs::remove_file(entry.path());
            continue;
        }
        let Some(stem) = name
            .to_str()
            .and_then(|n| n.strip_suffix(".json"))
            .filter(|n| n.len() == 64)
        else {
            continue;
        };
        let Some(meta) = read_private(&entry.path())
            .ok()
            .and_then(|data| serde_json::from_slice::<StoredMeta>(&data).ok())
            .filter(|meta| file_stem(&meta.process_id) == stem)
        else {
            continue;
        };
        sessions.insert(
            meta.process_id,
            Session {
                id: meta.session_id,
                connection: Uuid::new_v4().to_string(),
                name: meta.name,
                cwd: meta.cwd,
                branch: meta.branch,
                busy: false,
                waiting: false,
                asking: false,
                updated_at: meta.updated_at,
                model: meta.model,
                thinking_level: meta.thinking_level,
                context: meta.context,
                models: Vec::new(),
                owner: None,
                tx: None,
                pending: None,
            },
        );
    }
    sessions
}
fn prune(inner: &mut Inner, persist: &std_mpsc::Sender<Job>) {
    let excess = inner.sessions.len().saturating_sub(MAX_STORED_SESSIONS);
    let mut offline: Vec<_> = inner
        .sessions
        .iter()
        .filter(|(_, s)| s.tx.is_none())
        .map(|(p, s)| (s.updated_at, p.clone()))
        .collect();
    offline.sort();
    for (_, p) in offline.into_iter().take(excess) {
        inner.sessions.remove(&p);
        let _ = persist.send(Job::Remove(p));
    }
}
// Chunks are kept as raw JSON string literals so unpaired UTF-16 halves survive storage.
fn buffer_chunk(
    app: &App,
    process: &str,
    session: &mut Session,
    snapshot_id: &str,
    index: u64,
    total: u64,
    data: &str,
) {
    if index == 0 {
        session.pending = (total <= MAX_SNAPSHOT_CHUNKS).then(|| PendingSnapshot {
            snapshot_id: snapshot_id.into(),
            total,
            chunks: Vec::new(),
            bytes: 0,
        });
    }
    let Some(pending) = session.pending.as_mut().filter(|p| {
        p.snapshot_id == snapshot_id
            && p.total == total
            && p.chunks.len() as u64 == index
            && p.bytes + data.len() <= MAX_SNAPSHOT_BYTES
    }) else {
        session.pending = None;
        return;
    };
    pending.bytes += data.len();
    pending.chunks.push(data.into());
    if pending.chunks.len() as u64 == total {
        let chunks = session.pending.take().unwrap().chunks;
        let _ = app.persist.send(Job::Snapshot(
            process.into(),
            session.id.clone(),
            SnapshotData::Chunks(chunks),
        ));
    }
}
#[derive(Deserialize, Serialize, Clone)]
struct Subscription {
    endpoint: String,
    keys: Keys,
}
#[derive(Deserialize, Serialize, Clone)]
struct Keys {
    p256dh: String,
    auth: String,
}
#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Session>,
    browsers: HashMap<Uuid, Sender>,
    cookies: HashMap<String, Instant>,
    // Oldest first, so overflow drops the front.
    subscriptions: Vec<Subscription>,
}
fn load_subscriptions(dir: &Path) -> Vec<Subscription> {
    let data = match read_private(&dir.join("subscriptions.json")) {
        Ok(data) => data,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log_once("read subscriptions", e);
            return Vec::new();
        }
    };
    let mut subscriptions: Vec<Subscription> = serde_json::from_slice(&data)
        .inspect_err(|e| log_once("read subscriptions", e))
        .unwrap_or_default();
    subscriptions.drain(..subscriptions.len().saturating_sub(MAX_SUBSCRIPTIONS));
    subscriptions
}
fn edit_subscriptions(
    inner: &Mutex<Inner>,
    persist: &std_mpsc::Sender<Job>,
    edit: impl FnOnce(&mut Vec<Subscription>),
) {
    let mut inner = inner.lock().unwrap();
    edit(&mut inner.subscriptions);
    let excess = inner.subscriptions.len().saturating_sub(MAX_SUBSCRIPTIONS);
    inner.subscriptions.drain(..excess);
    let _ = persist.send(Job::Subscriptions(inner.subscriptions.clone()));
}
fn publish(inner: &Inner) {
    let list: Vec<_> = inner.sessions.iter().map(|(p, s)| s.info(p)).collect();
    broadcast(inner, json!({"type":"sessions","sessions":list}));
}
fn broadcast(inner: &Inner, msg: Value) {
    for tx in inner.browsers.values() {
        send(tx, msg.clone());
    }
}
struct App {
    settings: Settings,
    inner: Arc<Mutex<Inner>>,
    persist: std_mpsc::Sender<Job>,
}
impl App {
    fn new(settings: Settings) -> App {
        let (persist, jobs) = std_mpsc::channel();
        let dir = settings.state_dir.clone();
        let mut inner = Inner {
            sessions: load_sessions(&dir),
            subscriptions: load_subscriptions(&dir),
            ..Inner::default()
        };
        prune(&mut inner, &persist);
        let inner = Arc::new(Mutex::new(inner));
        let worker_inner = inner.clone();
        std::thread::spawn(move || persist_worker(dir, jobs, worker_inner));
        App {
            settings,
            inner,
            persist,
        }
    }
}
fn same_origin(h: &HeaderMap, settings: &Settings) -> bool {
    let Some(origin) = h.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let port = if settings.port == 80 {
        String::new()
    } else {
        format!(":{}", settings.port)
    };
    origin == settings.origin
        || (["127.0.0.1", "localhost", "::1"].contains(&settings.host.as_str())
            && ["127.0.0.1", "localhost", "[::1]"]
                .iter()
                .any(|host| origin == format!("http://{host}{port}")))
}
fn parse_body(bytes: &[u8]) -> Option<Value> {
    serde_json::from_slice(bytes).ok().filter(Value::is_object)
}
async fn http(State(app): State<Arc<App>>, req: Request<Body>) -> Response {
    let (parts, body) = req.into_parts();
    let method = parts.method;
    let uri = parts.uri;
    let h = parts.headers;
    let pathname = uri.path();
    if method == Method::POST && !same_origin(&h, &app.settings) {
        return err(StatusCode::FORBIDDEN, "Invalid origin");
    }
    if pathname == "/api/login" && method == Method::POST {
        let Ok(bytes) = axum::body::to_bytes(body, BROWSER_LIMIT).await else {
            return err(StatusCode::BAD_REQUEST, "Invalid request");
        };
        let Some(v) = parse_body(&bytes) else {
            return err(StatusCode::BAD_REQUEST, "Invalid request");
        };
        if !equal_secret(
            v.get("password").and_then(Value::as_str),
            &app.settings.password,
        ) {
            return err(StatusCode::UNAUTHORIZED, "Invalid credentials");
        }
        let token = random_secret();
        let mut inner = app.inner.lock().unwrap();
        inner.cookies.retain(|_, t| *t > Instant::now());
        inner.cookies.insert(
            token.clone(),
            Instant::now() + Duration::from_secs(COOKIE_AGE),
        );
        let mut res = json_response(StatusCode::OK, json!({"ok":true}));
        res.headers_mut().insert(
            header::SET_COOKIE,
            format!(
                "rc_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={COOKIE_AGE}{}",
                if h.get(header::ORIGIN)
                    .and_then(|value| value.to_str().ok())
                    .is_some_and(|origin| origin.starts_with("https:"))
                {
                    "; Secure"
                } else {
                    ""
                }
            )
            .parse()
            .unwrap(),
        );
        return res;
    }
    if pathname.starts_with("/api/") {
        if !cookie_valid(&h, &mut app.inner.lock().unwrap()) {
            return err(StatusCode::UNAUTHORIZED, "Unauthorized");
        }
        if pathname == "/api/push-key" && method == Method::GET {
            return json_response(
                StatusCode::OK,
                json!({"publicKey":app.settings.push.as_ref().map(|p| &p.public)}),
            );
        }
        if (pathname == "/api/subscribe" || pathname == "/api/unsubscribe")
            && method == Method::POST
        {
            if app.settings.push.is_none() {
                return err(StatusCode::SERVICE_UNAVAILABLE, "Push is not configured");
            }
            let Ok(bytes) = axum::body::to_bytes(body, BROWSER_LIMIT).await else {
                return err(StatusCode::BAD_REQUEST, "Invalid request");
            };
            let Some(v) = parse_body(&bytes) else {
                return err(StatusCode::BAD_REQUEST, "Invalid request");
            };
            if pathname == "/api/subscribe" {
                let Some(sub) = v
                    .get("subscription")
                    .and_then(|s| serde_json::from_value::<Subscription>(s.clone()).ok())
                    .filter(|s| s.endpoint.starts_with("https://"))
                else {
                    return err(StatusCode::BAD_REQUEST, "Invalid subscription");
                };
                edit_subscriptions(&app.inner, &app.persist, |subs| {
                    subs.retain(|s| s.endpoint != sub.endpoint);
                    subs.push(sub);
                });
            } else {
                let Some(endpoint) = v.get("endpoint").and_then(Value::as_str) else {
                    return err(StatusCode::BAD_REQUEST, "Invalid endpoint");
                };
                edit_subscriptions(&app.inner, &app.persist, |subs| {
                    subs.retain(|s| s.endpoint != endpoint)
                });
            }
            return json_response(StatusCode::OK, json!({"ok":true}));
        }
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    if method != Method::GET && method != Method::HEAD {
        return err(StatusCode::METHOD_NOT_ALLOWED, "Method not allowed");
    }
    asset(&uri, method == Method::HEAD)
}
fn asset(uri: &Uri, head: bool) -> Response {
    let raw = if uri.path() == "/" {
        "index.html"
    } else {
        uri.path().trim_start_matches('/')
    };
    // Check both the URL spelling and decoded segments; axum does not decode URI paths for us.
    let Ok(decoded) = urlencoding::decode(raw) else {
        return err(StatusCode::NOT_FOUND, "Not found");
    };
    let name = decoded.as_ref();
    if name.contains('\\')
        || name
            .split('/')
            .any(|p| p.starts_with('.') || p.is_empty() || p == "..")
    {
        return err(StatusCode::NOT_FOUND, "Not found");
    }
    let Some(file) = ASSETS.get_file(name) else {
        return err(StatusCode::NOT_FOUND, "Not found");
    };
    let mime = match name.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    let body = if head {
        Body::empty()
    } else {
        Body::from(file.contents())
    };
    let mut res = Response::new(body);
    res.headers_mut()
        .insert(header::CONTENT_TYPE, mime.parse().unwrap());
    res.headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    res.headers_mut().insert(
        header::CACHE_CONTROL,
        if name.starts_with("assets/") {
            "public, max-age=31536000, immutable"
        } else {
            "no-cache"
        }
        .parse()
        .unwrap(),
    );
    res
}
async fn upgrade(
    State(app): State<Arc<App>>,
    ws: WebSocketUpgrade,
    h: HeaderMap,
    uri: Uri,
) -> Response {
    if uri.query().is_some() {
        return err(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let agent = uri.path() == "/agent"
        && equal_secret(
            h.get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer ")),
            &app.settings.token,
        );
    let browser = uri.path() == "/ui"
        && same_origin(&h, &app.settings)
        && cookie_valid(&h, &mut app.inner.lock().unwrap());
    if !agent && !browser {
        return err(StatusCode::UNAUTHORIZED, "Unauthorized");
    }
    let limit = if agent { AGENT_LIMIT } else { BROWSER_LIMIT };
    ws.max_message_size(limit)
        .max_frame_size(limit)
        .on_upgrade(move |socket| socket_loop(socket, app, agent))
        .into_response()
}
async fn socket_loop(socket: WebSocket, app: Arc<App>, agent: bool) {
    let id = Uuid::new_v4();
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    let mut process: Option<String> = None;
    if !agent {
        let mut inner = app.inner.lock().unwrap();
        inner.browsers.insert(id, tx.clone());
        let list: Vec<_> = inner.sessions.iter().map(|(p, s)| s.info(p)).collect();
        send(&tx, json!({"type":"sessions","sessions":list}));
    }
    while let Some(message) = stream.next().await {
        let Ok(msg) = message else {
            let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1009,
                reason: "Message too large".into(),
            })));
            break;
        };
        let text = match msg {
            Message::Text(text) => text.to_string(),
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Message::Close(_) => break,
            _ => continue,
        };
        let value = match serde_json::from_str::<Value>(&text) {
            Ok(value) => value,
            Err(_) if agent && raw_chunk(&app, id, process.as_deref(), &text) => continue,
            Err(_) => {
                let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1008,
                    reason: "Invalid message".into(),
                })));
                break;
            }
        };
        if !value.is_object() {
            if agent {
                let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                    code: 1008,
                    reason: "Invalid message".into(),
                })));
                break;
            }
            send(&tx, json!({"type":"error","message":"Invalid command"}));
            continue;
        }
        if agent {
            if !agent_message(&app, id, &tx, &mut process, &value) {
                break;
            }
        } else {
            browser_message(&app, &tx, &value);
        }
    }
    {
        let mut inner = app.inner.lock().unwrap();
        inner.browsers.remove(&id);
        if let Some(p) = process {
            if let Some(s) = inner.sessions.get_mut(&p) {
                if s.owner == Some(id) {
                    s.owner = None;
                    s.tx = None;
                    s.pending = None;
                    publish(&inner);
                }
            }
        }
    }
    drop(stream);
    drop(tx);
    let _ = writer.await;
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawChunk<'a> {
    #[serde(borrow)]
    data: &'a RawValue,
    #[serde(rename = "type")]
    kind: String,
    process_id: String,
    session_id: String,
    snapshot_id: String,
    index: u64,
    total: u64,
}
// JS slices JSON snapshots by UTF-16 code unit, so a chunk may hold an unpaired surrogate.
// Keep the JSON string literal opaque; decoding it in Rust would replace or reject that half.
fn raw_chunk(app: &App, id: Uuid, process: Option<&str>, text: &str) -> bool {
    let Ok(chunk) = serde_json::from_str::<RawChunk>(text) else {
        return false;
    };
    if chunk.kind != "snapshot_chunk"
        || valid_id(&json!(chunk.snapshot_id)).is_none()
        || chunk.total == 0
        || chunk.total > 9007199254740991
        || chunk.index >= chunk.total
        || !chunk.data.get().starts_with('"')
        || !chunk.data.get().ends_with('"')
    {
        return false;
    }
    let mut guard = app.inner.lock().unwrap();
    let inner = &mut *guard;
    let Some(s) = inner.sessions.get_mut(&chunk.process_id) else {
        return true;
    };
    if process != Some(&chunk.process_id) || s.owner != Some(id) || s.id != chunk.session_id {
        return true;
    }
    let frame = format!("{{\"type\":\"snapshot_chunk\",\"processId\":{},\"sessionId\":{},\"snapshotId\":{},\"index\":{},\"total\":{},\"data\":{}}}",
        json!(chunk.process_id), json!(chunk.session_id), json!(chunk.snapshot_id), chunk.index, chunk.total, chunk.data.get());
    for tx in inner.browsers.values() {
        let _ = tx.send(Message::Text(frame.clone().into()));
    }
    buffer_chunk(
        app,
        &chunk.process_id,
        s,
        &chunk.snapshot_id,
        chunk.index,
        chunk.total,
        chunk.data.get(),
    );
    true
}
fn agent_message(
    app: &App,
    id: Uuid,
    tx: &Sender,
    process: &mut Option<String>,
    v: &Value,
) -> bool {
    if v["type"] == "hello" {
        let (Some(p), Some(s), Some(name), Some(cwd), Some(busy)) = (
            valid_id(&v["processId"]),
            valid_id(&v["sessionId"]),
            v["name"].as_str(),
            v["cwd"].as_str(),
            v["busy"].as_bool(),
        ) else {
            return close_policy(tx, "Invalid hello");
        };
        if name.encode_utf16().count() > 1024
            || cwd.encode_utf16().count() > 4096
            || process.as_deref().is_some_and(|old| old != p)
        {
            return close_policy(tx, "Invalid hello");
        }
        *process = Some(p.to_string());
        let mut inner = app.inner.lock().unwrap();
        let old = inner.sessions.get(p);
        if let Some(other) = old
            .filter(|s| s.owner != Some(id))
            .and_then(|s| s.tx.as_ref())
        {
            let _ = other.send(Message::Close(Some(axum::extract::ws::CloseFrame {
                code: 1000,
                reason: "Reconnected".into(),
            })));
        }
        let connection = old
            .filter(|s| s.owner == Some(id))
            .map(|s| s.connection.clone())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let updated_at = v["updatedAt"].as_u64().unwrap_or(0);
        let updated_at = old
            .filter(|previous| previous.id == s)
            .map_or(updated_at, |previous| updated_at.max(previous.updated_at));
        let session = Session {
            id: s.into(),
            connection,
            name: name.into(),
            cwd: cwd.into(),
            branch: valid_id(&v["branch"]).map(String::from),
            busy,
            waiting: v["waiting"].as_bool().unwrap_or(false),
            asking: v["asking"].as_bool().unwrap_or(false),
            updated_at,
            model: model_value(&v["model"], true),
            thinking_level: thinking_level(&v["thinkingLevel"]).map(String::from),
            context: context_value(&v["context"]),
            models: model_list(&v["models"]).unwrap_or_default(),
            owner: Some(id),
            tx: Some(tx.clone()),
            pending: None,
        };
        let _ = app.persist.send(Job::Meta(session.stored(p)));
        inner.sessions.insert(p.to_string(), session);
        let resumed: Vec<_> = inner
            .sessions
            .iter()
            .filter(|(q, other)| *q != p && other.id == s && other.tx.is_none())
            .map(|(q, _)| q.clone())
            .collect();
        for q in resumed {
            inner.sessions.remove(&q);
            let _ = app.persist.send(Job::Remove(q));
        }
        prune(&mut inner, &app.persist);
        publish(&inner);
        send(tx, json!({"type":"history","sessionId":s}));
        return true;
    }
    let Some(p) = process else { return true };
    let mut inner = app.inner.lock().unwrap();
    let Some(session) = inner.sessions.get_mut(p) else {
        return true;
    };
    if session.owner != Some(id) || v["processId"] != *p || v["sessionId"] != session.id {
        return true;
    }
    let s = session.id.clone();
    match v["type"].as_str() {
        Some("snapshot") if v["entries"].is_array() => {
            let _ = app.persist.send(Job::Snapshot(
                p.clone(),
                s.clone(),
                SnapshotData::Entries(v["entries"].clone()),
            ));
            broadcast(
                &inner,
                json!({"type":"snapshot","processId":p,"sessionId":s,"entries":v["entries"]}),
            )
        }
        Some("snapshot_chunk")
            if valid_id(&v["snapshotId"]).is_some()
                && v["data"].is_string()
                && v["total"]
                    .as_u64()
                    .is_some_and(|n| n > 0 && n <= 9007199254740991)
                && v["index"]
                    .as_u64()
                    .is_some_and(|i| i < v["total"].as_u64().unwrap()) =>
        {
            broadcast(
                &inner,
                json!({"type":"snapshot_chunk","processId":p,"sessionId":s,"snapshotId":v["snapshotId"],"index":v["index"],"total":v["total"],"data":v["data"]}),
            );
            if let Some(session) = inner.sessions.get_mut(p.as_str()) {
                buffer_chunk(
                    app,
                    p,
                    session,
                    v["snapshotId"].as_str().unwrap(),
                    v["index"].as_u64().unwrap(),
                    v["total"].as_u64().unwrap(),
                    &v["data"].to_string(),
                );
            }
        }
        Some("models") => {
            if let Some(models) = model_list(&v["models"]) {
                let frame = json!({"type":"models","processId":p,"sessionId":s,"models":models});
                session.models = models;
                broadcast(&inner, frame);
            }
        }
        Some("event")
            if v["event"].is_object()
                && [
                    "message_start",
                    "message_update",
                    "message_end",
                    "agent_start",
                    "agent_settled",
                    "ui_prompt_start",
                    "ui_prompt_end",
                ]
                .contains(&v["event"]["type"].as_str().unwrap_or("")) =>
        {
            let kind = v["event"]["type"].as_str().unwrap();
            let mut changed = false;
            let previous_updated_at = session.updated_at;
            if kind == "ui_prompt_start" || kind == "ui_prompt_end" {
                session.waiting = kind == "ui_prompt_start";
                changed = true;
            }
            if kind == "agent_start" || kind == "agent_settled" {
                session.busy = kind == "agent_start";
                session.asking = v["event"]["asking"] == true;
                if kind == "agent_start" {
                    session.updated_at = session.updated_at.max(
                        SystemTime::now()
                            .duration_since(UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64,
                    );
                }
                changed = true;
            }
            if kind == "message_end"
                && ["user", "assistant"]
                    .contains(&v["event"]["message"]["role"].as_str().unwrap_or(""))
            {
                if let Some(timestamp) = v["event"]["message"]["timestamp"].as_u64() {
                    if timestamp > session.updated_at {
                        session.updated_at = timestamp;
                        changed = true;
                    }
                }
            }
            let context = context_value(&v["event"]["contextUsage"])
                .filter(|context| session.context.as_ref() != Some(context));
            let context_changed = context.is_some();
            if context.is_some() {
                session.context = context;
                changed = true;
            }
            if context_changed || session.updated_at != previous_updated_at {
                let _ = app.persist.send(Job::Meta(session.stored(p)));
            }
            if changed {
                publish(&inner);
            }
            broadcast(
                &inner,
                json!({"type":"event","processId":p,"sessionId":s,"event":v["event"]}),
            );
            if kind == "message_end" {
                send(tx, json!({"type":"history","sessionId":s}));
            }
            if let Some(body) = notice_body(&v["event"]) {
                if let Some(push) = &app.settings.push {
                    let payload = push_payload(&inner.sessions[p.as_str()].name, p, &s, &body);
                    for subscription in inner.subscriptions.iter().cloned() {
                        let (push, payload) = (push.clone(), payload.clone());
                        let (state, persist) = (app.inner.clone(), app.persist.clone());
                        tokio::spawn(async move {
                            push_notification(push, subscription, payload, state, persist).await
                        });
                    }
                }
            }
        }
        _ => {}
    }
    true
}
fn close_policy(tx: &Sender, reason: &str) -> bool {
    let _ = tx.send(Message::Close(Some(axum::extract::ws::CloseFrame {
        code: 1008,
        reason: reason.into(),
    })));
    false
}
fn browser_message(app: &App, tx: &Sender, v: &Value) {
    let Some(p) = valid_id(&v["processId"]) else {
        send(tx, json!({"type":"error","message":"Invalid command"}));
        return;
    };
    let mut inner = app.inner.lock().unwrap();
    if v["type"] == "remove" {
        match inner.sessions.get(p).map(|s| s.tx.is_some()) {
            Some(false) => {
                inner.sessions.remove(p);
                let _ = app.persist.send(Job::Remove(p.into()));
                publish(&inner);
            }
            Some(true) => send(
                tx,
                json!({"type":"error","message":"Only offline sessions can be removed"}),
            ),
            None => {}
        }
        return;
    }
    let Some(session) = inner.sessions.get(p) else {
        if v["type"] != "models" {
            send(tx, json!({"type":"error","message":"Process is offline"}));
        }
        return;
    };
    let Some(agent) = session.tx.as_ref() else {
        if v["type"] == "select" {
            let _ = app
                .persist
                .send(Job::Replay(p.into(), session.id.clone(), tx.clone()));
        } else if v["type"] != "models" {
            send(tx, json!({"type":"error","message":"Process is offline"}));
        }
        return;
    };
    if v["type"] == "select" {
        send(agent, json!({"type":"history","sessionId":session.id}));
        return;
    }
    if v["type"] == "models" {
        send(
            tx,
            json!({"type":"models","processId":p,"sessionId":session.id,"models":session.models}),
        );
        send(agent, json!({"type":"models","sessionId":session.id}));
        return;
    }
    let s = &session.id;
    let command = match v["type"].as_str() {
        _ if v["sessionId"] != *s => None,
        Some("prompt")
            if v["text"]
                .as_str()
                .is_some_and(|t| !t.trim().is_empty() && t.len() <= 16 * 1024) =>
        {
            Some(json!({"type":"prompt","sessionId":s,"text":v["text"]}))
        }
        Some("abort") => Some(json!({"type":"abort","sessionId":s})),
        Some("set_model")
            if session
                .models
                .iter()
                .any(|m| m["provider"] == v["provider"] && m["id"] == v["modelId"]) =>
        {
            Some(
                json!({"type":"set_model","sessionId":s,"provider":v["provider"],"modelId":v["modelId"]}),
            )
        }
        Some("set_thinking") if thinking_level(&v["level"]).is_some() => {
            Some(json!({"type":"set_thinking","sessionId":s,"level":v["level"]}))
        }
        Some("rename")
            if v["name"]
                .as_str()
                .is_some_and(|n| n.encode_utf16().count() <= 1024) =>
        {
            Some(json!({"type":"rename","sessionId":s,"name":v["name"]}))
        }
        _ => None,
    };
    match command {
        Some(command) => send(agent, command),
        None => send(
            tx,
            json!({"type":"error","message":"Invalid or stale command"}),
        ),
    }
}
fn notice_body(event: &Value) -> Option<String> {
    let text = |key: &str, max: usize| {
        event[key]
            .as_str()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| t.chars().take(max).collect::<String>())
    };
    match event["type"].as_str()? {
        "agent_settled" => {
            Some(text("summary", 200).unwrap_or_else(|| "Finished responding".into()))
        }
        "ui_prompt_start" => Some(text("title", 120).map_or_else(
            || "Needs your input".into(),
            |title| format!("Needs your input: {title}"),
        )),
        _ => None,
    }
}
fn push_payload(name: &str, process: &str, session: &str, body: &str) -> Vec<u8> {
    let title: String = name.trim().chars().take(80).collect();
    let title = if title.is_empty() {
        "New Session".into()
    } else {
        title
    };
    json!({"title":title,"body":body,"processId":process,"sessionId":session})
        .to_string()
        .into_bytes()
}
async fn deliver(push: &Push, sub: &Subscription, payload: &[u8]) -> Result<(), WebPushError> {
    let info = SubscriptionInfo::new(&sub.endpoint, &sub.keys.p256dh, &sub.keys.auth);
    let mut signature = VapidSignatureBuilder::from_base64(&push.private, &info)?;
    signature.add_claim("sub", push.subject.clone());
    let mut builder = WebPushMessageBuilder::new(&info);
    builder.set_payload(ContentEncoding::Aes128Gcm, payload);
    builder.set_vapid_signature(signature.build()?);
    push.client.send(builder.build()?).await
}
// Endpoints are bearer capabilities, so logs name only the push service host.
fn push_host(endpoint: &str) -> String {
    Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .unwrap_or_default()
}
fn gone(error: &WebPushError) -> bool {
    matches!(
        error,
        WebPushError::EndpointNotValid(_) | WebPushError::EndpointNotFound(_)
    )
}
async fn push_notification(
    push: Push,
    sub: Subscription,
    payload: Vec<u8>,
    inner: Arc<Mutex<Inner>>,
    persist: std_mpsc::Sender<Job>,
) {
    match deliver(&push, &sub, &payload).await {
        Ok(()) => {}
        Err(error) if gone(&error) => edit_subscriptions(&inner, &persist, |subs| {
            subs.retain(|s| s.endpoint != sub.endpoint)
        }),
        Err(error) => eprintln!("Push via {} failed: {error:?}", push_host(&sub.endpoint)),
    }
}
fn router(settings: Settings) -> Router {
    let app = Arc::new(App::new(settings));
    Router::new()
        .route("/agent", any(upgrade))
        .route("/ui", any(upgrade))
        .fallback(any(http))
        .layer(DefaultBodyLimit::disable())
        .with_state(app)
}
#[cfg(test)]
mod tests;
#[derive(Parser)]
#[command(version = env!("PRC_VERSION"), about = "Pi Remote Control server")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Setup,
    Serve,
}
#[tokio::main]
async fn main() {
    let result = match Cli::parse().command {
        Command::Setup => setup(),
        Command::Serve => serve().await,
    };
    if let Err(e) = result {
        eprintln!("{e}");
        std::process::exit(1)
    }
}
async fn serve() -> Result<(), String> {
    let settings = settings()?;
    let addr = if settings.host.contains(':') {
        format!("[{}]:{}", settings.host, settings.port)
    } else {
        format!("{}:{}", settings.host, settings.port)
    };
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Cannot bind {addr}: {e}"))?;
    println!("Listening at {}/", settings.origin);
    axum::serve(listener, router(settings))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|e| e.to_string())
}
