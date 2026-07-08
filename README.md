# SKYNET Relay Cloud v0.1

Goal: replace ngrok for the current London PC Bridge / Skynet Agent development setup.

## Architecture

```text
ChatGPT Connector
  -> https://<worker>.workers.dev/mcp/<PUBLIC_TOKEN>
  -> Cloudflare Worker
  -> Durable Object device session
  -> WebSocket
  -> relay_client.py on Windows
  -> http://127.0.0.1:8000/mcp
  -> local Skynet Agent on 127.0.0.1:8787
```

## What this is

A minimal one-user relay:

- one `DEVICE_ID` (`sergey-pc` by default)
- one public MCP token for ChatGPT URL
- one private agent token for the local Windows relay client
- no accounts/subscriptions yet
- no D1 database yet
- no file deletion / no PC control added here

## Deploy to Cloudflare

```bat
cd cloudflare-worker
npm install
npx wrangler login
```

Edit `wrangler.toml`:

```toml
DEVICE_ID = "sergey-pc"
PUBLIC_TOKEN = "long-random-public-token"
```

Set private agent token as a Cloudflare secret:

```bat
npx wrangler secret put AGENT_TOKEN
```

Deploy:

```bat
npm run deploy
```

Check:

```text
https://<worker>.workers.dev/health
https://<worker>.workers.dev/status
```

## Start local side

Copy `agent-relay/relay_client.py` and `agent-relay/start_relay_client.bat` to `C:\LondonPCBridge`.

Run:

```bat
cd C:\LondonPCBridge
start_agent.bat
start_mcp.bat
```

Edit `start_relay_client.bat`:

```bat
set SKYNET_RELAY_URL=wss://<worker>.workers.dev/agent/connect/<AGENT_TOKEN>?device_id=sergey-pc
```

Then run:

```bat
start_relay_client.bat
```

## ChatGPT Connector URL

Use:

```text
https://<worker>.workers.dev/mcp/<PUBLIC_TOKEN>
```

That external path is mapped internally to the local MCP server path:

```text
http://127.0.0.1:8000/mcp
```

## Security notes for v0.1

- `PUBLIC_TOKEN` must be long and random because it protects the public MCP URL.
- `AGENT_TOKEN` must be long and random because it lets a local agent attach to the device session.
- Do not commit real tokens to GitHub.
- v0.1 is development-only. v0.2 should add accounts, signed device tokens, and per-user sessions.
