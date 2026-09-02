# FFmpeg sidecars

将对应平台的 FFmpeg 二进制放在这里，文件名必须包含 Rust target triple：

- `ffmpeg-x86_64-pc-windows-msvc.exe`
- `ffprobe-x86_64-pc-windows-msvc.exe`

应用运行时会优先查找 `YCDOWNLOAD_FFMPEG` / `YCDOWNLOAD_FFPROBE` 环境变量，其次查找安装目录中的 `ffmpeg.exe`、`ffprobe.exe` 和 `binaries` 子目录，最后回退到系统 `PATH`。仓库不直接提交第三方二进制文件；开发机也可以直接安装 FFmpeg 并加入 PATH。
