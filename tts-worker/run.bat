@echo off
rem One step to install and run the narration worker on Windows.
rem   run.bat            install what's missing, then run in this window
rem   run.bat --startup         also start it automatically when you log in
rem   run.bat --remove-startup
rem First run: a browser page opens (http://127.0.0.1:8765) to sign in once.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
