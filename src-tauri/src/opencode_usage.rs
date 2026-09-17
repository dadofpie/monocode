use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::OpenFlags;
use serde::Serialize;

use crate::dirs_home;

/// Token + cost totals for one rolling window.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeUsageTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub cost: f64,
    pub messages: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeModelUsage {
    pub model: String,
    pub provider: String,
    pub tokens: u64,
    pub cost: f64,
    pub messages: u64,
}

/// Cross-session usage aggregated from the local OpenCode database.
/// OpenCode Go exposes no billing endpoint, so this is computed from the
/// token reports stored with every assistant message.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeUsageSummary {
    pub available: bool,
    pub day: OpencodeUsageTotals,
    pub week: OpencodeUsageTotals,
    pub month: OpencodeUsageTotals,
    pub sessions_30d: u64,
    pub top_models: Vec<OpencodeModelUsage>,
    pub updated_at_ms: i64,
}

const DAY_MS: i64 = 24 * 3_600_000;
const WEEK_MS: i64 = 7 * DAY_MS;
const MONTH_MS: i64 = 30 * DAY_MS;
const QUERY_MARGIN_MS: i64 = DAY_MS;
const TOP_MODELS: usize = 5;

fn as_u64(value: &serde_json::Value) -> u64 {
    if let Some(n) = value.as_u64() {
        return n;
    }
    value.as_f64().map(|n| n.max(0.0) as u64).unwrap_or(0)
}

fn as_f64(value: &serde_json::Value) -> f64 {
    if let Some(n) = value.as_f64() {
        return if n.is_finite() && n > 0.0 { n } else { 0.0 };
    }
    0.0
}

fn str_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("unknown")
        .to_string()
}

#[derive(Default)]
struct ModelAcc {
    tokens: u64,
    cost: f64,
    messages: u64,
    provider: String,
}

/// Aggregate assistant-message token reports into rolling windows.
/// `rows` are `(session_id, time_created_ms, message_data_json)`.
/// Only assistant messages count; anything else (user, compaction summaries
/// stored as system notes, malformed rows) is skipped.
pub(crate) fn summarize_messages(
    now_ms: i64,
    rows: Vec<(String, i64, String)>,
) -> OpencodeUsageSummary {
    let mut day = OpencodeUsageTotals::default();
    let mut week = OpencodeUsageTotals::default();
    let mut month = OpencodeUsageTotals::default();
    let mut sessions: HashSet<String> = HashSet::new();
    let mut models: HashMap<String, ModelAcc> = HashMap::new();

    for (session_id, time_created, data) in &rows {
        let age = now_ms.saturating_sub(*time_created);
        if age > MONTH_MS {
            continue;
        }
        let value: serde_json::Value = match serde_json::from_str(data) {
            Ok(value) => value,
            Err(_) => continue,
        };
        if value.get("role").and_then(serde_json::Value::as_str) != Some("assistant") {
            continue;
        }
        let tokens = value.get("tokens");
        let cache = tokens.and_then(|t| t.get("cache"));
        let input = tokens
            .map(|t| t.get("input").map(as_u64).unwrap_or(0))
            .unwrap_or(0);
        let output = tokens
            .map(|t| {
                t.get("output").map(as_u64).unwrap_or(0)
                    + t.get("reasoning").map(as_u64).unwrap_or(0)
            })
            .unwrap_or(0);
        let cache_read = cache
            .map(|c| c.get("read").map(as_u64).unwrap_or(0))
            .unwrap_or(0);
        let cache_write = cache
            .map(|c| c.get("write").map(as_u64).unwrap_or(0))
            .unwrap_or(0);
        let cost = value.get("cost").map(as_f64).unwrap_or(0.0);

        let add = |totals: &mut OpencodeUsageTotals| {
            totals.input += input;
            totals.output += output;
            totals.cache_read += cache_read;
            totals.cache_write += cache_write;
            totals.cost += cost;
            totals.messages += 1;
        };
        add(&mut month);
        if age <= WEEK_MS {
            add(&mut week);
        }
        if age <= DAY_MS {
            add(&mut day);
        }
        sessions.insert(session_id.clone());

        let model = str_field(&value, "modelID");
        let entry = models.entry(model).or_default();
        entry.tokens += input + output + cache_read + cache_write;
        entry.cost += cost;
        entry.messages += 1;
        if entry.provider == "unknown" {
            entry.provider = str_field(&value, "providerID");
        }
    }

    let mut top_models: Vec<OpencodeModelUsage> = models
        .into_iter()
        .map(|(model, acc)| OpencodeModelUsage {
            model,
            provider: if acc.provider.is_empty() {
                "unknown".into()
            } else {
                acc.provider
            },
            tokens: acc.tokens,
            cost: acc.cost,
            messages: acc.messages,
        })
        .collect();
    top_models.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(a.model.cmp(&b.model)));
    top_models.truncate(TOP_MODELS);

    OpencodeUsageSummary {
        available: true,
        day,
        week,
        month,
        sessions_30d: sessions.len() as u64,
        top_models,
        updated_at_ms: now_ms,
    }
}

fn unavailable() -> OpencodeUsageSummary {
    OpencodeUsageSummary {
        available: false,
        day: OpencodeUsageTotals::default(),
        week: OpencodeUsageTotals::default(),
        month: OpencodeUsageTotals::default(),
        sessions_30d: 0,
        top_models: Vec::new(),
        updated_at_ms: 0,
    }
}

pub(crate) fn opencode_db_path(home: &Path) -> PathBuf {
    home.join(".local/share/opencode/opencode.db")
}

fn read_usage_rows(db_path: &Path, cutoff_ms: i64) -> Vec<(String, i64, String)> {
    let connection =
        match rusqlite::Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(connection) => connection,
            Err(_) => return Vec::new(),
        };
    // The CLI may be writing (WAL mode); wait briefly instead of failing.
    let _ = connection.pragma_update(None, "busy_timeout", 2000);
    let mut statement = match connection
        .prepare("SELECT session_id, time_created, data FROM message WHERE time_created >= ?1")
    {
        Ok(statement) => statement,
        Err(_) => return Vec::new(),
    };
    let rows = match statement.query_map([cutoff_ms], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) {
        Ok(rows) => rows,
        Err(_) => return Vec::new(),
    };
    rows.flatten().collect()
}

fn fetch_opencode_usage_sync() -> OpencodeUsageSummary {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let Some(home) = dirs_home() else {
        return unavailable();
    };
    let db_path = opencode_db_path(&PathBuf::from(&home));
    if !db_path.is_file() {
        return unavailable();
    }
    let rows = read_usage_rows(&db_path, now_ms - MONTH_MS - QUERY_MARGIN_MS);
    if rows.is_empty() {
        return unavailable();
    }
    summarize_messages(now_ms, rows)
}

/// Cross-session OpenCode usage (rolling 24h / 7d / 30d) aggregated from the
/// local database. Token counts only, never credentials.
#[tauri::command]
pub async fn fetch_opencode_usage_summary() -> Result<OpencodeUsageSummary, String> {
    let summary = tauri::async_runtime::spawn_blocking(fetch_opencode_usage_sync)
        .await
        .map_err(|e| e.to_string())?;
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assistant_msg(model: &str, input: u64, output: u64, cost: f64) -> String {
        format!(
            r#"{{"role":"assistant","modelID":"{model}","providerID":"opencode","cost":{cost},"tokens":{{"input":{input},"output":{output},"reasoning":0,"cache":{{"read":0,"write":0}}}}}}"#
        )
    }

    #[test]
    fn buckets_messages_into_rolling_windows() {
        let now = 1_789_000_000_000i64;
        let rows = vec![
            (
                "s1".into(),
                now - 1_000,
                assistant_msg("m-a", 100, 10, 0.01),
            ),
            (
                "s1".into(),
                now - 2 * DAY_MS,
                assistant_msg("m-a", 200, 20, 0.02),
            ),
            (
                "s2".into(),
                now - 10 * DAY_MS,
                assistant_msg("m-b", 400, 40, 0.04),
            ),
            (
                "s3".into(),
                now - 40 * DAY_MS,
                assistant_msg("m-b", 800, 80, 0.08),
            ),
            (
                "s4".into(),
                now - 1_000,
                r#"{"role":"user","text":"hi"}"#.into(),
            ),
            ("s5".into(), now - 1_000, "not json".into()),
        ];
        let summary = summarize_messages(now, rows);
        assert!(summary.available);
        assert_eq!(summary.day.messages, 1);
        assert_eq!(summary.day.input, 100);
        assert_eq!(summary.week.messages, 2);
        assert_eq!(summary.week.input, 300);
        assert_eq!(summary.month.messages, 3);
        assert_eq!(summary.month.input, 700);
        assert!((summary.month.cost - 0.07).abs() < 1e-9);
        assert_eq!(summary.sessions_30d, 2);
        assert_eq!(summary.top_models.len(), 2);
        assert_eq!(summary.top_models[0].model, "m-b");
        assert_eq!(summary.top_models[0].tokens, 440);
    }

    #[test]
    fn empty_history_reports_zero_totals() {
        let summary = summarize_messages(1000, Vec::new());
        assert!(summary.available);
        assert_eq!(summary.month.messages, 0);
        assert_eq!(summary.sessions_30d, 0);
        assert!(summary.top_models.is_empty());
    }

    #[test]
    fn temp_db_round_trip() {
        let dir =
            std::env::temp_dir().join(format!("monocode-opencode-usage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("opencode.db");
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap();
        {
            let db = rusqlite::Connection::open(&db_path).unwrap();
            db.execute_batch(
                "CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)",
            )
            .unwrap();
            db.execute(
                "INSERT INTO message VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    "m1",
                    "s1",
                    now_ms - 1000,
                    now_ms - 1000,
                    assistant_msg("m-a", 50, 5, 0.0)
                ],
            )
            .unwrap();
        }
        let rows = read_usage_rows(&db_path, now_ms - MONTH_MS - QUERY_MARGIN_MS);
        assert_eq!(rows.len(), 1);
        let summary = summarize_messages(now_ms, rows);
        assert!(summary.available);
        assert_eq!(summary.day.input, 50);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
