#![cfg_attr(all(windows, not(test)), windows_subsystem = "windows")]

mod acceptance;
mod agents;
mod config;
mod connectors;
mod handoff;
mod mcp;
mod memory;
mod roles;
mod route;
mod state;
mod ui_server;

use serde_json::json;
use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::process;

#[cfg(windows)]
fn attach_parent_console_if_cli() {
    const STD_OUTPUT_HANDLE: u32 = (-11i32) as u32;
    const ATTACH_PARENT_PROCESS: u32 = u32::MAX;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n_std_handle: u32) -> isize;
        fn AttachConsole(process_id: u32) -> i32;
    }
    unsafe {
        // A double-clicked GUI build has no console. CLI invocations from a
        // terminal do, and MCP stdio already has redirected pipes.
        let handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if handle == 0 || handle == -1 {
            let _ = AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[cfg(not(windows))]
fn attach_parent_console_if_cli() {}

fn print_help() {
    println!(
        r#"orzic-fusion v{} — 角色模型控制台 + MCP 服务（首个适配器：OMP）

用法：
  orzic-fusion.exe                启动桌面控制台（无参数，双击即可）
  orzic-fusion.exe --ui           启动控制台（--port <端口> --no-open）
  orzic-fusion.exe mcp            启动 MCP stdio 服务（供 OMP / Zed / Codex / 其他 Agent 调用）
  orzic-fusion.exe status         输出 OMP 角色、模型与 MCP 连接状态（JSON）
  orzic-fusion.exe route          每轮路由：从 stdin 读取用户消息，输出模式与模型
                                    --session <id> --cwd <仓库目录>
                                    --event refresh|plan-written|rework|reset
  orzic-fusion.exe install-omp    安装并登记 OMP 扩展（每轮路由 + 规划门禁）
  orzic-fusion.exe uninstall-omp  移除 OMP 扩展登记
  orzic-fusion.exe accept         手动验收：收集 diff，用 review 角色模型判定
                                    --cwd <工作区目录>
                                    --auto 仅在已开启自动验收的工作区运行
                                    --json 输出紧凑 JSON（供扩展调用）
  orzic-fusion.exe connect        注册本 EXE 到目标平台：
                                    --target omp,opencode,codex,claude-desktop,cursor,windsurf,antigravity,gemini-cli | all
                                    --custom <mcpServers JSON 路径> --label <名称>
                                    --off     断开而不是连接
  orzic-fusion.exe --help         显示本帮助"#,
        env!("CARGO_PKG_VERSION")
    );
}

fn resolve_target_ids(spec: &str) -> Vec<String> {
    if spec.eq_ignore_ascii_case("all") {
        return connectors::builtin_targets()
            .into_iter()
            .map(|target| target.id.to_string())
            .collect();
    }
    spec.split(',')
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .collect()
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        if let Err(e) = ui_server::run_ui_server(0, true) {
            eprintln!("启动控制台失败：{e}");
            process::exit(1);
        }
        return;
    }

    match args[0].as_str() {
        "mcp" | "--mcp" | "--stdio" => {
            if let Err(e) = mcp::run_stdio_server() {
                eprintln!("MCP stdio 服务异常退出：{e}");
                process::exit(1);
            }
            return;
        }
        "--ui" | "ui" => {
            let mut port: u16 = 0;
            let mut open = true;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--port" if index + 1 < args.len() => {
                        port = args[index + 1].parse().unwrap_or(0);
                        index += 1;
                    }
                    "--no-open" => open = false,
                    _ => {}
                }
                index += 1;
            }
            if let Err(e) = ui_server::run_ui_server(port, open) {
                eprintln!("启动控制台失败：{e}");
                process::exit(1);
            }
            return;
        }
        _ => {}
    }

    attach_parent_console_if_cli();

    match args[0].as_str() {
        "-h" | "--help" | "help" => print_help(),
        "status" => {
            let out = json!({
                "omp": agents::omp::read_status(),
                "models": agents::omp::list_models(false).unwrap_or_default(),
                "connectors": connectors::list_all(),
            });
            println!("{}", serde_json::to_string_pretty(&out).unwrap());
        }
        "mem-report" => {
            let mut buffer = String::new();
            let _ = std::io::stdin().read_to_string(&mut buffer);
            let result = serde_json::from_str::<serde_json::Value>(&buffer)
                .map_err(|e| format!("mem-report 需要 JSON：{e}"))
                .and_then(|value| memory::cli(&value));
            match result {
                Ok(value) => println!("{}", serde_json::to_string(&value).unwrap_or_default()),
                Err(err) => {
                    eprintln!("内存上报失败：{err}");
                    process::exit(1);
                }
            }
        }
        "route" => {
            let mut session = "default".to_string();
            let mut cwd = env::current_dir()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut event: Option<String> = None;
            let mut message: Option<String> = None;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--session" if index + 1 < args.len() => {
                        session = args[index + 1].clone();
                        index += 1;
                    }
                    "--cwd" if index + 1 < args.len() => {
                        cwd = args[index + 1].clone();
                        index += 1;
                    }
                    "--event" if index + 1 < args.len() => {
                        event = Some(args[index + 1].clone());
                        index += 1;
                    }
                    "--message" if index + 1 < args.len() => {
                        message = Some(args[index + 1].clone());
                        index += 1;
                    }
                    _ => {}
                }
                index += 1;
            }
            let message = match message {
                Some(value) => value,
                None => {
                    let mut buffer = String::new();
                    let _ = std::io::stdin().read_to_string(&mut buffer);
                    buffer
                }
            };
            match route::route(&message, &session, &cwd, event.as_deref()) {
                Ok(value) => {
                    println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default())
                }
                Err(err) => {
                    eprintln!("路由失败：{err}");
                    process::exit(1);
                }
            }
        }
        "install-omp" => match route::install_extension() {
            Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default()),
            Err(err) => {
                eprintln!("安装 OMP 扩展失败：{err}");
                process::exit(1);
            }
        },
        "uninstall-omp" => match route::uninstall_extension() {
            Ok(value) => println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default()),
            Err(err) => {
                eprintln!("移除 OMP 扩展失败：{err}");
                process::exit(1);
            }
        },
        "accept" => {
            let mut cwd = env::current_dir()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default();
            let mut auto = false;
            let mut compact = false;
            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--cwd" if index + 1 < args.len() => {
                        cwd = args[index + 1].clone();
                        index += 1;
                    }
                    "--auto" => auto = true,
                    "--json" => compact = true,
                    _ => {}
                }
                index += 1;
            }
            let result = if auto {
                acceptance::run_auto(&cwd)
            } else {
                acceptance::run(&cwd)
            };
            match result {
                Ok(value) => {
                    if compact {
                        println!("{}", serde_json::to_string(&value).unwrap_or_default());
                    } else {
                        println!("{}", serde_json::to_string_pretty(&value).unwrap_or_default());
                    }
                }
                Err(err) => {
                    eprintln!("验收失败：{err}");
                    process::exit(1);
                }
            }
        }
        "connect" => {
            let mut targets: Vec<String> = Vec::new();
            let mut custom_path: Option<String> = None;
            let mut custom_label: Option<String> = None;
            let mut enable = true;

            let mut index = 1;
            while index < args.len() {
                match args[index].as_str() {
                    "--target" if index + 1 < args.len() => {
                        targets.extend(resolve_target_ids(&args[index + 1]));
                        index += 1;
                    }
                    "--custom" if index + 1 < args.len() => {
                        custom_path = Some(args[index + 1].clone());
                        index += 1;
                    }
                    "--label" if index + 1 < args.len() => {
                        custom_label = Some(args[index + 1].clone());
                        index += 1;
                    }
                    "--off" | "--disable" => enable = false,
                    _ => {}
                }
                index += 1;
            }

            if targets.is_empty() && custom_path.is_none() {
                eprintln!("请指定 --target <id|all> 或 --custom <path>");
                process::exit(1);
            }

            for id in &targets {
                match connectors::connect_target_by_id(id, enable) {
                    Ok(_) => println!(
                        "  [{}] {}: {}",
                        if enable { "已连接" } else { "已断开" },
                        id,
                        connectors::current_exe_string()
                    ),
                    Err(e) => {
                        eprintln!("  [失败] {id}: {e}");
                        process::exit(1);
                    }
                }
            }

            if let Some(path) = custom_path {
                let path_buf = PathBuf::from(&path);
                let result = connectors::connect_to_path(
                    &path_buf,
                    connectors::SERVER_NAME,
                    &connectors::current_exe_string(),
                    enable,
                );
                match result {
                    Ok(_) => {
                        if enable {
                            let label = custom_label.as_deref().unwrap_or(&path);
                            let slug: String = label
                                .chars()
                                .filter(|c| c.is_ascii_alphanumeric())
                                .collect::<String>()
                                .to_lowercase();
                            let _ = connectors::save_custom_target(connectors::CustomTarget {
                                id: if slug.is_empty() {
                                    format!("custom-{}", path.len())
                                } else {
                                    format!("custom-{slug}")
                                },
                                label: label.to_string(),
                                config_path: path.clone(),
                                server_name: connectors::SERVER_NAME.to_string(),
                            });
                        }
                        println!(
                            "  [{}] custom -> {}",
                            if enable { "已连接" } else { "已断开" },
                            path
                        );
                    }
                    Err(e) => {
                        eprintln!("  [失败] custom: {e}");
                        process::exit(1);
                    }
                }
            }
        }
        other => {
            eprintln!("未知命令：{other}");
            print_help();
            process::exit(1);
        }
    }
}
