# SKYNET Agent Relay Client v0.1

This client replaces ngrok for the current dev setup.

Run order on Windows:

```bat
cd C:\LondonPCBridge
start_agent.bat
start_mcp.bat
```

Then edit `start_relay_client.bat` and put your real Worker URL/token:

```bat
set SKYNET_RELAY_URL=wss://<worker>.workers.dev/agent/connect/<AGENT_TOKEN>?device_id=sergey-pc
```

Then run:

```bat
start_relay_client.bat
```

While this window is open, the public MCP endpoint is:

```text
https://<worker>.workers.dev/mcp/<PUBLIC_TOKEN>
```

No ngrok needed.
