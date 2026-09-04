use serde::Serialize;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::Command;
use tauri::{AppHandle, Emitter};

use crate::media;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
  pub task_id: String,
  pub received: u64,
  pub total: u64,
}

#[tauri::command]
pub fn pick_directory() -> Result<Option<String>, String> {
  let mut command = Command::new("powershell.exe");
  command.args([
    "-NoProfile",
    "-STA",
    "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择下载目录'; if ($d.ShowDialog() -eq 'OK') { $d.SelectedPath }",
  ]);
  media::hide_console(&mut command);
  let output = command.output().map_err(|e| e.to_string())?;
  let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
  if path.is_empty() {
    Ok(None)
  } else {
    Ok(Some(path))
  }
}

#[tauri::command]
pub fn remove_files(paths: Vec<String>) -> Result<u32, String> {
  let mut removed = 0u32;
  for raw in paths {
    let path = PathBuf::from(&raw);
    if !path.is_file() {
      continue;
    }
    let name = path
      .file_name()
      .and_then(|value| value.to_str())
      .unwrap_or("")
      .to_ascii_lowercase();
    if !(name.ends_with(".mp4") || name.ends_with(".mkv") || name.ends_with(".ts") || name.ends_with(".nfo")) {
      continue;
    }
    let stem = path.file_stem().and_then(|value| value.to_str()).unwrap_or_default();
    let extras = [
      path.with_extension("nfo"),
      path.with_file_name(format!("{stem}.enc.mp4")),
    ];
    fs::remove_file(&path).map_err(|e| format!("删除失败 {}: {e}", path.display()))?;
    removed += 1;
    for extra in extras {
      if extra != path && extra.is_file() {
        let _ = fs::remove_file(extra);
      }
    }
  }
  Ok(removed)
}


#[tauri::command]
pub async fn download_cover(url: String, dest_path: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || download_cover_sync(url, dest_path))
    .await
    .map_err(|e| format!("封面线程中断: {e}"))?
}

fn download_cover_sync(url: String, dest_path: String) -> Result<String, String> {
  if url.trim().is_empty() {
    return Err("缺少封面地址".into());
  }
  let dest = PathBuf::from(&dest_path);
  if dest.is_file() {
    return Ok(dest.to_string_lossy().into_owned());
  }
  if let Some(parent) = dest.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("无法创建封面目录: {e}"))?;
  }
  let bytes = reqwest::blocking::Client::builder()
    .user_agent("DuckDuck/0.2")
    .timeout(std::time::Duration::from_secs(30))
    .build()
    .map_err(|e| e.to_string())?
    .get(&url)
    .send()
    .map_err(|e| format!("封面下载失败: {e}"))?
    .error_for_status()
    .map_err(|e| format!("封面 HTTP {e}"))?
    .bytes()
    .map_err(|e| format!("封面读取失败: {e}"))?;
  fs::write(&dest, bytes).map_err(|e| format!("封面写入失败: {e}"))?;
  Ok(dest.to_string_lossy().into_owned())
}


#[tauri::command]
pub async fn download_decrypt(
  app: AppHandle,
  task_id: String,
  url: String,
  key_hex: String,
  dest_dir: String,
  filename: String,
) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    run_download(app, task_id, url, key_hex, dest_dir, filename)
  })
  .await
  .map_err(|e| format!("下载线程中断: {e}"))?
}

fn run_download(
  app: AppHandle,
  task_id: String,
  url: String,
  key_hex: String,
  dest_dir: String,
  filename: String,
) -> Result<String, String> {
  if url.is_empty() {
    return Err("缺少下载地址".into());
  }
  if dest_dir.trim().is_empty() {
    return Err("请先设置下载目录".into());
  }

  let dir = PathBuf::from(&dest_dir);
  fs::create_dir_all(&dir).map_err(|e| format!("无法创建目录: {e}"))?;

  let stem = sanitize(&filename);
  let out_path = dir.join(format!("{stem}.mp4"));
  if out_path.metadata().map(|meta| meta.len() > 0).unwrap_or(false) {
    return Ok(out_path.to_string_lossy().into_owned());
  }
  let task_stem = sanitize(&task_id);
  let enc_path = dir.join(format!("{stem}.{task_stem}.enc.mp4"));

  let mut response = reqwest::blocking::Client::builder()
    .user_agent("DuckDuck/0.2")
    .timeout(std::time::Duration::from_secs(600))
    .build()
    .map_err(|e| e.to_string())?
    .get(&url)
    .send()
    .map_err(|e| format!("下载失败: {e}"))?;

  if !response.status().is_success() {
    return Err(format!("CDN HTTP {}", response.status()));
  }

  let total = response.content_length().unwrap_or(0);
  let mut file = File::create(&enc_path).map_err(|e| format!("无法写入: {e}"))?;
  let mut received: u64 = 0;
  let mut buf = [0u8; 64 * 1024];
  let mut last_emit = 0u64;

  loop {
    let n = response.read(&mut buf).map_err(|e| format!("读取失败: {e}"))?;
    if n == 0 {
      break;
    }
    file.write_all(&buf[..n]).map_err(|e| format!("写入失败: {e}"))?;
    received += n as u64;
    if received - last_emit > 512 * 1024 || received == total {
      last_emit = received;
      let _ = app.emit(
        "download-progress",
        DownloadProgress {
          task_id: task_id.clone(),
          received,
          total,
        },
      );
    }
  }
  file.flush().ok();
  drop(file);

  // Another copy of the same episode may have completed while this request
  // was downloading. Keep the first finished file and discard this duplicate.
  if out_path.metadata().map(|meta| meta.len() > 0).unwrap_or(false) {
    let _ = fs::remove_file(&enc_path);
    return Ok(out_path.to_string_lossy().into_owned());
  }

  let key = key_hex.trim().to_lowercase();
  if key.len() == 32 && key.chars().all(|c| c.is_ascii_hexdigit()) {
    let ffmpeg = media::ffmpeg_bin();
    let mut command = Command::new(&ffmpeg);
    command.args([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-decryption_key",
      &key,
      "-i",
      enc_path.to_str().unwrap_or_default(),
      "-c",
      "copy",
      out_path.to_str().unwrap_or_default(),
    ]);
    media::hide_console(&mut command);
    let status = command.output();
    match status {
      Ok(output) if output.status.success() && out_path.exists() => {
        let _ = fs::remove_file(&enc_path);
        return Ok(out_path.to_string_lossy().into_owned());
      }
      Ok(output) => {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
          format!("解密失败 (ffmpeg {})，密文已保留: {}", output.status, enc_path.display())
        } else {
          format!("解密失败：{detail}，密文已保留: {}", enc_path.display())
        });
      }
      Err(e) => {
        return Err(format!(
          "未找到 ffmpeg ({e})，密文已保留: {}",
          enc_path.display()
        ));
      }
    }
  }

  let plain = dir.join(format!("{stem}.mp4"));
  fs::rename(&enc_path, &plain).map_err(|e| e.to_string())?;
  Ok(plain.to_string_lossy().into_owned())
}

fn sanitize(name: &str) -> String {
  let cleaned: String = name
    .chars()
    .map(|c| match c {
      '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
      c if c.is_control() => '_',
      c => c,
    })
    .collect();
  let trimmed = cleaned.trim().trim_matches('.');
  if trimmed.is_empty() {
    "episode".into()
  } else {
    trimmed.chars().take(80).collect()
  }
}
