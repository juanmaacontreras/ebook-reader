// Desktop shell: a window around the same web app as Android. The only native
// pieces are the self-updater (GitHub Releases, see client/src/platform/updater.ts)
// and the process plugin to relaunch after an update.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .run(tauri::generate_context!())
        .expect("error while running Atril");
}
