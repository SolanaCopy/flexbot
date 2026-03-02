@echo off
setlocal

REM Backup OpenClaw state into the flexbot repo and push.
REM Repo path:
set REPO=C:\Users\openclawsvc\.openclaw\ws-bot-default\repos\flexbot
set SRC=C:\Users\openclawsvc\.openclaw

if not exist "%REPO%" (
  echo Repo not found: %REPO%
  exit /b 1
)

cd /d "%REPO%"

if not exist openclaw-backup\.openclaw mkdir openclaw-backup\.openclaw
if not exist openclaw-backup\workspaces mkdir openclaw-backup\workspaces

copy /y "%SRC%\openclaw.json" openclaw-backup\.openclaw\openclaw.json >nul

robocopy "%SRC%\ws-bot-default"   "openclaw-backup\workspaces\ws-bot-default"   /E /XD repos .git /NFL /NDL /NJH /NJS /NC /NS /NP
robocopy "%SRC%\ws-bot-affiliate" "openclaw-backup\workspaces\ws-bot-affiliate" /E /XD .git /NFL /NDL /NJH /NJS /NC /NS /NP
robocopy "%SRC%\ws-bot-fxcopie"   "openclaw-backup\workspaces\ws-bot-fxcopie"   /E /XD .git /NFL /NDL /NJH /NJS /NC /NS /NP
robocopy "%SRC%\ws-bot-builder"   "openclaw-backup\workspaces\ws-bot-builder"   /E /XD .git /NFL /NDL /NJH /NJS /NC /NS /NP

git add openclaw-backup
git commit -m "OpenClaw backup" >nul 2>nul
git push

echo Done.
