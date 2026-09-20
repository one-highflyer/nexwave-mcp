import { escapeHtml } from "./security";

const DEFAULT_SCOPE = "nexwave:read";

type ConsentClient = {
  clientName?: string;
};

type ConsentRequest = {
  scope: string[];
};

export function renderConsent(
  client: ConsentClient,
  request: ConsentRequest,
  pendingId: string,
  csrfToken: string,
): string {
  const clientName = client.clientName || "An MCP client";
  const scopeText = request.scope.length ? request.scope.join(", ") : DEFAULT_SCOPE;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect NexWave</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172034;background:#f3f6fb}body{margin:0;display:grid;min-height:100vh;place-items:center}.card{box-sizing:border-box;width:min(500px,calc(100% - 32px));background:#fff;border:1px solid #dce3ef;border-radius:18px;padding:28px;box-shadow:0 16px 50px rgba(28,45,78,.1)}h1{margin:0 0 12px;font-size:28px}p{color:#59667d;line-height:1.55}label{display:block;font-size:13px;font-weight:750;margin:22px 0 7px}input[type=url]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bdc8d9;border-radius:9px;background:#fff;font:inherit}.hint{font-size:13px;margin:7px 0 0}.scope{background:#f2f6fa;border-radius:9px;padding:11px;color:#3f4c61;font-size:14px}.actions{display:flex;gap:10px;margin-top:22px}button{border:0;border-radius:9px;padding:11px 17px;font:inherit;font-weight:750;cursor:pointer}.approve{background:#087a65;color:#fff}.cancel{background:#e9eef5;color:#3f4c61}</style></head><body><main class="card"><h1>Connect to NexWave</h1><p><strong>${escapeHtml(clientName)}</strong> wants read-only access to your NexWave site through this MCP server.</p><div class="scope">Requested access: ${escapeHtml(scopeText)}</div><form method="post" action="/authorize"><input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><label for="site_url">Your NexWave site URL</label><input id="site_url" name="site_url" type="url" inputmode="url" autocomplete="url" placeholder="https://your-site.example.com" required><p class="hint">Paste any page URL from your NexWave site. Registered sites are not listed for privacy.</p><div class="actions"><button class="approve" name="decision" value="approve">Continue to NexWave</button><button class="cancel" name="decision" value="deny">Cancel</button></div></form></main></body></html>`;
}
