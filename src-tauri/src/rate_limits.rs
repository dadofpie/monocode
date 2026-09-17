use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::Value;

use crate::dirs_home;

const OAUTH_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA: &str = "oauth-2025-04-20";
pub(crate) const USER_AGENT: &str = "claude-code/2.1.0";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

pub(crate) fn http_client() -> &'static ureq::Agent {
    static CLIENT: std::sync::OnceLock<ureq::Agent> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build())
}

#[cfg(target_os = "macos")]
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(target_os = "macos")]
const LEGACY_KEYCHAIN_SERVICE: &str = "Claude Code-credentials";
#[cfg(target_os = "macos")]
const KEYCHAIN_FALLBACK_USER: &str = "claude-code-user";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderUsageFetch {
    pub status: String,
    pub http_status: Option<u16>,
    pub body: Option<String>,
    pub error: Option<String>,
}

pub type ClaudeUsageFetch = ProviderUsageFetch;
pub type CmdUsageFetch = ProviderUsageFetch;
pub type AgyUsageFetch = ProviderUsageFetch;

pub(crate) const CMD_CREDITS_URL: &str = "https://api.commandcode.ai/alpha/billing/credits";
const AGY_DAILY_CLOUDCODE_URL: &str = "https://daily-cloudcode-pa.googleapis.com";
const AGY_PROD_CLOUDCODE_URL: &str = "https://cloudcode-pa.googleapis.com";

struct ClaudeCredentials {
    access_token: String,
    expires_at_ms: Option<i64>,
}

fn usage_result(
    status: &str,
    http_status: Option<u16>,
    body: Option<String>,
    error: Option<String>,
) -> ProviderUsageFetch {
    ProviderUsageFetch {
        status: status.into(),
        http_status,
        body,
        error,
    }
}

/// Fetch Claude Code 5-hour / weekly usage via the local OAuth token.
/// The token never leaves the host process.
#[tauri::command]
pub async fn fetch_claude_usage() -> Result<ClaudeUsageFetch, String> {
    tauri::async_runtime::spawn_blocking(fetch_claude_usage_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_claude_usage_sync() -> Result<ClaudeUsageFetch, String> {
    let Some(creds) = read_claude_credentials() else {
        return Ok(usage_result(
            "unavailable",
            None,
            None,
            Some("Claude not signed in".into()),
        ));
    };

    // Claude Code owns this credential and rotates its refresh token. The
    // usage footer must remain read-only: independently refreshing here can
    // race a live CLI (or another MonoCode window) and leave one process with
    // a spent refresh token, which forces the user through sign-in again.
    if token_expired(creds.expires_at_ms, now_ms()) {
        return Ok(usage_error(401));
    }

    Ok(fetch_usage_with_token(&creds.access_token))
}

/// Fetch Command Code 5-hour / weekly window limits and credits via ~/.commandcode/auth.json.
#[tauri::command]
pub async fn fetch_cmd_usage() -> Result<CmdUsageFetch, String> {
    tauri::async_runtime::spawn_blocking(fetch_cmd_usage_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_cmd_usage_sync() -> Result<CmdUsageFetch, String> {
    let Some(api_key) = read_cmd_api_key() else {
        return Ok(usage_result(
            "unavailable",
            None,
            None,
            Some("Command Code not signed in".into()),
        ));
    };

    let client = http_client();
    let result = client
        .get(CMD_CREDITS_URL)
        .set("Authorization", &format!("Bearer {api_key}"))
        .set("User-Agent", USER_AGENT)
        .call();

    match result {
        Ok(response) => {
            let http_status = response.status();
            let body = response.into_string().unwrap_or_default();
            if (200..300).contains(&http_status) {
                Ok(usage_result("ok", Some(http_status), Some(body), None))
            } else {
                Ok(usage_result(
                    "error",
                    Some(http_status),
                    None,
                    Some(format!("Command Code usage request failed ({http_status})")),
                ))
            }
        }
        Err(ureq::Error::Status(status, response)) => {
            let _ = response.into_string();
            let message = if status == 401 {
                "Command Code sign-in expired".into()
            } else {
                format!("Command Code usage request failed ({status})")
            };
            Ok(usage_result("error", Some(status), None, Some(message)))
        }
        Err(error) => Ok(usage_result(
            "error",
            None,
            None,
            Some(format!("Command Code usage request failed: {error}")),
        )),
    }
}

pub(crate) fn cmd_auth_path() -> Option<PathBuf> {
    let home = dirs_home().or_else(|| {
        std::env::var_os("USERPROFILE").map(|value| value.to_string_lossy().into_owned())
    })?;
    Some(PathBuf::from(home).join(".commandcode/auth.json"))
}

pub(crate) fn extract_cmd_api_key(raw: &str) -> Option<String> {
    let val: Value = serde_json::from_str(raw.trim()).ok()?;
    let key = val.get("apiKey").and_then(Value::as_str)?.trim();
    if key.is_empty() {
        None
    } else {
        Some(key.to_string())
    }
}

fn read_cmd_api_key() -> Option<String> {
    let path = cmd_auth_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    extract_cmd_api_key(&raw)
}

/// Fetch Antigravity (agy) quota summary or loadCodeAssist status.
#[tauri::command]
pub async fn fetch_agy_usage() -> Result<AgyUsageFetch, String> {
    tauri::async_runtime::spawn_blocking(fetch_agy_usage_sync)
        .await
        .map_err(|e| e.to_string())?
}

fn fetch_agy_usage_sync() -> Result<AgyUsageFetch, String> {
    let Some(creds) = read_agy_credentials() else {
        return Ok(usage_result(
            "unavailable",
            None,
            None,
            Some("Antigravity not signed in".into()),
        ));
    };

    let client = http_client();

    // 1. Prioritize loadCodeAssist on daily-cloudcode (standard for agy CLI) or prod
    for base_url in [AGY_DAILY_CLOUDCODE_URL, AGY_PROD_CLOUDCODE_URL] {
        let load_url = format!("{base_url}/v1internal:loadCodeAssist");
        let result = client
            .post(&load_url)
            .set("Authorization", &format!("Bearer {}", creds.access_token))
            .set("Content-Type", "application/json")
            .set("User-Agent", USER_AGENT)
            .send_string("{}");

        match result {
            Ok(response) => {
                let http_status = response.status();
                let body = response.into_string().unwrap_or_default();
                if (200..300).contains(&http_status) {
                    return Ok(usage_result("ok", Some(http_status), Some(body), None));
                }
            }
            Err(ureq::Error::Status(status, response)) => {
                let _ = response.into_string();
                if status == 401 {
                    return Ok(usage_result(
                        "error",
                        Some(status),
                        None,
                        Some("Antigravity sign-in expired".into()),
                    ));
                }
            }
            _ => {}
        }
    }

    // 2. Fallback to retrieveUserQuotaSummary if loadCodeAssist didn't return 200
    for base_url in [AGY_DAILY_CLOUDCODE_URL, AGY_PROD_CLOUDCODE_URL] {
        let quota_url = format!("{base_url}/v1internal:retrieveUserQuotaSummary");
        let result = client
            .post(&quota_url)
            .set("Authorization", &format!("Bearer {}", creds.access_token))
            .set("Content-Type", "application/json")
            .set("User-Agent", USER_AGENT)
            .send_string("{}");

        if let Ok(response) = result {
            let http_status = response.status();
            let body = response.into_string().unwrap_or_default();
            if (200..300).contains(&http_status) {
                return Ok(usage_result("ok", Some(http_status), Some(body), None));
            }
        }
    }

    Ok(usage_result(
        "error",
        None,
        None,
        Some("Antigravity usage request failed".into()),
    ))
}

pub(crate) struct AgyCredentials {
    pub(crate) access_token: String,
}

fn read_agy_credentials() -> Option<AgyCredentials> {
    #[cfg(target_os = "macos")]
    {
        if let Some(creds) = read_macos_keychain_agy_credentials() {
            return Some(creds);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn read_macos_keychain_agy_credentials() -> Option<AgyCredentials> {
    let args = vec![
        "find-generic-password".into(),
        "-s".into(),
        "gemini".into(),
        "-a".into(),
        "antigravity".into(),
        "-w".into(),
    ];
    let secret = security_output(&args)?;
    extract_agy_token(&secret)
}

pub(crate) fn extract_agy_token(secret: &str) -> Option<AgyCredentials> {
    use base64::prelude::*;
    let raw = secret.trim();
    let b64 = if let Some(stripped) = raw.strip_prefix("go-keyring-base64:") {
        stripped
    } else {
        raw
    };
    let decoded = BASE64_STANDARD.decode(b64.as_bytes()).ok()?;
    let text = String::from_utf8(decoded).ok()?;
    let blob: Value = serde_json::from_str(&text).ok()?;
    let token = blob
        .get("token")
        .and_then(|t| t.get("access_token"))
        .and_then(Value::as_str)?
        .trim();
    if token.is_empty() {
        None
    } else {
        Some(AgyCredentials {
            access_token: token.to_string(),
        })
    }
}

fn fetch_usage_with_token(token: &str) -> ClaudeUsageFetch {
    let client = http_client();
    let result = client
        .get(OAUTH_USAGE_URL)
        .set("Authorization", &format!("Bearer {token}"))
        .set("anthropic-beta", OAUTH_BETA)
        .set("User-Agent", USER_AGENT)
        .call();

    match result {
        Ok(response) => {
            let http_status = response.status();
            let body = response.into_string().unwrap_or_default();
            if (200..300).contains(&http_status) {
                usage_result("ok", Some(http_status), Some(body), None)
            } else {
                usage_error(http_status)
            }
        }
        Err(ureq::Error::Status(status, response)) => {
            let _ = response.into_string();
            usage_error(status)
        }
        Err(error) => usage_result(
            "error",
            None,
            None,
            Some(format!("Claude usage request failed: {error}")),
        ),
    }
}

fn usage_error(status: u16) -> ClaudeUsageFetch {
    let message = if status == 401 {
        "Claude sign-in expired".into()
    } else if status == 403 {
        "Claude usage is unavailable for this account".into()
    } else {
        format!("Claude usage request failed ({status})")
    };
    usage_result("error", Some(status), None, Some(message))
}

fn read_claude_credentials() -> Option<ClaudeCredentials> {
    #[cfg(target_os = "macos")]
    {
        if let Some(creds) = read_macos_keychain_credentials() {
            return Some(creds);
        }
    }
    read_credentials_file()
}

fn read_credentials_file() -> Option<ClaudeCredentials> {
    let path = claude_credentials_path()?;
    let raw = std::fs::read_to_string(&path).ok()?;
    credentials_from_blob(&raw)
}

fn claude_credentials_path() -> Option<PathBuf> {
    let home = dirs_home().or_else(|| {
        std::env::var_os("USERPROFILE").map(|value| value.to_string_lossy().into_owned())
    })?;
    Some(PathBuf::from(home).join(".claude/.credentials.json"))
}

fn credentials_from_blob(raw: &str) -> Option<ClaudeCredentials> {
    let blob: Value = serde_json::from_str(raw.trim()).ok()?;
    let access_token = extract_access_token(raw)?;
    Some(ClaudeCredentials {
        access_token,
        expires_at_ms: oauth_expires_at_ms(&blob),
    })
}

pub(crate) fn extract_access_token(raw: &str) -> Option<String> {
    let value: Value = serde_json::from_str(raw.trim()).ok()?;
    let token = value
        .get("claudeAiOauth")
        .and_then(|oauth| oauth.get("accessToken"))
        .or_else(|| value.get("accessToken"))
        .and_then(Value::as_str)?
        .trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

fn oauth_expires_at_ms(blob: &Value) -> Option<i64> {
    let value = blob
        .get("claudeAiOauth")
        .and_then(|oauth| oauth.get("expiresAt"))
        .or_else(|| blob.get("expiresAt"))?;
    match value {
        Value::Number(number) => number.as_i64().or_else(|| {
            number.as_f64().and_then(|float| {
                if float.is_finite() {
                    Some(float as i64)
                } else {
                    None
                }
            })
        }),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

/// An unknown expiry is treated as usable: the usage request itself will 401
/// if it is not, which produces the same user-facing result without mutating
/// credentials owned by another process.
pub(crate) fn token_expired(expires_at_ms: Option<i64>, now_ms: i64) -> bool {
    expires_at_ms.is_some_and(|expires| now_ms >= expires)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(target_os = "macos")]
fn read_macos_keychain_credentials() -> Option<ClaudeCredentials> {
    let candidates = [
        {
            let mut args = keychain_find_args();
            args.push("-w".into());
            args
        },
        {
            let mut args = keychain_find_args();
            args.extend(["-a".into(), keychain_user(), "-w".into()]);
            args
        },
        {
            let mut args = keychain_find_args();
            args.extend(["-a".into(), KEYCHAIN_FALLBACK_USER.into(), "-w".into()]);
            args
        },
    ];
    for args in candidates {
        if let Some(secret) = security_output(&args) {
            if let Some(creds) = credentials_from_blob(&secret) {
                return Some(creds);
            }
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn keychain_find_args() -> Vec<String> {
    vec![
        "find-generic-password".into(),
        "-s".into(),
        LEGACY_KEYCHAIN_SERVICE.into(),
    ]
}

#[cfg(target_os = "macos")]
fn keychain_user() -> String {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("USERNAME"))
        .unwrap_or_default();
    if user
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-'))
        && !user.is_empty()
    {
        user
    } else {
        KEYCHAIN_FALLBACK_USER.into()
    }
}

#[cfg(target_os = "macos")]
fn security_output(args: &[String]) -> Option<String> {
    security_run(args)
}

#[cfg(target_os = "macos")]
fn security_run(args: &[String]) -> Option<String> {
    use std::process::{Command, Stdio};
    let mut cmd = Command::new("security");
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    run_with_timeout(&mut cmd, KEYCHAIN_TIMEOUT)
}

#[cfg(target_os = "macos")]
fn run_with_timeout(cmd: &mut std::process::Command, timeout: Duration) -> Option<String> {
    use std::io::Read;
    use std::time::Instant;
    let mut child = cmd.spawn().ok()?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut stdout = child.stdout.take()?;
                let mut out = String::new();
                stdout.read_to_string(&mut out).ok()?;
                let trimmed = out.trim();
                if trimmed.is_empty() {
                    return None;
                }
                return Some(trimmed.to_string());
            }
            Ok(None) if started.elapsed() > timeout => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(40)),
            Err(_) => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_access_token_from_claude_credentials() {
        let raw = r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat-abc","refreshToken":"r"}}"#;
        assert_eq!(extract_access_token(raw).as_deref(), Some("sk-ant-oat-abc"));
    }

    #[test]
    fn extract_access_token_from_flat_object() {
        assert_eq!(
            extract_access_token(r#"{"accessToken":"token-1"}"#).as_deref(),
            Some("token-1")
        );
    }

    #[test]
    fn extract_access_token_rejects_empty() {
        assert_eq!(
            extract_access_token(r#"{"claudeAiOauth":{"accessToken":"  "}}"#),
            None
        );
        assert_eq!(extract_access_token("not json"), None);
    }

    #[test]
    fn token_expired_uses_actual_expiry() {
        let now = 1_000_000;
        assert!(!token_expired(Some(now + 1), now));
        assert!(token_expired(Some(now), now));
        assert!(token_expired(Some(now - 1), now));
        assert!(!token_expired(None, now));
    }

    #[test]
    fn extract_cmd_api_key_reads_key() {
        let raw = r#"{"apiKey":"user_123456","userName":"alice"}"#;
        assert_eq!(extract_cmd_api_key(raw).as_deref(), Some("user_123456"));
    }

    #[test]
    fn extract_cmd_api_key_rejects_empty() {
        let raw = r#"{"apiKey":"  ","userName":"alice"}"#;
        assert_eq!(extract_cmd_api_key(raw), None);
        assert_eq!(extract_cmd_api_key("not json"), None);
    }

    #[test]
    fn extract_agy_token_reads_base64_payload() {
        use base64::prelude::*;
        let payload = r#"{"token":{"access_token":"ya29.test12345"}}"#;
        let b64 = BASE64_STANDARD.encode(payload);
        let with_prefix = format!("go-keyring-base64:{b64}");
        assert_eq!(
            extract_agy_token(&with_prefix).map(|c| c.access_token),
            Some("ya29.test12345".to_string())
        );
    }

    #[test]
    fn extract_agy_token_rejects_invalid() {
        assert!(extract_agy_token("not base64").is_none());
        assert!(extract_agy_token("go-keyring-base64:not-valid").is_none());
    }
}
