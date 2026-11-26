//! Native window + WebView2 host for the console.
//!
//! Edge app windows paint their own frame and turn the inactive caption gray.
//! This module owns a frameless window instead: the page's black top bar is the
//! only title bar (same approach as other custom-chrome desktop apps), and the
//! window buttons on the right call back into this host.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use webview2_com::Microsoft::Web::WebView2::Win32::*;
use webview2_com::{
    CoTaskMemPWSTR, CreateCoreWebView2ControllerCompletedHandler,
    CreateCoreWebView2EnvironmentCompletedHandler,
};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{E_POINTER, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
use windows::Win32::Graphics::Gdi::{GetStockObject, BLACK_BRUSH};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use super::UiLifecycle;

const APP_ICON_RESOURCE: usize = 1;
const ICON_BIG: usize = 1;
const WM_APP_DRAG: u32 = WM_APP + 1;
const WM_APP_MAXIMIZE: u32 = WM_APP + 2;
const MIN_WIDTH: i32 = 720;
const MIN_HEIGHT: i32 = 560;
const RESIZE_EDGE: i32 = 6;

static WINDOW: AtomicIsize = AtomicIsize::new(0);
static MAXIMIZED: AtomicBool = AtomicBool::new(false);
static RESTORE_RECT: Mutex<Option<RECT>> = Mutex::new(None);

thread_local! {
    static CONTROLLER: RefCell<Option<ICoreWebView2Controller>> = const { RefCell::new(None) };
    static WEBVIEW: RefCell<Option<ICoreWebView2>> = const { RefCell::new(None) };
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn apply_icon(hwnd: HWND) {
    unsafe {
        let Ok(instance) = GetModuleHandleW(None) else {
            return;
        };
        let icon = LoadImageW(
            Some(HINSTANCE(instance.0)),
            PCWSTR(APP_ICON_RESOURCE as *const u16),
            IMAGE_ICON,
            32,
            32,
            LR_SHARED,
        );
        if let Ok(icon) = icon {
            SendMessageW(hwnd, WM_SETICON, Some(WPARAM(0)), Some(LPARAM(0)));
            SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_BIG)), Some(LPARAM(icon.0 as isize)));
        }
    }
}

fn resize_edge(hwnd: HWND) -> i32 {
    let dpi = unsafe { GetDpiForWindow(hwnd) } as i32;
    (RESIZE_EDGE * dpi / 96).max(1)
}

fn resize_webview(hwnd: HWND) {
    let mut rect = RECT::default();
    if unsafe { GetClientRect(hwnd, &mut rect) }.is_err() {
        return;
    }
    // WebView2 owns a child window that receives mouse input before the host.
    // Leave the resize strip uncovered so the host can hit-test it.
    if !MAXIMIZED.load(Ordering::SeqCst) {
        let edge = resize_edge(hwnd);
        rect.left += edge;
        rect.top += edge;
        rect.right = (rect.right - edge).max(rect.left);
        rect.bottom = (rect.bottom - edge).max(rect.top);
    }
    CONTROLLER.with(|cell| {
        if let Some(controller) = cell.borrow().as_ref() {
            let _ = unsafe { controller.SetBounds(rect) };
        }
    });
}

fn toggle_maximize(hwnd: HWND) {
    unsafe {
        if MAXIMIZED.load(Ordering::SeqCst) {
            MAXIMIZED.store(false, Ordering::SeqCst);
            if let Some(rect) = *RESTORE_RECT.lock().unwrap() {
                let _ = SetWindowPos(
                    hwnd,
                    None,
                    rect.left,
                    rect.top,
                    rect.right - rect.left,
                    rect.bottom - rect.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
            }
        } else {
            MAXIMIZED.store(true, Ordering::SeqCst);
            let mut current = RECT::default();
            if GetWindowRect(hwnd, &mut current).is_ok() {
                *RESTORE_RECT.lock().unwrap() = Some(current);
            }
            let mut work = RECT::default();
            let _ = SystemParametersInfoW(
                SPI_GETWORKAREA,
                0,
                Some(&mut work as *mut RECT as *mut _),
                SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
            );
            let _ = SetWindowPos(
                hwnd,
                None,
                work.left,
                work.top,
                work.right - work.left,
                work.bottom - work.top,
                SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
        resize_webview(hwnd);
    }
}

/// Actions requested by the page title bar. The page owns the caption, so it
/// also owns minimize/maximize/close and drag.
pub fn window_action(action: &str) -> Result<(), String> {
    let hwnd = HWND(WINDOW.load(Ordering::SeqCst) as *mut _);
    if hwnd.0.is_null() {
        return Err("窗口尚未创建".into());
    }
    let message = match action {
        "drag" => WM_APP_DRAG,
        "minimize" => WM_SYSCOMMAND,
        "maximize" => WM_APP_MAXIMIZE,
        "close" => WM_CLOSE,
        other => return Err(format!("未知窗口动作：{other}")),
    };
    let wparam = if action == "minimize" {
        WPARAM(SC_MINIMIZE as usize)
    } else {
        WPARAM(0)
    };
    unsafe {
        PostMessageW(Some(hwnd), message, wparam, LPARAM(0))
            .map_err(|error| format!("窗口动作失败：{error}"))
    }
}

extern "system" fn window_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        // Keep the whole window client-drawn while WS_THICKFRAME enables the
        // system's interactive resize handling for our non-client hit tests.
        WM_NCCALCSIZE => LRESULT(0),
        WM_NCHITTEST => {
            if MAXIMIZED.load(Ordering::SeqCst) {
                return LRESULT(HTCLIENT as isize);
            }
            let raw = lparam.0;
            let mut point = POINT {
                x: (raw & 0xffff) as u16 as i16 as i32,
                y: ((raw >> 16) & 0xffff) as u16 as i16 as i32,
            };
            unsafe {
                let _ = windows::Win32::Graphics::Gdi::ScreenToClient(hwnd, &mut point);
            }
            let mut rect = RECT::default();
            if unsafe { GetClientRect(hwnd, &mut rect) }.is_ok() {
                let edge = resize_edge(hwnd);
                let left = point.x < edge;
                let right = point.x >= rect.right - edge;
                let top = point.y < edge;
                let bottom = point.y >= rect.bottom - edge;
                let hit = match (left, right, top, bottom) {
                    (true, _, true, _) => HTTOPLEFT,
                    (_, true, true, _) => HTTOPRIGHT,
                    (true, _, _, true) => HTBOTTOMLEFT,
                    (_, true, _, true) => HTBOTTOMRIGHT,
                    (true, _, _, _) => HTLEFT,
                    (_, true, _, _) => HTRIGHT,
                    (_, _, true, _) => HTTOP,
                    (_, _, _, true) => HTBOTTOM,
                    _ => return LRESULT(HTCLIENT as isize),
                };
                return LRESULT(hit as isize);
            }
            LRESULT(HTCLIENT as isize)
        }
        WM_SIZE => {
            resize_webview(hwnd);
            LRESULT(0)
        }
        WM_GETMINMAXINFO => {
            unsafe {
                let info = &mut *(lparam.0 as *mut MINMAXINFO);
                info.ptMinTrackSize.x = MIN_WIDTH;
                info.ptMinTrackSize.y = MIN_HEIGHT;
            }
            LRESULT(0)
        }
        WM_APP_DRAG => {
            unsafe {
                let _ = windows::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture();
                SendMessageW(
                    hwnd,
                    WM_NCLBUTTONDOWN,
                    Some(WPARAM(HTCAPTION as usize)),
                    Some(LPARAM(0)),
                );
            }
            LRESULT(0)
        }
        WM_APP_MAXIMIZE => {
            toggle_maximize(hwnd);
            LRESULT(0)
        }
        WM_CLOSE => {
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
            LRESULT(0)
        }
        WM_DESTROY => {
            WINDOW.store(0, Ordering::SeqCst);
            unsafe { PostQuitMessage(0) };
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

fn create_environment() -> Result<ICoreWebView2Environment, String> {
    let folder = crate::config::omp_agent_dir().join("webview2-data");
    let folder_wide = wide(&folder.to_string_lossy());
    let (tx, rx) = mpsc::channel();
    CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            CreateCoreWebView2EnvironmentWithOptions(
                None,
                PCWSTR(folder_wide.as_ptr()),
                None,
                &handler,
            )
            .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |code, environment| {
            code?;
            tx.send(environment.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                .map_err(|_| windows::core::Error::from(E_POINTER))?;
            Ok(())
        }),
    )
    .map_err(|error| format!("WebView2 环境创建失败：{error:?}"))?;
    rx.recv()
        .map_err(|_| "WebView2 环境回调丢失".to_string())?
        .map_err(|error| format!("WebView2 环境不可用：{error}"))
}

fn create_controller(
    environment: &ICoreWebView2Environment,
    hwnd: HWND,
) -> Result<ICoreWebView2Controller, String> {
    let (tx, rx) = mpsc::channel();
    let environment = environment.clone();
    CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            environment
                .CreateCoreWebView2Controller(hwnd, &handler)
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |code, controller| {
            code?;
            tx.send(controller.ok_or_else(|| windows::core::Error::from(E_POINTER)))
                .map_err(|_| windows::core::Error::from(E_POINTER))?;
            Ok(())
        }),
    )
    .map_err(|error| format!("WebView2 控制器创建失败：{error:?}"))?;
    rx.recv()
        .map_err(|_| "WebView2 控制器回调丢失".to_string())?
        .map_err(|error| format!("WebView2 控制器不可用：{error}"))
}

/// Run the native console window until the user closes it or the server asks
/// to exit. Returns an error when WebView2 is unavailable so the caller can
/// fall back to an Edge app window.
pub fn run(url: &str, life: Arc<UiLifecycle>) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }

    let instance = unsafe { GetModuleHandleW(None) }.map_err(|e| format!("GetModuleHandle: {e}"))?;
    let class = w!("OrzicFusionWindow");
    let wc = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: HINSTANCE(instance.0),
        lpszClassName: class,
        hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(unsafe {
            GetStockObject(BLACK_BRUSH).0
        }),
        ..Default::default()
    };
    unsafe { RegisterClassW(&wc) };

    let width = 945;
    let height = 1015;
    let screen_w = unsafe { GetSystemMetrics(SM_CXSCREEN) };
    let screen_h = unsafe { GetSystemMetrics(SM_CYSCREEN) };
    let x = ((screen_w - width) / 2).max(0);
    let y = ((screen_h - height) / 2).max(0);

    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            class,
            w!("\u{200B}"),
            WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU,
            x,
            y,
            width,
            height,
            None,
            None,
            Some(HINSTANCE(instance.0)),
            None,
        )
    }
    .map_err(|e| format!("创建窗口失败：{e}"))?;
    WINDOW.store(hwnd.0 as isize, Ordering::SeqCst);

    apply_icon(hwnd);

    let environment = create_environment()?;
    let controller = create_controller(&environment, hwnd)?;
    let webview = unsafe { controller.CoreWebView2() }.map_err(|e| format!("WebView2 不可用：{e}"))?;
    unsafe {
        let _ = controller.SetIsVisible(true);
        if let Ok(settings) = webview.Settings() {
            let _ = settings.SetAreDefaultContextMenusEnabled(false);
            let _ = settings.SetAreDevToolsEnabled(false);
        }
    }
    // Store the controller before the first bounds request: `resize_webview`
    // only touches an already-stored controller, so sizing it earlier is
    // dropped and the page would load at 0×0 behind the black host brush
    // until something else triggers WM_SIZE.
    CONTROLLER.with(|cell| *cell.borrow_mut() = Some(controller));
    resize_webview(hwnd);
    unsafe {
        let url_wide = CoTaskMemPWSTR::from(url);
        webview
            .Navigate(*url_wide.as_ref().as_pcwstr())
            .map_err(|e| format!("导航失败：{e}"))?;
    }
    WEBVIEW.with(|cell| *cell.borrow_mut() = Some(webview));

    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOW);
        let _ = SetForegroundWindow(hwnd);
        let _ = windows::Win32::UI::Input::KeyboardAndMouse::SetFocus(Some(hwnd));
    }
    // ShowWindow does not always raise WM_SIZE for a popup that already has
    // its final size; re-assert the bounds once the window is visible.
    resize_webview(hwnd);

    // The server exits on its own when the page closes or the user presses
    // 退出服务; close the window at the same point.
    {
        let life = Arc::clone(&life);
        let hwnd_bits = hwnd.0 as isize;
        std::thread::spawn(move || loop {
            if life.should_exit() {
                unsafe {
                    let _ = PostMessageW(Some(HWND(hwnd_bits as *mut _)), WM_CLOSE, WPARAM(0), LPARAM(0));
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(500));
        });
    }

    let mut msg = MSG::default();
    loop {
        let result = unsafe { GetMessageW(&mut msg, None, 0, 0) };
        match result.0 {
            -1 => break Err("窗口消息循环失败".to_string()),
            0 => break Ok(()),
            _ => {
                unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
        }
    }?;

    life.shutdown.store(true, Ordering::SeqCst);
    CONTROLLER.with(|cell| {
        if let Some(controller) = cell.borrow_mut().take() {
            let _ = unsafe { controller.Close() };
        }
    });
    WEBVIEW.with(|cell| {
        let _ = cell.borrow_mut().take();
    });
    Ok(())
}
