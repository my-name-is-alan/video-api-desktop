use serde::{Deserialize, Serialize};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::{AppHandle, Emitter};

const RELEASES_URL: &str = "https://api.github.com/repos/my-name-is-alan/video-api-desktop/releases/latest";

#[derive(Debug, Deserialize)]
struct Release {
  tag_name: String,
  assets: Vec<Asset>,
}

#[derive(Debug, Clone, Deserialize)]
struct Asset {
  name: String,
  browser_download_url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateEvent {
  status: String,
  version: String,
  message: String,
}

pub fn spawn(app: AppHandle) {
  if cfg!(debug_assertions) {
    return;
  }
  let _ = std::thread::Builder::new()
    .name("duckduck-update".into())
    .spawn(move || {
      if let Err(message) = run(&app) {
        emit(&app, "error", env!("CARGO_PKG_VERSION"), &message);
      }
    });
}

fn run(app: &AppHandle) -> Result<(), String> {
  let current = env!("CARGO_PKG_VERSION");
  emit(app, "checking", current, "正在检查更新…");
  let release = fetch_latest()?;
  if !is_newer(&release.tag_name, current) {
    return Ok(());
  }
  let asset = pick_installer(&release.assets).ok_or_else(|| "新版本没有可用的安装包".to_string())?;
  if !allowed_download(&asset.browser_download_url) {
    return Err("更新地址无效".into());
  }
  let version = release.tag_name.trim().trim_start_matches('v').to_string();
  emit(app, "downloading", &version, &format!("正在下载 {version}…"));
  let installer = download_installer(asset)?;
  emit(app, "installing", &version, &format!("正在安装 {version}，应用即将重启…"));
  launch_installer(&installer)?;
  app.exit(0);
  Ok(())
}

fn emit(app: &AppHandle, status: &str, version: &str, message: &str) {
  let _ = app.emit(
    "app-update",
    UpdateEvent {
      status: status.into(),
      version: version.into(),
      message: message.into(),
    },
  );
}

fn client(timeout_secs: u64) -> Result<reqwest::blocking::Client, String> {
  reqwest::blocking::Client::builder()
    .user_agent(concat!("DuckDuck/", env!("CARGO_PKG_VERSION")))
    .timeout(std::time::Duration::from_secs(timeout_secs))
    .build()
    .map_err(|error| format!("无法创建更新客户端：{error}"))
}
fn fetch_latest() -> Result<Release, String> {
  let response = client(20)?
    .get(RELEASES_URL)
    .header("accept", "application/vnd.github+json")
    .send()
    .map_err(|error| format!("检查更新失败：{error}"))?;
  if !response.status().is_success() {
    return Err(format!("检查更新失败：HTTP {}", response.status()));
  }
  let text = response.text().map_err(|error| format!("读取更新信息失败：{error}"))?;
  serde_json::from_str(&text).map_err(|error| format!("更新信息无效：{error}"))
}

fn download_installer(asset: &Asset) -> Result<PathBuf, String> {
  let name = safe_filename(&asset.name).ok_or_else(|| "安装包文件名无效".to_string())?;
  let dir = std::env::temp_dir().join("duckduck-update");
  fs::create_dir_all(&dir).map_err(|error| format!("无法创建更新目录：{error}"))?;
  let dest = dir.join(&name);
  let mut response = client(180)?
    .get(&asset.browser_download_url)
    .send()
    .map_err(|error| format!("下载更新失败：{error}"))?
    .error_for_status()
    .map_err(|error| format!("下载更新失败：{error}"))?;
  let mut file = File::create(&dest).map_err(|error| format!("无法写入安装包：{error}"))?;
  let mut buf = [0u8; 64 * 1024];
  loop {
    let read = response.read(&mut buf).map_err(|error| format!("读取安装包失败：{error}"))?;
    if read == 0 {
      break;
    }
    file.write_all(&buf[..read]).map_err(|error| format!("写入安装包失败：{error}"))?;
  }
  Ok(dest)
}

fn launch_installer(installer: &Path) -> Result<(), String> {
  #[cfg(windows)]
  {
    let relaunch = std::env::current_exe().map_err(|error| format!("无法定位当前程序：{error}"))?;
    let script = installer.with_extension("cmd");
    let installer_s = installer.to_string_lossy().replace('"', "");
    let relaunch_s = relaunch.to_string_lossy().replace('"', "");
    let body = format!(
      "@echo off\r\nping 127.0.0.1 -n 3 >nul\r\nstart /wait \"\" \"{installer_s}\" /S\r\nstart \"\" \"{relaunch_s}\"\r\n"
    );
    fs::write(&script, body).map_err(|error| format!("无法写入更新脚本：{error}"))?;
    let mut command = Command::new("cmd.exe");
    command
      .args(["/C", script.to_str().ok_or("更新脚本路径无效")?])
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    #[cfg(windows)]
    {
      use std::os::windows::process::CommandExt;
      const CREATE_NO_WINDOW: u32 = 0x0800_0000;
      const DETACHED_PROCESS: u32 = 0x0000_0008;
      const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
      const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
      command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB);
    }
    command.spawn().map_err(|error| format!("无法启动安装程序：{error}"))?;
    return Ok(());
  }
  #[cfg(target_os = "macos")]
  {
    Command::new("open")
      .arg(installer)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
      .map_err(|error| format!("无法打开安装包：{error}"))?;
    return Ok(());
  }
  #[cfg(not(any(windows, target_os = "macos")))]
  {
    let _ = installer;
    Err("当前系统不支持自动更新".into())
  }
}

fn parse_semver(value: &str) -> Option<(u64, u64, u64)> {
  let trimmed = value.trim().trim_start_matches('v');
  let mut parts = trimmed.split('.');
  let major = parts.next()?.parse().ok()?;
  let minor = parts.next()?.parse().ok()?;
  let patch = parts.next()?.parse().ok()?;
  Some((major, minor, patch))
}

fn is_newer(latest: &str, current: &str) -> bool {
  match (parse_semver(latest), parse_semver(current)) {
    (Some(latest), Some(current)) => latest > current,
    _ => false,
  }
}

fn pick_installer(assets: &[Asset]) -> Option<&Asset> {
  #[cfg(windows)]
  {
    return assets
      .iter()
      .find(|asset| asset.name.to_ascii_lowercase().ends_with("-setup.exe"))
      .or_else(|| {
        assets.iter().find(|asset| {
          let name = asset.name.to_ascii_lowercase();
          name.ends_with(".exe") && !name.contains("msi")
        })
      });
  }
  #[cfg(target_os = "macos")]
  {
    return assets.iter().find(|asset| asset.name.to_ascii_lowercase().ends_with(".dmg"));
  }
  #[cfg(not(any(windows, target_os = "macos")))]
  {
    let _ = assets;
    None
  }
}

fn allowed_download(url: &str) -> bool {
  let Ok(parsed) = reqwest::Url::parse(url) else {
    return false;
  };
  if parsed.scheme() != "https" {
    return false;
  }
  parsed
    .host_str()
    .is_some_and(|host| host == "github.com" || host.ends_with(".github.com") || host.ends_with(".githubusercontent.com"))
}

fn safe_filename(name: &str) -> Option<String> {
  let base = Path::new(name).file_name()?.to_str()?;
  if base.is_empty() || base.contains(['/', '\\', '\0']) {
    return None;
  }
  Some(base.to_string())
}

#[cfg(test)]
mod tests {
  use super::{allowed_download, is_newer, pick_installer, safe_filename, Asset};

  #[test]
  fn detects_newer_release_tags() {
    assert!(is_newer("v0.1.5", "0.1.4"));
    assert!(!is_newer("v0.1.4", "0.1.4"));
    assert!(!is_newer("0.1.3", "0.1.4"));
  }

  #[test]
  fn rejects_non_github_downloads() {
    assert!(allowed_download("https://github.com/my-name-is-alan/video-api-desktop/releases/download/v0.1.5/DuckDuck_0.1.5_x64-setup.exe"));
    assert!(allowed_download("https://objects.githubusercontent.com/github-production-release-asset-2e65be/file"));
    assert!(!allowed_download("http://github.com/evil.exe"));
    assert!(!allowed_download("https://evil.example/setup.exe"));
  }

  #[test]
  fn sanitizes_installer_names() {
    assert_eq!(safe_filename("DuckDuck_0.1.5_x64-setup.exe").as_deref(), Some("DuckDuck_0.1.5_x64-setup.exe"));
    assert!(safe_filename("../evil.exe").is_none() || safe_filename("../evil.exe") == Some("evil.exe".into()));
  }

  #[test]
  fn prefers_nsis_setup_on_windows() {
    let assets = [
      Asset {
        name: "DuckDuck_0.1.5_x64_en-US.msi".into(),
        browser_download_url: "https://github.com/x/a.msi".into(),
      },
      Asset {
        name: "DuckDuck_0.1.5_x64-setup.exe".into(),
        browser_download_url: "https://github.com/x/a.exe".into(),
      },
    ];
    let picked = pick_installer(&assets).map(|asset| asset.name.as_str());
    #[cfg(windows)]
    assert_eq!(picked, Some("DuckDuck_0.1.5_x64-setup.exe"));
    #[cfg(target_os = "macos")]
    assert_eq!(picked, None);
  }
}
