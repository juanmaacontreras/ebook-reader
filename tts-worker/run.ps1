# Windows counterpart of run.sh (called by run.bat).
param([string]$mode = "")
$startup = $mode -in @("--startup", "startup")
$removeStartup = $mode -in @("--remove-startup", "remove-startup")
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Host 'Installing uv (Python package manager)...'
  Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
  $env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
}

$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'Atril TTS.lnk'
if ($removeStartup) { Remove-Item $link -ErrorAction SilentlyContinue; Write-Host 'Removed from startup.'; exit 0 }

# Python 3.12 + PyTorch (CUDA) + Kokoro + Chatterbox, into .\.venv (~6 GB).
uv sync --frozen

if ($startup) {
  $shell = New-Object -ComObject WScript.Shell
  $s = $shell.CreateShortcut($link)
  $s.TargetPath = (Get-Command uv).Source
  $s.Arguments = 'run --frozen python -m worker'
  $s.WorkingDirectory = $PSScriptRoot
  $s.WindowStyle = 7  # minimized
  $s.Save()
  Write-Host 'Added to startup (starts minimized when you log in).'
}

uv run --frozen python -m worker
