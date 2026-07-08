@echo off
cd /d %~dp0

REM SKYNET Relay Client v0.1
REM 1) Start local agent: C:\LondonPCBridge\start_agent.bat
REM 2) Start local MCP:   C:\LondonPCBridge\start_mcp.bat
REM 3) Edit the URL below after Cloudflare deploy
REM 4) Run this file instead of ngrok

set SKYNET_RELAY_URL=wss://YOUR_WORKER_NAME.YOUR_ACCOUNT.workers.dev/agent/connect/YOUR_AGENT_TOKEN?device_id=sergey-pc
set LOCAL_MCP_BASE=http://127.0.0.1:8000
set SKYNET_RELAY_REQUEST_TIMEOUT=60

python -m pip install websockets
python relay_client.py
pause
