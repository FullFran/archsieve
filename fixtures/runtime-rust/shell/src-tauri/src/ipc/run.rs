use tauri_plugin_shell::ShellExt;

pub fn start(app: &tauri::AppHandle) {
    let _ = app.shell().sidecar("engine").unwrap().spawn();
    let prog = std::env::var("PROG").unwrap();
    let _ = std::process::Command::new(&prog).status();
}
