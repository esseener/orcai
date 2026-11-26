use crate::config;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Default warning line: 1.75 GiB of resident memory. `ORZIC_FUSION_MEM_WARN_MB`
/// overrides it for tests and for users who want a different line.
const DEFAULT_WARN_MIB: u64 = 1792;
const DEFAULT_RESET_MIB: u64 = 1536;
/// Samples older than this are dropped when read. Writers refresh every few
/// seconds; a stale entry means the process or session is gone.
const SAMPLE_TTL_MS: u64 = 30_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub agent: String,
    pub session_id: String,
    pub pid: u32,
    #[serde(default)]
    pub started_at: u64,
    pub rss_bytes: u64,
    pub sampled_at: u64,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub phase: String,
    #[serde(default)]
    pub task: String,
    #[serde(default)]
    pub alerted: bool,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn state_path() -> PathBuf {
    config::omp_agent_dir().join("orzic-fusion-memory.json")
}

fn file_lock() -> &'static Mutex<()> {
    static LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
    &LOCK
}

fn mib(value: u64) -> u64 {
    value.saturating_mul(1024 * 1024)
}

fn env_mib(key: &str, fallback: u64) -> u64 {
    env::var(key)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

pub fn warn_bytes() -> u64 {
    mib(env_mib("ORZIC_FUSION_MEM_WARN_MB", DEFAULT_WARN_MIB))
}

pub fn reset_bytes() -> u64 {
    let warn = warn_bytes();
    let reset = mib(env_mib("ORZIC_FUSION_MEM_RESET_MB", DEFAULT_RESET_MIB));
    reset.min(warn)
}

fn load() -> Vec<Sample> {
    fs::read_to_string(state_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| value.get("samples").cloned())
        .and_then(|value| serde_json::from_value::<Vec<Sample>>(value).ok())
        .unwrap_or_default()
}

fn save(samples: &[Sample]) -> Result<(), String> {
    let text = serde_json::to_string_pretty(&json!({ "samples": samples }))
        .map_err(|e| e.to_string())?;
    config::write_text_atomic(&state_path(), &format!("{text}\n"), None)
}

fn prune(samples: Vec<Sample>, now: u64) -> Vec<Sample> {
    samples
        .into_iter()
        .filter(|sample| now.saturating_sub(sample.sampled_at) <= SAMPLE_TTL_MS)
        .filter(sample_identity_ok)
        .collect()
}

/// A sample only stays visible while the exact process that produced it is
/// still alive. `startedAt` guards against a reused PID.
fn sample_identity_ok(sample: &Sample) -> bool {
    if sample.pid == 0 {
        return true;
    }
    if !process_alive(sample.pid) {
        return false;
    }
    if sample.started_at != 0 {
        let started = started_at_for_pid(sample.pid);
        if started != 0 && started != sample.started_at {
            return false;
        }
    }
    true
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use win::*;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(not(windows))]
fn process_alive(_pid: u32) -> bool {
    true
}

fn upsert(samples: &mut Vec<Sample>, sample: Sample) {
    if let Some(existing) = samples
        .iter_mut()
        .find(|item| item.agent == sample.agent && item.pid == sample.pid)
    {
        *existing = sample;
    } else {
        samples.push(sample);
    }
}

/// Returns true when this sample crosses the warning line for the first time.
fn next_alert(was_alerted: bool, rss_bytes: u64, warn: u64, reset: u64) -> bool {
    if was_alerted {
        false
    } else {
        rss_bytes >= warn && rss_bytes > reset
    }
}

fn publish(mut sample: Sample) -> Result<bool, String> {
    let _guard = file_lock().lock().map_err(|_| "内存样本锁失败".to_string())?;
    let now = sample.sampled_at;
    let warn = warn_bytes();
    let reset = reset_bytes();
    let mut samples = prune(load(), now);
    let previous = samples
        .iter()
        .find(|item| item.agent == sample.agent && item.pid == sample.pid)
        .cloned()
        .unwrap_or_default();

    let was_alerted = previous.alerted && sample.rss_bytes > reset;
    let crossed = next_alert(previous.alerted, sample.rss_bytes, warn, reset);
    sample.alerted = was_alerted || crossed;
    if sample.cwd.is_empty() {
        sample.cwd = previous.cwd;
    }
    if sample.phase.is_empty() {
        sample.phase = previous.phase;
    }
    if sample.task.is_empty() {
        sample.task = previous.task;
    }
    if sample.note.is_empty() {
        sample.note = previous.note;
    }
    if sample.started_at == 0 {
        sample.started_at = previous.started_at;
    }
    upsert(&mut samples, sample);
    save(&samples)?;
    Ok(crossed)
}

/// Current samples plus the thresholds. Expired samples are dropped first.
pub fn list() -> Value {
    let now = now_ms();
    let samples = prune(load(), now);
    json!({
        "thresholdBytes": warn_bytes(),
        "resetBytes": reset_bytes(),
        "sampledAt": now,
        "samples": samples,
    })
}

pub fn clear(agent: &str, pid: u32) {
    let Ok(_guard) = file_lock().lock() else {
        return;
    };
    let now = now_ms();
    let mut samples = prune(load(), now);
    samples.retain(|sample| !(sample.agent == agent && sample.pid == pid));
    let _ = save(&samples);
}

/// Sample the current resident size of `pid`.
#[cfg(windows)]
pub fn rss_for_pid(pid: u32) -> Result<u64, String> {
    use win::*;
    if pid == 0 {
        return Err("进程 ID 无效".into());
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, 0, pid);
        if handle == 0 {
            return Err(format!("无法打开进程 {pid} 读取内存"));
        }
        let mut counters: ProcessMemoryCounters = std::mem::zeroed();
        counters.cb = std::mem::size_of::<ProcessMemoryCounters>() as u32;
        let ok = K32GetProcessMemoryInfo(
            handle,
            &mut counters as *mut _,
            counters.cb,
        );
        CloseHandle(handle);
        if ok == 0 {
            return Err(format!("无法读取进程 {pid} 的内存计数"));
        }
        Ok(counters.working_set_size as u64)
    }
}

#[cfg(not(windows))]
pub fn rss_for_pid(_pid: u32) -> Result<u64, String> {
    Err("当前平台不支持进程内存采样".into())
}

/// Process creation time in Unix milliseconds; used to tell a reused PID apart.
#[cfg(windows)]
pub fn started_at_for_pid(pid: u32) -> u64 {
    use win::*;
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle == 0 {
            return 0;
        }
        let mut creation: FileTime = std::mem::zeroed();
        let mut exit: FileTime = std::mem::zeroed();
        let mut kernel: FileTime = std::mem::zeroed();
        let mut user: FileTime = std::mem::zeroed();
        let ok = GetProcessTimes(
            handle,
            &mut creation,
            &mut exit,
            &mut kernel,
            &mut user,
        );
        CloseHandle(handle);
        if ok == 0 {
            return 0;
        }
        let ticks = ((creation.high as u64) << 32) | creation.low as u64;
        ticks / 10_000 - 11_644_473_600_000
    }
}

#[cfg(not(windows))]
pub fn started_at_for_pid(_pid: u32) -> u64 {
    0
}

fn sample_for_pid(
    agent: &str,
    label: &str,
    pid: u32,
    cwd: &str,
    phase: &str,
    task: &str,
    scope: &str,
    note: &str,
) -> Result<Sample, String> {
    Ok(Sample {
        agent: agent.to_string(),
        session_id: label.to_string(),
        pid,
        started_at: started_at_for_pid(pid),
        rss_bytes: rss_for_pid(pid)?,
        sampled_at: now_ms(),
        scope: scope.to_string(),
        note: note.to_string(),
        cwd: cwd.to_string(),
        phase: phase.to_string(),
        task: task.to_string(),
        alerted: false,
    })
}

/// Records one sample for a process owned by Fusion (OpenCode or Codex run).
pub fn report_pid(
    agent: &str,
    label: &str,
    pid: u32,
    cwd: &str,
    phase: &str,
    task: &str,
    scope: &str,
    note: &str,
) -> Result<bool, String> {
    let sample = sample_for_pid(agent, label, pid, cwd, phase, task, scope, note)?;
    publish(sample)
}

fn parse_body(body: &Value) -> Result<Sample, String> {
    let agent = body
        .get("agent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("缺少 agent")?;
    let pid = body.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
    if pid == 0 {
        return Err("缺少 pid".into());
    }
    let explicit_rss = body.get("rssBytes").and_then(Value::as_u64);
    let rss = match explicit_rss {
        Some(value) if value > 0 => value,
        _ => rss_for_pid(pid)?,
    };
    let label = body
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| if agent == "omp" { "omp" } else { "run" });
    Ok(Sample {
        agent: agent.to_string(),
        session_id: label.to_string(),
        pid,
        started_at: started_at_for_pid(pid),
        rss_bytes: rss,
        sampled_at: now_ms(),
        scope: body
            .get("scope")
            .and_then(Value::as_str)
            .unwrap_or(if agent == "omp" { "process" } else { "run" })
            .to_string(),
        note: body.get("note").and_then(Value::as_str).unwrap_or("").to_string(),
        cwd: body.get("cwd").and_then(Value::as_str).unwrap_or("").to_string(),
        phase: body.get("phase").and_then(Value::as_str).unwrap_or("").to_string(),
        task: body.get("task").and_then(Value::as_str).unwrap_or("").to_string(),
        alerted: false,
    })
}

/// `mem-report` CLI used by the OMP extension: reads a JSON body, records one
/// sample for a process Fusion can identify, and reports whether the warning
/// line was crossed for the first time.
pub fn cli(body: &Value) -> Result<Value, String> {
    let agent = body
        .get("agent")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("缺少 agent")?;
    let pid = body.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32;
    if pid == 0 {
        return Err("缺少 pid".into());
    }
    if body.get("clear").and_then(Value::as_bool) == Some(true) {
        clear(agent, pid);
        return Ok(json!({ "cleared": true }));
    }
    let sample = parse_body(body)?;
    let rss = sample.rss_bytes;
    let crossed = publish(sample)?;
    Ok(json!({
        "recorded": true,
        "alert": crossed,
        "rssBytes": rss,
        "thresholdBytes": warn_bytes(),
        "resetBytes": reset_bytes(),
        "sampledAt": now_ms(),
    }))
}

/// Samples a process owned by this console run every two seconds and clears
/// its entry when dropped. Labels and paths describe that specific run.
pub struct Track {
    stop: Arc<AtomicBool>,
    agent: String,
    pid: u32,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Track {
    pub fn start(
        agent: &str,
        label: String,
        pid: u32,
        cwd: String,
        phase: &str,
        task: &str,
        scope: &str,
        note: &str,
    ) -> Track {
        let stop = Arc::new(AtomicBool::new(false));
        if pid == 0 {
            return Track {
                stop,
                agent: agent.to_string(),
                pid,
                handle: None,
            };
        }
        let thread_stop = Arc::clone(&stop);
        let agent_owned = agent.to_string();
        let phase_owned = phase.to_string();
        let task_owned = task.to_string();
        let scope_owned = scope.to_string();
        let note_owned = note.to_string();
        let handle = std::thread::spawn(move || {
            while !thread_stop.load(Ordering::Relaxed) {
                let _ = report_pid(
                    &agent_owned,
                    &label,
                    pid,
                    &cwd,
                    &phase_owned,
                    &task_owned,
                    &scope_owned,
                    &note_owned,
                );
                for _ in 0..8 {
                    if thread_stop.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        });
        Track {
            stop,
            agent: agent.to_string(),
            pid,
            handle: Some(handle),
        }
    }
}

impl Drop for Track {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
        clear(&self.agent, self.pid);
    }
}

#[cfg(windows)]
mod win {
    pub const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    pub const PROCESS_VM_READ: u32 = 0x0010;

    #[repr(C)]
    pub struct ProcessMemoryCounters {
        pub cb: u32,
        pub page_fault_count: u32,
        pub peak_working_set_size: usize,
        pub working_set_size: usize,
        pub quota_peak_paged_pool_usage: usize,
        pub quota_paged_pool_usage: usize,
        pub quota_peak_non_paged_pool_usage: usize,
        pub quota_non_paged_pool_usage: usize,
        pub pagefile_usage: usize,
        pub peak_pagefile_usage: usize,
    }

    #[repr(C)]
    pub struct FileTime {
        pub low: u32,
        pub high: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        pub fn OpenProcess(access: u32, inherit: i32, pid: u32) -> isize;
        pub fn CloseHandle(handle: isize) -> i32;
        pub fn K32GetProcessMemoryInfo(
            process: isize,
            counters: *mut ProcessMemoryCounters,
            size: u32,
        ) -> i32;
        pub fn GetProcessTimes(
            process: isize,
            creation: *mut FileTime,
            exit: *mut FileTime,
            kernel: *mut FileTime,
            user: *mut FileTime,
        ) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_warns_once_until_reset() {
        let warn = 1000;
        let reset = 800;
        assert!(!next_alert(false, 999, warn, reset));
        assert!(next_alert(false, 1000, warn, reset));
        assert!(!next_alert(true, 1200, warn, reset));
        assert!(!next_alert(true, 700, warn, reset));
        // After the reset the next crossing is a new alert.
        assert!(next_alert(false, 1000, warn, reset));
    }

    #[test]
    fn prune_drops_stale_samples() {
        let now = 100_000;
        let fresh = Sample {
            agent: "omp".into(),
            sampled_at: now - 1_000,
            ..Sample::default()
        };
        let stale = Sample {
            agent: "omp".into(),
            sampled_at: now - SAMPLE_TTL_MS - 1,
            ..Sample::default()
        };
        let kept = prune(vec![fresh, stale], now);
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].sampled_at, now - 1_000);
    }

    #[test]
    fn upsert_replaces_the_same_process() {
        let mut samples = Vec::new();
        upsert(
            &mut samples,
            Sample {
                agent: "omp".into(),
                pid: 7,
                rss_bytes: 10,
                sampled_at: 1,
                ..Sample::default()
            },
        );
        upsert(
            &mut samples,
            Sample {
                agent: "omp".into(),
                pid: 7,
                rss_bytes: 20,
                sampled_at: 2,
                ..Sample::default()
            },
        );
        assert_eq!(samples.len(), 1);
        assert_eq!(samples[0].rss_bytes, 20);
    }
}
