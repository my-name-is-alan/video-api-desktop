$ErrorActionPreference = 'Stop'
$dest = Split-Path -Parent $MyInvocation.MyCommand.Path
$zip = Join-Path $env:TEMP 'ffmpeg-essentials.zip'
$extract = Join-Path $env:TEMP 'ffmpeg-essentials'
Write-Host "Downloading FFmpeg essentials..."
Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip
if (Test-Path $extract) { Remove-Item -Recurse -Force $extract }
Expand-Archive -Path $zip -DestinationPath $extract -Force
$ffmpeg = Get-ChildItem -Path $extract -Recurse -Filter ffmpeg.exe | Select-Object -First 1
$ffprobe = Get-ChildItem -Path $extract -Recurse -Filter ffprobe.exe | Select-Object -First 1
if (-not $ffmpeg -or -not $ffprobe) { throw 'ffmpeg.exe / ffprobe.exe not found in zip' }
Copy-Item -Force $ffmpeg.FullName (Join-Path $dest 'ffmpeg-x86_64-pc-windows-msvc.exe')
Copy-Item -Force $ffprobe.FullName (Join-Path $dest 'ffprobe-x86_64-pc-windows-msvc.exe')
Copy-Item -Force $ffmpeg.FullName (Join-Path $dest 'ffmpeg.exe')
Copy-Item -Force $ffprobe.FullName (Join-Path $dest 'ffprobe.exe')
Get-ChildItem $dest -Filter '*.exe' | Select-Object Name, Length
