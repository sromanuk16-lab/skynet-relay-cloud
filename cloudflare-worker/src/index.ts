/*
 * SKYNET Relay Cloud v0.1
 *
 * Goal: replace ngrok for development.
 *
 * External ChatGPT Connector URL:
 *   https://<worker>.workers.dev/mcp/<PUBLIC_TOKEN>
 *
 * Local Windows side:
 *   Agent v0.7.2 runs on 127.0.0.1:8787
 *   MCP server runs on 127.0.0.1:8000/mcp
 *   relay_client.py opens a WebSocket to:
 *   wss://<worker>.workers.dev/agent/connect/<AGENT_TOKEN>?device_id=sergey-pc
 *
 * Data flow:
 *   ChatGPT -> Worker /mcp/<PUBLIC_TOKEN> -> Durable Object -> WebSocket -> relay_client.py -> local MCP /mcp
 */

export interface Env {
  DEVICE_SESSIONS: DurableObjectNamespace;
  DEVICE_ID: string;
  PUBLIC_TOKEN: string;
  AGENT_TOKEN: string;
  REQUEST_TIMEOUT_MS?: string;
}

type RelayHttpRequest = {
  type: "http_request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body_base64: string;
};

type RelayHttpResponse = {
  type: "http_response";
  id: string;
  status: number;
  headers?: Record<string, string>;
  body_base64?: string;
  error?: string;
};

type PendingRequest = {
  resolve: (value: RelayHttpResponse) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version",
    "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  if (!base64) return new Uint8Array();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function filteredRequestHeaders(request: Request): Record<string, string> {
  const blocked = new Set([
    "host",
    "connection",
    "content-length",
    "accept-encoding",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
    "cf-visitor",
    "x-forwarded-for",
    "x-forwarded-proto",
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of request.headers.entries()) {
    const lower = k.toLowerCase();
    if (!blocked.has(lower)) out[k] = v;
  }
  return out;
}

function filteredResponseHeaders(input?: Record<string, string>): Headers {
  const headers = new Headers(corsHeaders());
  const blocked = new Set([
    "connection",
    "content-length",
    "transfer-encoding",
    "content-encoding",
    "keep-alive",
    "server",
  ]);
  for (const [k, v] of Object.entries(input || {})) {
    const lower = k.toLowerCase();
    if (!blocked.has(lower)) headers.set(k, v);
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return headers;
}

function getSessionStub(env: Env, deviceId: string): DurableObjectStub {
  const id = env.DEVICE_SESSIONS.idFromName(deviceId || env.DEVICE_ID || "default");
  return env.DEVICE_SESSIONS.get(id);
}

function timingSafeEqualPlain(a: string, b: string): boolean {
  // Worker-side simple constant-length check for v0.1 tokens.
  // We still use long random tokens; v0.2 can switch to HMAC/JWT.
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        app: "SKYNET Relay Cloud",
        version: "0.1.0",
        mode: "cloudflare_worker_durable_object_ws_relay",
        endpoints: {
          status: "/status",
          agent_connect: "/agent/connect/<AGENT_TOKEN>?device_id=sergey-pc",
          mcp: "/mcp/<PUBLIC_TOKEN>",
        },
      });
    }

    if (url.pathname === "/status") {
      const deviceId = url.searchParams.get("device_id") || env.DEVICE_ID || "default";
      const stub = getSessionStub(env, deviceId);
      return stub.fetch(new Request("https://do.local/status"));
    }

    // Local agent connection: /agent/connect/<AGENT_TOKEN>?device_id=sergey-pc
    if (url.pathname.startsWith("/agent/connect/")) {
      const token = decodeURIComponent(url.pathname.slice("/agent/connect/".length));
      if (!env.AGENT_TOKEN || !timingSafeEqualPlain(token, env.AGENT_TOKEN)) {
        return json({ ok: false, error: "bad_agent_token" }, 401);
      }
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return json({ ok: false, error: "websocket_upgrade_required" }, 426);
      }
      const deviceId = url.searchParams.get("device_id") || env.DEVICE_ID || "default";
      const stub = getSessionStub(env, deviceId);
      return stub.fetch(request);
    }

    // ChatGPT/MCP entrypoint: /mcp/<PUBLIC_TOKEN>[/...]
    if (url.pathname.startsWith("/mcp/")) {
      const parts = url.pathname.split("/").filter(Boolean); // ["mcp", token, ...]
      const token = parts[1] || "";
      if (!env.PUBLIC_TOKEN || !timingSafeEqualPlain(token, env.PUBLIC_TOKEN)) {
        return json({ ok: false, error: "bad_public_token" }, 401);
      }

      const deviceId = url.searchParams.get("device_id") || env.DEVICE_ID || "default";
      const tail = parts.slice(2).join("/");
      const localPath = "/mcp" + (tail ? "/" + tail : "");
      const localQuery = new URLSearchParams(url.searchParams);
      localQuery.delete("device_id");
      const targetPath = localPath + (localQuery.toString() ? "?" + localQuery.toString() : "");

      const body = request.method === "GET" || request.method === "HEAD" ? new ArrayBuffer(0) : await request.arrayBuffer();
      const payload = {
        target_path: targetPath,
        method: request.method,
        headers: filteredRequestHeaders(request),
        body_base64: arrayBufferToBase64(body),
      };

      const stub = getSessionStub(env, deviceId);
      return stub.fetch("https://do.local/proxy", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(payload),
      });
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};

export class DeviceSession {
  private state: DurableObjectState;
  private env: Env;
  private agentSocket: WebSocket | null = null;
  private pending = new Map<string, PendingRequest>();
  private connectedAt: string | null = null;
  private lastSeenAt: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/status") {
      return json({
        ok: true,
        connected: this.agentSocket !== null,
        connected_at: this.connectedAt,
        last_seen_at: this.lastSeenAt,
        pending: this.pending.size,
      });
    }

    if (url.pathname.startsWith("/agent/connect/")) {
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      server.accept();

      if (this.agentSocket) {
        try { this.agentSocket.close(1012, "replaced_by_new_agent_connection"); } catch { /* noop */ }
      }

      this.agentSocket = server;
      this.connectedAt = new Date().toISOString();
      this.lastSeenAt = this.connectedAt;

      server.addEventListener("message", (event) => this.onAgentMessage(event));
      server.addEventListener("close", () => this.onAgentClose());
      server.addEventListener("error", () => this.onAgentClose());

      server.send(JSON.stringify({ type: "hello", ok: true, relay: "skynet-relay-cloud", version: "0.1.0" }));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/proxy") {
      if (!this.agentSocket) {
        return json({ ok: false, error: "agent_offline", hint: "Start relay_client.py on the Windows PC." }, 503);
      }

      let incoming: { target_path: string; method: string; headers: Record<string, string>; body_base64: string };
      try {
        incoming = await request.json();
      } catch {
        return json({ ok: false, error: "bad_proxy_request" }, 400);
      }

      const id = crypto.randomUUID();
      const timeoutMs = Math.max(1000, Number(this.env.REQUEST_TIMEOUT_MS || "60000"));
      const message: RelayHttpRequest = {
        type: "http_request",
        id,
        method: incoming.method || "POST",
        path: incoming.target_path || "/mcp",
        headers: incoming.headers || {},
        body_base64: incoming.body_base64 || "",
      };

      const response = await new Promise<RelayHttpResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error("agent_timeout"));
        }, timeoutMs);
        this.pending.set(id, { resolve, reject, timeout });
        try {
          this.agentSocket?.send(JSON.stringify(message));
        } catch (err) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(err);
        }
      }).catch((err: Error) => ({
        type: "http_response" as const,
        id,
        status: 504,
        headers: { "content-type": "application/json; charset=utf-8" },
        body_base64: arrayBufferToBase64(new TextEncoder().encode(JSON.stringify({ ok: false, error: err.message || "agent_timeout" })).buffer),
      }));

      const bytes = base64ToUint8Array(response.body_base64 || "");
      return new Response(bytes, {
        status: response.status || 502,
        headers: filteredResponseHeaders(response.headers),
      });
    }

    return json({ ok: false, error: "do_not_found" }, 404);
  }

  private onAgentMessage(event: MessageEvent) {
    this.lastSeenAt = new Date().toISOString();
    let message: RelayHttpResponse | { type?: string; id?: string };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (message.type === "http_response" && message.id) {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(message.id);
        pending.resolve(message as RelayHttpResponse);
      }
    }
  }

  private onAgentClose() {
    this.agentSocket = null;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("agent_disconnected"));
      this.pending.delete(id);
    }
  }
}
