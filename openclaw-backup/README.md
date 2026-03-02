# OpenClaw backup

This folder contains a backup of the OpenClaw state needed to keep agent workspaces (SOUL/USER/MEMORY + daily memory logs) and gateway config from being lost.

Included:
- `.openclaw/openclaw.json`
- `workspaces/ws-bot-*` (agent workspaces)

Excluded:
- secrets / credentials / token files

Restore (manual):
- copy `.openclaw/openclaw.json` back to `C:\Users\openclawsvc\.openclaw\openclaw.json`
- copy desired workspace folder back to `C:\Users\openclawsvc\.openclaw\ws-bot-<name>`
