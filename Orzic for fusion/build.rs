use std::env;
use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=src/app.rc");
    println!("cargo:rerun-if-changed=src/app.ico");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let res_path = out_dir.join("orzic-fusion.res");
    let rc_path = PathBuf::from("src/app.rc");
    let mut errors = Vec::new();

    for compiler in [
        r"C:\Program Files\LLVM\bin\llvm-rc.exe",
        "llvm-rc.exe",
        "rc.exe",
    ] {
        if compiler.starts_with(r"C:\") && !PathBuf::from(compiler).exists() {
            continue;
        }
        let status = Command::new(compiler)
            .arg("/nologo")
            .arg("/fo")
            .arg(&res_path)
            .arg(&rc_path)
            .status();
        match status {
            Ok(status) if status.success() && res_path.exists() => {
                println!("cargo:rustc-link-arg-bins={}", res_path.display());
                return;
            }
            Ok(status) => errors.push(format!("{compiler}: exit {status}")),
            Err(error) => errors.push(format!("{compiler}: {error}")),
        }
    }

    panic!(
        "无法编译 Windows 图标资源；请安装 LLVM (llvm-rc) 或 Windows SDK (rc.exe)：{}",
        errors.join("; ")
    );
}
