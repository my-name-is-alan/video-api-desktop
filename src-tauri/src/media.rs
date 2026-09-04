use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

pub(crate) fn hide_console(command: &mut Command) {
  command.stdin(Stdio::null());
  #[cfg(windows)]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaToolsStatus {
  pub ffmpeg_available: bool,
  pub ffprobe_available: bool,
  pub ffmpeg_path: String,
  pub ffprobe_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProbe {
  pub path: String,
  pub format_name: String,
  pub duration_seconds: Option<f64>,
  pub size_bytes: Option<u64>,
  pub bit_rate: Option<u64>,
  pub width: Option<u64>,
  pub height: Option<u64>,
  pub video_codec: Option<String>,
  pub audio_codec: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbyMetadata {
  pub title: String,
  #[serde(default)]
  pub original_title: Option<String>,
  #[serde(default)]
  pub year: Option<u16>,
  #[serde(default)]
  pub premiered: Option<String>,
  #[serde(default)]
  pub plot: Option<String>,
  #[serde(default)]
  pub genres: Vec<String>,
  #[serde(default)]
  pub directors: Vec<String>,
  #[serde(default)]
  pub tmdb_id: Option<String>,
  #[serde(default)]
  pub imdb_id: Option<String>,
  #[serde(default)]
  pub media: Option<MediaProbe>,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NfoActor {
  pub name: String,
  #[serde(default)]
  pub role: Option<String>,
  #[serde(default)]
  pub thumb: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TvShowNfo {
  pub title: String,
  #[serde(default)]
  pub plot: Option<String>,
  #[serde(default)]
  pub genres: Vec<String>,
  #[serde(default)]
  pub actors: Option<String>,
  #[serde(default)]
  pub cast: Vec<NfoActor>,
  #[serde(default)]
  pub episode_count: Option<u32>,
  #[serde(default)]
  pub unique_id: Option<String>,
}



fn binary_filenames(name: &str) -> Vec<String> {
  #[cfg(windows)]
  {
    let triple = if cfg!(target_arch = "aarch64") {
      "aarch64-pc-windows-msvc"
    } else {
      "x86_64-pc-windows-msvc"
    };
    vec![
      format!("{name}-{triple}.exe"),
      format!("{name}.exe"),
    ]
  }
  #[cfg(not(windows))]
  {
    vec![name.to_string()]
  }
}

fn search_dirs() -> Vec<PathBuf> {
  let mut dirs = Vec::new();
  if let Ok(executable) = std::env::current_exe() {
    if let Some(parent) = executable.parent() {
      dirs.push(parent.to_path_buf());
      dirs.push(parent.join("binaries"));
      dirs.push(parent.join("resources"));
    }
  }
  dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
  dirs
}

fn resolve_binary(name: &str) -> String {
  let env_names = if name == "ffmpeg" {
    ["DUCKDUCK_FFMPEG", "YCDOWNLOAD_FFMPEG"]
  } else {
    ["DUCKDUCK_FFPROBE", "YCDOWNLOAD_FFPROBE"]
  };
  for env_name in env_names {
    if let Ok(value) = std::env::var(env_name) {
      if !value.trim().is_empty() && Path::new(&value).exists() {
        return value;
      }
    }
  }

  for dir in search_dirs() {
    for file in binary_filenames(name) {
      let candidate = dir.join(&file);
      if candidate.is_file() {
        return candidate.to_string_lossy().into_owned();
      }
    }
  }

  #[cfg(target_os = "windows")]
  { format!("{name}.exe") }
  #[cfg(not(target_os = "windows"))]
  { name.to_string() }
}

fn can_run(binary: &str) -> bool {
  let mut command = Command::new(binary);
  command.arg("-version");
  hide_console(&mut command);
  command
    .output()
    .map(|output| output.status.success())
    .unwrap_or(false)
}

pub(crate) fn ffmpeg_bin() -> String {
  resolve_binary("ffmpeg")
}


#[tauri::command]
pub fn get_media_tools_status() -> MediaToolsStatus {
  let ffmpeg_path = resolve_binary("ffmpeg");
  let ffprobe_path = resolve_binary("ffprobe");
  MediaToolsStatus {
    ffmpeg_available: can_run(&ffmpeg_path),
    ffprobe_available: can_run(&ffprobe_path),
    ffmpeg_path,
    ffprobe_path,
  }
}

fn value_string(value: Option<&Value>) -> Option<String> {
  value.and_then(|item| item.as_str().map(ToOwned::to_owned))
}

fn value_u64(value: Option<&Value>) -> Option<u64> {
  value.and_then(|item| item.as_u64().or_else(|| item.as_str()?.parse().ok()))
}

#[tauri::command]
pub fn probe_media(path: String) -> Result<MediaProbe, String> {
  let media_path = PathBuf::from(&path);
  if !media_path.is_file() {
    return Err(format!("媒体文件不存在：{path}"));
  }

  let ffprobe = resolve_binary("ffprobe");
  let mut command = Command::new(&ffprobe);
  command
    .args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams"])
    .arg(&media_path);
  hide_console(&mut command);
  let output = command
    .output()
    .map_err(|error| format!("无法启动 FFprobe（{ffprobe}）：{error}"))?;
  if !output.status.success() {
    return Err(format!("FFprobe 读取失败：{}", String::from_utf8_lossy(&output.stderr).trim()));
  }

  let document: Value = serde_json::from_slice(&output.stdout).map_err(|error| format!("FFprobe JSON 无效：{error}"))?;
  let format = document.get("format").cloned().unwrap_or_default();
  let streams = document.get("streams").and_then(Value::as_array).cloned().unwrap_or_default();
  let video = streams.iter().find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"));
  let audio = streams.iter().find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"));

  Ok(MediaProbe {
    path,
    format_name: value_string(format.get("format_name")).unwrap_or_else(|| "unknown".into()),
    duration_seconds: format.get("duration").and_then(Value::as_str).and_then(|value| value.parse().ok()),
    size_bytes: value_u64(format.get("size")),
    bit_rate: value_u64(format.get("bit_rate")),
    width: value_u64(video.and_then(|stream| stream.get("width"))),
    height: value_u64(video.and_then(|stream| stream.get("height"))),
    video_codec: value_string(video.and_then(|stream| stream.get("codec_name"))),
    audio_codec: value_string(audio.and_then(|stream| stream.get("codec_name"))),
  })
}

/// Merges a collection of already-downloaded media files with FFmpeg's concat demuxer.
#[tauri::command]
pub async fn merge_collections(input_paths: Vec<String>, output_path: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || merge_collections_sync(input_paths, output_path))
    .await
    .map_err(|e| format!("合并线程中断: {e}"))?
}

fn merge_collections_sync(input_paths: Vec<String>, output_path: String) -> Result<String, String> {
  if input_paths.len() < 2 {
    return Err("至少需要两个媒体文件才能合并".into());
  }
  let inputs: Vec<PathBuf> = input_paths.iter().map(PathBuf::from).collect();
  if let Some(missing) = inputs.iter().find(|path| !path.is_file()) {
    return Err(format!("媒体文件不存在：{}", missing.to_string_lossy()));
  }
  let output = PathBuf::from(&output_path);
  if inputs.iter().any(|path| path == &output) {
    return Err("输出文件不能覆盖输入文件".into());
  }
  let parent = output
    .parent()
    .filter(|path| !path.as_os_str().is_empty())
    .unwrap_or_else(|| Path::new("."));
  if !parent.exists() {
    return Err(format!("输出目录不存在：{}", parent.to_string_lossy()));
  }

  let list_path = parent.join(".ycconcat.txt");
  let mut list = String::from('\u{FEFF}');
  for path in &inputs {
    let name = path
      .file_name()
      .map(|value| value.to_string_lossy().into_owned())
      .unwrap_or_else(|| path.to_string_lossy().replace('\\', "/"));
    list.push_str("file '");
    list.push_str(&name.replace('\'', r"'\''"));
    list.push_str("'\n");
  }
  fs::write(&list_path, list).map_err(|error| format!("创建合并清单失败：{error}"))?;

  let ffmpeg = resolve_binary("ffmpeg");
  let output_name = output
    .file_name()
    .map(|value| value.to_string_lossy().into_owned())
    .unwrap_or_else(|| output_path.clone());
  let mut command = Command::new(&ffmpeg);
  command
    .current_dir(parent)
    .args([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-fflags",
      "+genpts",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      ".ycconcat.txt",
      "-c",
      "copy",
    ])
    .arg(&output_name);
  hide_console(&mut command);
  let result = command
    .output()
    .map_err(|error| format!("无法启动 FFmpeg（{ffmpeg}）：{error}"));
  let _ = fs::remove_file(&list_path);
  let result = result?;
  if !result.status.success() {
    let stderr = String::from_utf8_lossy(&result.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&result.stdout).trim().to_string();
    let detail = if !stderr.is_empty() { stderr } else { stdout };
    return Err(if detail.is_empty() {
      "FFmpeg 合并失败".into()
    } else {
      format!("FFmpeg 合并失败：{detail}")
    });
  }
  Ok(output.to_string_lossy().into_owned())
}


fn escape_xml(value: &str) -> String {
  value
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
    .replace('"', "&quot;")
    .replace('\'', "&apos;")
}

fn tag(name: &str, value: &str) -> String {
  format!("  <{name}>{}</{name}>\n", escape_xml(value))
}

fn optional_tag(name: &str, value: Option<&str>) -> String {
  value.filter(|item| !item.trim().is_empty()).map(|item| tag(name, item)).unwrap_or_default()
}

#[tauri::command]
pub fn generate_emby_nfo(metadata: EmbyMetadata) -> Result<String, String> {
  if metadata.title.trim().is_empty() {
    return Err("NFO 标题不能为空".into());
  }

  let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<movie>\n");
  xml.push_str(&tag("title", &metadata.title));
  xml.push_str(&optional_tag("originaltitle", metadata.original_title.as_deref()));
  if let Some(year) = metadata.year { xml.push_str(&tag("year", &year.to_string())); }
  xml.push_str(&optional_tag("premiered", metadata.premiered.as_deref()));
  xml.push_str(&optional_tag("plot", metadata.plot.as_deref()));
  for genre in &metadata.genres { xml.push_str(&tag("genre", genre)); }
  for director in &metadata.directors { xml.push_str(&tag("director", director)); }
  if let Some(id) = metadata.tmdb_id.as_deref() {
    xml.push_str(&format!("  <uniqueid type=\"tmdb\" default=\"true\">{}</uniqueid>\n", escape_xml(id)));
  }
  if let Some(id) = metadata.imdb_id.as_deref() {
    xml.push_str(&format!("  <uniqueid type=\"imdb\">{}</uniqueid>\n", escape_xml(id)));
  }
  if let Some(media) = metadata.media {
    xml.push_str("  <fileinfo>\n    <streamdetails>\n");
    if let (Some(width), Some(height)) = (media.width, media.height) {
      xml.push_str("      <video>\n");
      xml.push_str(&tag("width", &width.to_string()).replace("  <", "        <"));
      xml.push_str(&tag("height", &height.to_string()).replace("  <", "        <"));
      xml.push_str(&optional_tag("codec", media.video_codec.as_deref()).replace("  <", "        <"));
      xml.push_str("      </video>\n");
    }
    if let Some(codec) = media.audio_codec.as_deref() {
      xml.push_str("      <audio>\n");
      xml.push_str(&tag("codec", codec).replace("  <", "        <"));
      xml.push_str("      </audio>\n");
    }
    xml.push_str("    </streamdetails>\n  </fileinfo>\n");
  }
  xml.push_str("</movie>\n");
  Ok(xml)
}

#[tauri::command]
pub fn write_emby_nfo(media_path: String, metadata: EmbyMetadata) -> Result<String, String> {
  let path = PathBuf::from(&media_path);
  if !path.is_file() { return Err(format!("媒体文件不存在：{media_path}")); }
  let nfo = generate_emby_nfo(metadata)?;
  let nfo_path = path.with_extension("nfo");
  fs::write(&nfo_path, nfo).map_err(|error| format!("写入 NFO 失败：{error}"))?;
  Ok(nfo_path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn write_tvshow_nfo(folder: String, meta: TvShowNfo) -> Result<String, String> {
  if meta.title.trim().is_empty() {
    return Err("剧集标题不能为空".into());
  }
  let dir = PathBuf::from(&folder);
  fs::create_dir_all(&dir).map_err(|e| format!("无法创建剧集目录: {e}"))?;
  let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<tvshow>\n");
  xml.push_str(&tag("title", &meta.title));
  xml.push_str(&optional_tag("plot", meta.plot.as_deref()));
  xml.push_str(&tag("season", "1"));
  if let Some(count) = meta.episode_count {
    xml.push_str(&tag("episode", &count.to_string()));
  }
  for genre in &meta.genres {
    xml.push_str(&tag("genre", genre));
  }
  if let Some(id) = meta.unique_id.as_deref().filter(|s| !s.trim().is_empty()) {
    xml.push_str(&format!(
      "  <uniqueid type=\"yc\" default=\"true\">{}</uniqueid>\n",
      escape_xml(id)
    ));
  }
  let mut written = 0usize;
  for (index, actor) in meta.cast.iter().enumerate() {
    let name = actor.name.trim();
    if name.is_empty() {
      continue;
    }
    xml.push_str("  <actor>\n");
    xml.push_str(&tag("name", name).replace("  <", "    <"));
    xml.push_str(&optional_tag("role", actor.role.as_deref()).replace("  <", "    <"));
    xml.push_str(&optional_tag("thumb", actor.thumb.as_deref()).replace("  <", "    <"));
    xml.push_str(&tag("order", &index.to_string()).replace("  <", "    <"));
    xml.push_str(&tag("type", "Actor").replace("  <", "    <"));
    xml.push_str("  </actor>\n");
    written += 1;
  }
  if written == 0 {
    if let Some(actors) = meta.actors.as_deref() {
      for name in actors.split(|c: char| c == '/' || c == '、' || c == ',' || c == '，' || c == '|') {
        let name = name.trim();
        if name.is_empty() {
          continue;
        }
        xml.push_str("  <actor>\n");
        xml.push_str(&tag("name", name).replace("  <", "    <"));
        xml.push_str("  </actor>\n");
      }
    }
  }
  xml.push_str("</tvshow>\n");
  let nfo_path = dir.join("tvshow.nfo");
  fs::write(&nfo_path, xml).map_err(|e| format!("写入 tvshow.nfo 失败: {e}"))?;
  Ok(nfo_path.to_string_lossy().into_owned())
}


#[tauri::command]
pub fn write_episode_nfo(
  media_path: String,
  show_title: String,
  episode: u32,
  title: Option<String>,
) -> Result<String, String> {
  let path = PathBuf::from(&media_path);
  if !path.is_file() {
    return Err(format!("媒体文件不存在：{media_path}"));
  }
  let ep_title = title
    .as_deref()
    .map(str::trim)
    .filter(|s| !s.is_empty())
    .map(str::to_string)
    .unwrap_or_else(|| format!("第 {episode} 集"));
  let mut xml = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<episodedetails>\n");
  xml.push_str(&tag("title", &ep_title));
  xml.push_str(&tag("showtitle", &show_title));
  xml.push_str(&tag("season", "1"));
  xml.push_str(&tag("episode", &episode.to_string()));
  xml.push_str("</episodedetails>\n");
  let nfo_path = path.with_extension("nfo");
  fs::write(&nfo_path, xml).map_err(|e| format!("写入分集 NFO 失败: {e}"))?;
  Ok(nfo_path.to_string_lossy().into_owned())
}


#[cfg(test)]
mod tests {
  use super::{generate_emby_nfo, EmbyMetadata};

  #[test]
  fn nfo_escapes_xml_and_writes_emby_tags() {
    let result = generate_emby_nfo(EmbyMetadata {
      title: "A & B".into(),
      original_title: None,
      year: Some(2026),
      premiered: None,
      plot: Some("<safe>".into()),
      genres: vec!["Drama".into()],
      directors: vec![],
      tmdb_id: Some("123".into()),
      imdb_id: None,
      media: None,
    }).expect("NFO should be generated");
    assert!(result.contains("<title>A &amp; B</title>"));
    assert!(result.contains("<uniqueid type=\"tmdb\" default=\"true\">123</uniqueid>"));
  }
}
