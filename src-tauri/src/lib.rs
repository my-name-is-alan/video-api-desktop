use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::process::Command;

mod media;
mod download;

#[cfg(desktop)]
use tauri::{
  menu::{MenuBuilder, MenuItemBuilder},
  tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
};

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      get_app_version,
      get_device_fingerprint,
      save_license_token,
      load_license_token,
      clear_license_token,
      load_prefs,
      save_prefs,
      media::get_media_tools_status,
      media::probe_media,
      media::merge_collections,
      media::generate_emby_nfo,
      media::write_emby_nfo,
      media::write_tvshow_nfo,
      media::write_episode_nfo,
      download::pick_directory,
      download::download_decrypt,
      download::download_cover,
      download::remove_files
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      #[cfg(desktop)]
      {
        let open_item = MenuItemBuilder::with_id("open", "打开 YCDownload").build(app)?;
        let quit_item = MenuItemBuilder::with_id("quit", "退出 YCDownload").build(app)?;
        let tray_menu = MenuBuilder::new(app)
          .items(&[&open_item, &quit_item])
          .build()?;

        TrayIconBuilder::with_id("main-tray")
          .icon(app.default_window_icon().cloned().expect("default app icon is required"))
          .tooltip("YCDownload")
          .menu(&tray_menu)
          .show_menu_on_left_click(false)
          .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => {
              if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
              }
            }
            "quit" => app.exit(0),
            _ => {}
          })
          .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
              if let Some(window) = tray.app_handle().get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
              }
            }
          })
          .build(app)?;
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[tauri::command]
fn get_app_version() -> String {
  format!("YCDownload v{}", env!("CARGO_PKG_VERSION"))
}

fn license_token_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  let directory = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{error}"))?;
  fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
  Ok(directory.join("license-token"))
}

#[tauri::command]
fn save_license_token(app: tauri::AppHandle, token: String) -> Result<(), String> {
  if token.trim().is_empty() || token.len() > 4096 { return Err("授权令牌格式无效".into()); }
  let path = license_token_path(&app)?;
  let temporary = path.with_extension("tmp");
  fs::write(&temporary, token).map_err(|error| format!("无法保存授权令牌：{error}"))?;
  fs::rename(&temporary, &path).map_err(|error| format!("无法提交授权令牌：{error}"))?;
  Ok(())
}

#[tauri::command]
fn load_license_token(app: tauri::AppHandle) -> Result<Option<String>, String> {
  let path = license_token_path(&app)?;
  if !path.is_file() { return Ok(None); }
  let token = fs::read_to_string(path).map_err(|error| format!("无法读取授权令牌：{error}"))?;
  Ok((!token.trim().is_empty()).then_some(token.trim().to_string()))
}

#[tauri::command]
fn clear_license_token(app: tauri::AppHandle) -> Result<(), String> {
  let path = license_token_path(&app)?;
  if path.is_file() { fs::remove_file(path).map_err(|error| format!("无法清除授权令牌：{error}"))?; }
  Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppPrefs {
  #[serde(default)]
  api_base: String,
  #[serde(default)]
  api_key: String,
  #[serde(default)]
  download_dir: String,
  #[serde(default = "default_true")]
  merge_after: bool,
  #[serde(default = "default_true")]
  write_nfo: bool,
}

fn default_true() -> bool {
  true
}

fn prefs_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  let directory = app.path().app_data_dir().map_err(|error| format!("无法定位应用数据目录：{error}"))?;
  fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
  Ok(directory.join("prefs.json"))
}

#[tauri::command]
fn load_prefs(app: tauri::AppHandle) -> Result<AppPrefs, String> {
  let path = prefs_path(&app)?;
  if !path.is_file() {
    return Ok(AppPrefs {
      api_base: String::new(),
      api_key: String::new(),
      download_dir: String::new(),
      merge_after: true,
      write_nfo: true,
    });
  }
  let raw = fs::read_to_string(&path).map_err(|error| format!("无法读取设置：{error}"))?;
  serde_json::from_str(&raw).map_err(|error| format!("设置文件损坏：{error}"))
}

#[tauri::command]
fn save_prefs(app: tauri::AppHandle, prefs: AppPrefs) -> Result<(), String> {
  let path = prefs_path(&app)?;
  let raw = serde_json::to_string_pretty(&prefs).map_err(|error| format!("无法序列化设置：{error}"))?;
  let temporary = path.with_extension("tmp");
  fs::write(&temporary, raw).map_err(|error| format!("无法保存设置：{error}"))?;
  fs::rename(&temporary, &path).map_err(|error| format!("无法提交设置：{error}"))?;
  Ok(())
}


#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceFingerprint {
  device_code: String,
  operating_system: String,
  mac_address: String,
  timezone: String,
  language: String,
  motherboard: String,
  memory: String,
  disk: String,
}

fn command_output(program: &str, args: &[&str]) -> String {
  Command::new(program)
    .args(args)
    .output()
    .ok()
    .filter(|output| output.status.success())
    .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
    .unwrap_or_default()
}

fn first_non_empty(values: &[String]) -> String {
  values.iter().find(|value| !value.trim().is_empty()).cloned().unwrap_or_else(|| "unknown".into())
}

fn mac_address() -> String {
  #[cfg(target_os = "windows")]
  {
    let output = command_output("getmac", &["/fo", "csv", "/nh"]);
    for part in output.split(',') {
      let value = part.trim().trim_matches('"').replace('-', ":");
      if value.matches(':').count() == 5 && value.len() >= 17 && !value.starts_with("00:00:00") {
        return value.to_lowercase();
      }
    }
  }
  #[cfg(target_os = "macos")]
  {
    let output = command_output("ifconfig", &["en0"]);
    for line in output.lines() {
      if let Some(value) = line.trim().strip_prefix("ether ") { return value.trim().to_lowercase(); }
    }
  }
  #[cfg(target_os = "linux")]
  {
    if let Ok(entries) = std::fs::read_dir("/sys/class/net") {
      for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "lo" { continue; }
        if let Ok(value) = std::fs::read_to_string(entry.path().join("address")) {
          let value = value.trim().to_lowercase();
          if value.matches(':').count() == 5 && !value.starts_with("00:00:00") { return value; }
        }
      }
    }
  }
  first_non_empty(&[
    std::env::var("COMPUTERNAME").unwrap_or_default(),
    std::env::var("HOSTNAME").unwrap_or_default(),
  ])
}

fn motherboard() -> String {
  #[cfg(target_os = "windows")]
  {
    let value = command_output("powershell", &["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_BaseBoard | Select-Object -First 1 -ExpandProperty SerialNumber)"]);
    if !value.is_empty() { return value; }
  }
  #[cfg(target_os = "macos")]
  {
    let value = command_output("system_profiler", &["SPHardwareDataType"]);
    if !value.is_empty() { return value.lines().find_map(|line| line.trim().strip_prefix("Serial Number (system):").map(str::trim).map(str::to_owned)).unwrap_or(value); }
  }
  #[cfg(target_os = "linux")]
  {
    for path in ["/sys/devices/virtual/dmi/id/board_serial", "/sys/devices/virtual/dmi/id/product_uuid"] {
      if let Ok(value) = std::fs::read_to_string(path) { if !value.trim().is_empty() { return value.trim().to_string(); } }
    }
  }
  first_non_empty(&[std::env::var("COMPUTERNAME").unwrap_or_default()])
}

fn memory() -> String {
  #[cfg(target_os = "windows")]
  { return first_non_empty(&[command_output("powershell", &["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory"])]); }
  #[cfg(target_os = "macos")]
  { return first_non_empty(&[command_output("sysctl", &["-n", "hw.memsize"])]); }
  #[cfg(target_os = "linux")]
  {
    if let Ok(value) = std::fs::read_to_string("/proc/meminfo") { if let Some(line) = value.lines().find(|line| line.starts_with("MemTotal:")) { return line.to_string(); } }
    return "unknown".into();
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  { "unknown".into() }
}

fn disk() -> String {
  #[cfg(target_os = "windows")]
  { return first_non_empty(&[command_output("powershell", &["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_DiskDrive | Measure-Object -Property Size -Sum).Sum"])]); }
  #[cfg(target_os = "macos")]
  { return first_non_empty(&[command_output("diskutil", &["info", "/"])]); }
  #[cfg(target_os = "linux")]
  {
    if let Ok(value) = std::fs::read_to_string("/proc/partitions") { return value.lines().skip(2).take(8).collect::<Vec<_>>().join("|"); }
    return "unknown".into();
  }
  #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
  { first_non_empty(&[std::env::var("SystemDrive").unwrap_or_default()]) }
}

fn build_device_fingerprint() -> DeviceFingerprint {
  let operating_system = format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH);
  let timezone = first_non_empty(&[
    std::env::var("TZ").unwrap_or_default(),
    #[cfg(target_os = "windows")] { command_output("powershell", &["-NoProfile", "-NonInteractive", "-Command", "(Get-TimeZone).Id"]) },
    #[cfg(not(target_os = "windows"))] { command_output("date", &["+%Z%z"]) },
  ]);
  let language = first_non_empty(&[
    std::env::var("LANG").unwrap_or_default(),
    std::env::var("LC_ALL").unwrap_or_default(),
    std::env::var("LANGUAGE").unwrap_or_default(),
    #[cfg(target_os = "windows")]
    { command_output("powershell", &["-NoProfile", "-NonInteractive", "-Command", "(Get-Culture).Name"]) },
  ]);
  let mac_address = mac_address();
  let motherboard = motherboard();
  let memory = memory();
  let disk = disk();
  let canonical = format!("v1|os={operating_system}|mac={mac_address}|tz={timezone}|lang={language}|board={motherboard}|ram={memory}|disk={disk}");
  let mut digest = Sha256::new();
  digest.update(b"YCDownload:device-fingerprint:v1:");
  digest.update(canonical.as_bytes());
  let device_code = format!("YC1-{}", hex::encode_upper(digest.finalize()));
  DeviceFingerprint { device_code, operating_system, mac_address, timezone, language, motherboard, memory, disk }
}

/// Returns only a one-way device code to the webview. Raw hardware values stay local
/// and are never sent to the license server.
#[tauri::command]
fn get_device_fingerprint() -> DeviceFingerprint { build_device_fingerprint() }

#[cfg(test)]
mod tests {
  use super::build_device_fingerprint;

  #[test]
  fn device_code_is_stable_and_prefixed() {
    let first = build_device_fingerprint();
    let second = build_device_fingerprint();
    assert_eq!(first.device_code, second.device_code);
    assert!(first.device_code.starts_with("YC1-"));
    assert_eq!(first.device_code.len(), 68);
  }
}
