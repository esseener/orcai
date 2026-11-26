//! `omp` launcher for `/gogo`.
//!
//! Runs the real omp in this terminal's console and waits for it. When omp
//! exits after a confirmed save it leaves `.omp/gogo-restart.json` carrying the
//! token of this launch; the launcher consumes that marker and starts a fresh
//! omp in the same console with the continuation message. A normal exit
//! (`Ctrl+D`, `/exit`) leaves no marker, so the launcher returns to the shell.
//!
//! Arguments are forwarded verbatim from `GetCommandLineW`, so JSON values and
//! quoted paths reach omp unchanged — a `cmd`/PowerShell wrapper cannot promise
//! that.

use serde::Deserialize;
use std::ffi::OsString;
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

#[link(name = "kernel32")]
extern "system" {
    fn GetCommandLineW() -> *const u16;
    fn SetConsoleCtrlHandler(
        handler: Option<unsafe extern "system" fn(u32) -> i32>,
        add: i32,
    ) -> i32;
}

/// Ctrl+C belongs to omp; the launcher only observes its exit code.
unsafe extern "system" fn ignore_ctrl_event(_kind: u32) -> i32 {
    1
}

#[derive(Deserialize)]
struct Marker {
    #[serde(default)]
    run: String,
    #[serde(default)]
    cwd: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    at: u64,
}

const MARKER_TTL_MS: u64 = 30 * 60 * 1000;
const FALLBACK_MESSAGE: &str = "接着上一个会话继续";

/// Small, always-on breadcrumb: the only place that knows whether a launch
/// ended with a marker and whether the relaunch was taken.
fn trace(line: &str) {
    let Some(temp) = std::env::var_os("TEMP") else { return };
    let path = PathBuf::from(temp).join("orzic-launcher.log");
    if std::fs::metadata(&path).map(|m| m.len() > 262_144).unwrap_or(false) {
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        use std::io::Write;
        let _ = writeln!(file, "{} {}", now_ms(), line);
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_token() -> String {
    format!("{:x}{:x}", now_ms(), std::process::id())
}

/// The command line minus the program token, exactly as typed.
fn command_line_tail() -> OsString {
    let raw = unsafe { GetCommandLineW() };
    if raw.is_null() {
        return OsString::new();
    }
    let mut len = 0usize;
    unsafe {
        while *raw.add(len) != 0 {
            len += 1;
        }
    }
    let units = unsafe { std::slice::from_raw_parts(raw, len) };
    let text = String::from_utf16_lossy(units);
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0usize;
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    if i < chars.len() && chars[i] == '"' {
        i += 1;
        while i < chars.len() && chars[i] != '"' {
            i += 1;
        }
        i += 1;
    } else {
        while i < chars.len() && !chars[i].is_whitespace() {
            i += 1;
        }
    }
    OsString::from(chars[i..].iter().collect::<String>().trim_start())
}

fn path_contains_launcher(dir: &Path) -> bool {
    dir.join("omp-launcher.exe").is_file()
}

fn resolve_omp() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("ORZIC_OMP_EXE") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(path);
        }
    }
    let self_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf));
    if let Some(home) = std::env::var_os("USERPROFILE") {
        let candidate = PathBuf::from(home).join(".bun").join("bin").join("omp.exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let candidate = PathBuf::from(local)
            .join("Microsoft")
            .join("WindowsApps")
            .join("omp.exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if Some(&dir) == self_dir.as_ref() || path_contains_launcher(&dir) {
                continue;
            }
            let candidate = dir.join("omp.exe");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err("omp.exe not found; set ORZIC_OMP_EXE to its full path".to_string())
}

fn read_marker(path: &Path) -> Option<Marker> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn same_dir(a: &str, b: &str) -> bool {
    let left = a.trim_end_matches(['\\', '/']);
    let right = b.trim_end_matches(['\\', '/']);
    left.eq_ignore_ascii_case(right)
}

fn main() {
    unsafe {
        SetConsoleCtrlHandler(Some(ignore_ctrl_event), 1);
    }
    let omp = match resolve_omp() {
        Ok(path) => path,
        Err(message) => {
            eprintln!("Orzic Fusion: {message}");
            std::process::exit(127);
        }
    };
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cwd_text = cwd.to_string_lossy().to_string();
    let marker = cwd.join(".omp").join("gogo-restart.json");
    let mut tail = command_line_tail();

    loop {
        let token = new_token();
        let mut command = Command::new(&omp);
        if !tail.is_empty() {
            command.raw_arg(&tail);
        }
        trace(&format!("start omp={} cwd={} tail={}", omp.display(), cwd_text, tail.to_string_lossy()));
        let status = command
            .env("ORZIC_OMP_RUN", &token)
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status();
        let code = match status {
            Ok(status) => status.code().unwrap_or(1),
            Err(error) => {
                eprintln!("Orzic Fusion: cannot start {}: {error}", omp.display());
                std::process::exit(127);
            }
        };
        let Some(request) = read_marker(&marker) else {
            trace(&format!("exit code={code} no-marker"));
            std::process::exit(code);
        };
        let owned = !request.run.is_empty() && request.run == token;
        let fresh = request.at <= now_ms() && now_ms() - request.at < MARKER_TTL_MS;
        trace(&format!("marker owned={owned} fresh={fresh} cwd={}", request.cwd));
        if !owned || !fresh || !same_dir(&request.cwd, &cwd_text) {
            std::process::exit(code);
        }
        if let Err(error) = std::fs::remove_file(&marker) {
            eprintln!("Orzic Fusion: cannot consume {}: {error}", marker.display());
            std::process::exit(code);
        }
        trace("relaunch");
        tail = if request.message.trim().is_empty() {
            OsString::from(FALLBACK_MESSAGE)
        } else {
            OsString::from(request.message)
        };
    }
}
