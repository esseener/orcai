use crate::acceptance;
use crate::agents::{codex, omp, opencode};
use crate::connectors::{self, CustomTarget, SERVER_NAME};
use crate::memory;
use crate::state;
use serde_json::{json, Map, Value};
use std::collections::HashMap;

#[cfg(windows)]
#[path = "ui_window.rs"]
mod ui_window;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HTML_INDEX: &str = include_str!("ui/index.html");
const CSS_STYLE: &str = include_str!("ui/style.css");
const JS_APP: &str = include_str!("ui/app.js");
const LOGO_PNG: &[u8] = include_bytes!("ui/logo.png");
const FAVICON_PNG: &[u8] = include_bytes!("ui/favicon.png");

const CSP: &str = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'";

struct UiLifecycle {
    shutdown: AtomicBool,
    client_seen: AtomicBool,
    last_seen_ms: AtomicU64,
    closing_at_ms: AtomicU64,
}

impl UiLifecycle {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            shutdown: AtomicBool::new(false),
            client_seen: AtomicBool::new(false),
            last_seen_ms: AtomicU64::new(now_ms()),
            closing_at_ms: AtomicU64::new(0),
        })
    }

    fn touch(&self) {
        self.client_seen.store(true, Ordering::SeqCst);
        self.last_seen_ms.store(now_ms(), Ordering::SeqCst);
        self.closing_at_ms.store(0, Ordering::SeqCst);
    }

    fn mark_closing(&self) {
        self.closing_at_ms.store(now_ms(), Ordering::SeqCst);
    }

    fn should_exit(&self) -> bool {
        if self.shutdown.load(Ordering::SeqCst) {
            return true;
        }
        if !self.client_seen.load(Ordering::SeqCst) {
            return false;
        }
        let now = now_ms();
        let last = self.last_seen_ms.load(Ordering::SeqCst);
        let closing = self.closing_at_ms.load(Ordering::SeqCst);
        // A visible desktop window may be backgrounded or frozen by the
        // browser and stop sending heartbeats; only an explicit close beacon
        // or the shutdown button ends the console.
        closing > 0 && last <= closing && now.saturating_sub(closing) >= 2500
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn generate_token() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let stack_var: u8 = 0;
    let addr = (&stack_var as *const u8) as usize as u128;
    let mix1 = nanos
        .wrapping_mul(6364136223846793005)
        .wrapping_add(pid << 32);
    let mix2 = addr.wrapping_mul(1442695040888963407) ^ (nanos >> 17);
    format!("{mix1:016x}{mix2:016x}")
}

fn find_browser_exe() -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let candidates = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ];
    candidates
        .iter()
        .find(|path| PathBuf::from(path).exists())
        .map(|path| path.to_string())
}

#[cfg(windows)]
mod win_icon {
    use std::ptr;
    use std::thread;
    use std::time::Duration;

    const WM_SETICON: u32 = 0x0080;
    const ICON_SMALL: usize = 0;
    const ICON_BIG: usize = 1;
    const IMAGE_ICON: u32 = 1;
    const LR_SHARED: u32 = 0x8000;
    const APP_ICON_RESOURCE: usize = 1;
    const APP_WINDOW_TITLE: &str = "\u{200B}";
    // Windows 11 DWM attributes. The caption keeps its own colour while the
    // window is inactive unless we set it explicitly.
    const DWMWA_USE_IMMERSIVE_DARK_MODE: u32 = 20;
    const DWMWA_BORDER_COLOR: u32 = 34;
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;
    const COLOR_BLACK: u32 = 0x0000_0000;
    const COLOR_WHITE: u32 = 0x00FF_FFFF;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            attribute: u32,
            value: *const std::ffi::c_void,
            size: u32,
        ) -> i32;
    }

    #[link(name = "user32")]
    extern "system" {
        fn EnumWindows(callback: extern "system" fn(isize, isize) -> i32, lparam: isize) -> i32;
        fn GetWindowTextW(hwnd: isize, buffer: *mut u16, max: i32) -> i32;
        fn GetClassNameW(hwnd: isize, buffer: *mut u16, max: i32) -> i32;
        fn IsWindowVisible(hwnd: isize) -> i32;
        fn IsWindow(hwnd: isize) -> i32;
        fn SendMessageW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
        fn LoadImageW(
            instance: isize,
            name: *const u16,
            kind: u32,
            cx: i32,
            cy: i32,
            load: u32,
        ) -> isize;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetModuleHandleW(name: *const u16) -> isize;
    }

    extern "system" fn collect_window(hwnd: isize, lparam: isize) -> i32 {
        unsafe {
            (*(lparam as *mut Vec<isize>)).push(hwnd);
        }
        1
    }

    fn all_windows() -> Vec<isize> {
        let mut windows = Vec::new();
        unsafe {
            EnumWindows(collect_window, &mut windows as *mut _ as isize);
        }
        windows
    }

    fn window_text(hwnd: isize) -> String {
        let mut buffer = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..len as usize])
    }

    fn class_name(hwnd: isize) -> String {
        let mut buffer = [0u16; 256];
        let len = unsafe { GetClassNameW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
        if len <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buffer[..len as usize])
    }

    fn is_app_window(hwnd: isize) -> bool {
        (unsafe { IsWindowVisible(hwnd) != 0 })
            && class_name(hwnd).as_str() == "Chrome_WidgetWin_1"
            && window_text(hwnd).as_str() == APP_WINDOW_TITLE
    }

    pub fn app_windows() -> Vec<isize> {
        all_windows()
            .into_iter()
            .filter(|hwnd| is_app_window(*hwnd))
            .collect()
    }

    fn find_new_app_window(before: &[isize]) -> Option<isize> {
        all_windows()
            .into_iter()
            .find(|hwnd| !before.contains(hwnd) && is_app_window(*hwnd))
    }

    fn apply_icons(hwnd: isize) {
        unsafe {
            let instance = GetModuleHandleW(ptr::null());
            let big = LoadImageW(
                instance,
                APP_ICON_RESOURCE as *const u16,
                IMAGE_ICON,
                32,
                32,
                LR_SHARED,
            );
            if big == 0 {
                return;
            }
            // Taskbar reads ICON_BIG; leaving ICON_SMALL empty keeps the title bar blank.
            SendMessageW(hwnd, WM_SETICON, ICON_SMALL, 0);
            SendMessageW(hwnd, WM_SETICON, ICON_BIG, big);
        }
    }

    fn paint_frame(hwnd: isize) {
        unsafe {
            let dark: i32 = 1;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_USE_IMMERSIVE_DARK_MODE,
                &dark as *const i32 as *const std::ffi::c_void,
                std::mem::size_of::<i32>() as u32,
            );
            let caption: u32 = COLOR_BLACK;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_CAPTION_COLOR,
                &caption as *const u32 as *const std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                &caption as *const u32 as *const std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
            let text: u32 = COLOR_WHITE;
            let _ = DwmSetWindowAttribute(
                hwnd,
                DWMWA_TEXT_COLOR,
                &text as *const u32 as *const std::ffi::c_void,
                std::mem::size_of::<u32>() as u32,
            );
        }
    }

    pub fn attach_taskbar_icon(before: Vec<isize>) {
        thread::spawn(move || {
            let mut target = None;
            for _ in 0..120 {
                if let Some(hwnd) = find_new_app_window(&before) {
                    target = Some(hwnd);
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            let Some(hwnd) = target else {
                eprintln!("无法定位应用窗口，任务栏图标未替换");
                return;
            };
            // Let Edge finish creating its frame, then reapply once in case it resets.
            thread::sleep(Duration::from_millis(700));
            apply_icons(hwnd);
            paint_frame(hwnd);
            thread::sleep(Duration::from_millis(1200));
            apply_icons(hwnd);
            paint_frame(hwnd);
            // Edge can redraw its frame after activation changes; keep the
            // caption black while this window exists.
            while unsafe { IsWindow(hwnd) } != 0 {
                paint_frame(hwnd);
                thread::sleep(Duration::from_millis(2000));
            }
        });
    }
}

fn open_desktop_window(url: &str) {
    #[cfg(windows)]
    let before = win_icon::app_windows();

    if let Some(browser) = find_browser_exe() {
        let _ = Command::new(browser)
            .arg(format!("--app={url}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        #[cfg(windows)]
        win_icon::attach_taskbar_icon(before);
    } else if cfg!(windows) {
        let _ = Command::new("cmd")
            .args(["/c", "start", "", url])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }
}

fn send_http(stream: &mut TcpStream, status: &str, content_type: &str, body: &[u8]) {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: {CSP}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(body);
    let _ = stream.flush();
}

fn send_json(stream: &mut TcpStream, status: &str, value: &Value) {
    let text = serde_json::to_string(value).unwrap_or_else(|_| "{}".into());
    send_http(
        stream,
        status,
        "application/json; charset=utf-8",
        text.as_bytes(),
    );
}

fn is_loopback_origin(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("http://127.0.0.1:")
        || lower == "http://127.0.0.1"
        || lower.starts_with("http://localhost:")
        || lower == "http://localhost"
}

fn is_loopback_host(value: &str) -> bool {
    let lower = value.trim().to_ascii_lowercase();
    lower.starts_with("127.0.0.1:")
        || lower == "127.0.0.1"
        || lower.starts_with("localhost:")
        || lower == "localhost"
}

fn query_param<'a>(query: &'a str, key: &str) -> Option<&'a str> {
    query.split('&').find_map(|pair| {
        pair.split_once('=')
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| v)
    })
}

/// Lightweight catalog for the console: Fusion itself plus every MCP target.
/// Deliberately avoids reading OMP roles or the model catalog.
fn agents_payload() -> Value {
    json!({
        "fusion": {
            "version": env!("CARGO_PKG_VERSION"),
            "executable": connectors::current_exe_string(),
        },
        "connectors": connectors::list_all(),
    })
}

#[cfg(windows)]
fn window_action(action: &str) -> Result<(), String> {
    ui_window::window_action(action)
}

#[cfg(not(windows))]
fn window_action(_action: &str) -> Result<(), String> {
    Err("仅 Windows 桌面窗口支持该操作".into())
}

fn dispatch_api(
    method: &str,
    path: &str,
    query: &str,
    body: &Map<String, Value>,
    life: &Arc<UiLifecycle>,
) -> Option<Result<Value, String>> {
    match (method, path) {
        ("GET", "/api/state") => {
            life.touch();
            Some(Ok(state::build(false)))
        }
        ("GET", "/api/omp/status") => {
            life.touch();
            let force = query.contains("force=1");
            Some(Ok(omp::console_status(query.contains("fast=1"), force)))
        }
        ("GET", "/api/agents") => {
            life.touch();
            Some(Ok(agents_payload()))
        }
        ("GET", "/api/session-memory") => {
            life.touch();
            Some(Ok(memory::list()))
        }
        ("POST", "/api/heartbeat") => {
            life.touch();
            Some(Ok(json!({ "ok": true })))
        }
        ("POST", "/api/window") => {
            let action = body
                .get("action")
                .and_then(Value::as_str)
                .unwrap_or("");
            Some(window_action(action).map(|_| json!({ "ok": true })))
        }
        ("POST", "/api/closing") => {
            life.mark_closing();
            Some(Ok(json!({ "ok": true })))
        }
        ("GET", "/api/models") => {
            life.touch();
            let force = query.contains("force=1");
            Some(
                omp::list_models(force)
                    .map(|models| json!({ "models": models })),
            )
        }
        ("POST", "/api/save") => Some(omp::save(body).map(|_| state::build(false))),
        ("POST", "/api/opencode") => {
            life.touch();
            let cwd = body
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let force = body
                .get("force")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Some(Ok(opencode::status(&cwd, force)))
        }
        ("POST", "/api/opencode/save") => Some(opencode::save_roles(body)),
        ("POST", "/api/opencode/session") => Some(opencode::session_action(body)),
        ("POST", "/api/codex") => {
            life.touch();
            let cwd = body
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let force = body
                .get("force")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Some(Ok(codex::status(&cwd, force)))
        }
        ("POST", "/api/codex/save") => Some(codex::save_roles(body)),
        ("POST", "/api/codex/session") => Some(codex::session_action(body)),
        ("GET", "/api/acceptance") => Some(Ok(acceptance::last())),
        ("POST", "/api/acceptance/run") => {
            let cwd = body
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            Some(acceptance::run(&cwd))
        }
        ("POST", "/api/acceptance/auto") => Some((|| {
            let cwd = body
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            let enabled = body
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let rework = body
                .get("rework")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let all = acceptance::set_auto(&cwd, enabled, rework)?;
            Ok(json!({
                "auto": all,
                "settings": acceptance::auto_settings(&cwd),
            }))
        })()),
        ("POST", "/api/connectors/toggle") => {
            let id = body.get("id").and_then(Value::as_str).unwrap_or("");
            let enable = body
                .get("enable")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            Some(
                connectors::connect_target_by_id(id, enable).map(|_| agents_payload()),
            )
        }
        ("POST", "/api/connectors/custom") => Some((|| {
            let path = body
                .get("customPath")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .ok_or("请输入配置文件路径")?;
            let label = body
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .unwrap_or(path);
            let enable = body
                .get("enable")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            connectors::connect_to_path(
                &PathBuf::from(path),
                SERVER_NAME,
                &connectors::current_exe_string(),
                enable,
            )?;
            if enable {
                let slug: String = label
                    .chars()
                    .filter(|c| c.is_ascii_alphanumeric())
                    .collect::<String>()
                    .to_lowercase();
                connectors::save_custom_target(CustomTarget {
                    id: if slug.is_empty() {
                        format!("custom-{}", path.len())
                    } else {
                        format!("custom-{slug}")
                    },
                    label: label.to_string(),
                    config_path: path.to_string(),
                    server_name: SERVER_NAME.to_string(),
                })?;
            }
            Ok(agents_payload())
        })()),
        ("POST", "/api/connectors/remove-custom") => Some((|| {
            let id = body.get("id").and_then(Value::as_str).unwrap_or("");
            connectors::remove_custom_target(id)?;
            Ok(agents_payload())
        })()),
        ("POST", "/api/shutdown") => {
            life.shutdown.store(true, Ordering::SeqCst);
            Some(Ok(json!({ "ok": true })))
        }
        _ => None,
    }
}

fn handle_client(mut stream: TcpStream, token: &str, life: &Arc<UiLifecycle>) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(clone) => clone,
        Err(_) => return,
    });

    let mut request_line = String::new();
    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
        return;
    }
    let parts: Vec<&str> = request_line.trim().split_whitespace().collect();
    if parts.len() < 2 {
        return;
    }
    let method = parts[0];
    let raw_target = parts[1];
    let (path, query) = raw_target.split_once('?').unwrap_or((raw_target, ""));

    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            break;
        }
        if let Some((key, value)) = trimmed.split_once(':') {
            headers.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
    }

    if let Some(host) = headers.get("host") {
        if !is_loopback_host(host) {
            send_json(&mut stream, "403 Forbidden", &json!({ "error": "Invalid Host" }));
            return;
        }
    }
    if let Some(origin) = headers.get("origin") {
        if !is_loopback_origin(origin) {
            send_json(
                &mut stream,
                "403 Forbidden",
                &json!({ "error": "Invalid Origin" }),
            );
            return;
        }
    }

    let content_len: usize = headers
        .get("content-length")
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
        .min(512 * 1024);
    let mut body_bytes = vec![0u8; content_len];
    if content_len > 0 && reader.read_exact(&mut body_bytes).is_err() {
        send_json(
            &mut stream,
            "400 Bad Request",
            &json!({ "error": "Incomplete body" }),
        );
        return;
    }

    if method == "GET" {
        match path {
            "/" | "/index.html" => {
                send_http(
                    &mut stream,
                    "200 OK",
                    "text/html; charset=utf-8",
                    HTML_INDEX.as_bytes(),
                );
                return;
            }
            "/style.css" => {
                send_http(
                    &mut stream,
                    "200 OK",
                    "text/css; charset=utf-8",
                    CSS_STYLE.as_bytes(),
                );
                return;
            }
            "/app.js" => {
                send_http(
                    &mut stream,
                    "200 OK",
                    "text/javascript; charset=utf-8",
                    JS_APP.as_bytes(),
                );
                return;
            }
            "/logo.png" => {
                send_http(&mut stream, "200 OK", "image/png", LOGO_PNG);
                return;
            }
            "/favicon-v2.png" => {
                send_http(&mut stream, "200 OK", "image/png", FAVICON_PNG);
                return;
            }
            _ => {}
        }
    }

    if path.starts_with("/api/") {
        let header_token = headers
            .get("x-orzic-token")
            .map(String::as_str)
            .unwrap_or("");
        let beacon_token = if path == "/api/closing" {
            query_param(query, "token").unwrap_or("")
        } else {
            ""
        };
        if header_token != token && beacon_token != token {
            send_json(
                &mut stream,
                "401 Unauthorized",
                &json!({ "error": "无效访问令牌" }),
            );
            return;
        }
        life.touch();
    }

    let body_json: Value = if body_bytes.is_empty() {
        json!({})
    } else {
        match serde_json::from_slice(&body_bytes) {
            Ok(value) => value,
            Err(e) => {
                send_json(
                    &mut stream,
                    "400 Bad Request",
                    &json!({ "error": format!("JSON 无效: {e}") }),
                );
                return;
            }
        }
    };
    let body = body_json.as_object().cloned().unwrap_or_default();

    match dispatch_api(method, path, query, &body, life) {
        Some(Ok(value)) => send_json(&mut stream, "200 OK", &value),
        Some(Err(message)) => {
            send_json(&mut stream, "400 Bad Request", &json!({ "error": message }))
        }
        None => send_json(
            &mut stream,
            "404 Not Found",
            &json!({ "error": "Not found" }),
        ),
    }
}

fn serve_connections(listener: TcpListener, token: String, life: Arc<UiLifecycle>) {
    while !life.should_exit() {
        match listener.accept() {
            Ok((stream, _)) => {
                let _ = stream.set_nonblocking(false);
                let token = token.clone();
                let life = Arc::clone(&life);
                thread::spawn(move || handle_client(stream, &token, &life));
            }
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(80));
            }
            Err(_) => break,
        }
    }
}

pub fn run_ui_server(port: u16, open_window: bool) -> Result<(), String> {
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("无法监听 127.0.0.1:{port}: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置非阻塞监听失败: {e}"))?;
    let actual_port = listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| e.to_string())?;
    let token = generate_token();
    let url = format!("http://127.0.0.1:{actual_port}/#token={token}");

    println!("Orzic for fusion 控制台已启动：{url}");

    let life = UiLifecycle::new();
    let server = {
        let life = Arc::clone(&life);
        let token = token.clone();
        thread::spawn(move || serve_connections(listener, token, life))
    };

    // Warm the probe caches while the page loads, so the first Agent detail
    // does not pay for config inspection plus two CLI spawns.
    thread::spawn(|| {
        let _ = connectors::list_all();
        let _ = crate::agents::opencode::version();
        let _ = crate::agents::codex::version();
        let _ = crate::agents::codex::login_status();
        let _ = crate::agents::omp::read_status();
        // Model catalogs are cached for five minutes; refresh them in the
        // background so the first detail open does not spawn the CLI/App
        // Server on the click.
        let _ = crate::agents::opencode::models(false);
        let _ = crate::agents::codex::models(false);
    });

    if open_window {
        #[cfg(windows)]
        {
            if let Err(error) = ui_window::run(&url, Arc::clone(&life)) {
                eprintln!("原生 WebView2 窗口不可用（{error}），回退到 Edge 窗口");
                open_desktop_window(&url);
            }
        }
        #[cfg(not(windows))]
        open_desktop_window(&url);
    }

    let _ = server.join();
    Ok(())
}
