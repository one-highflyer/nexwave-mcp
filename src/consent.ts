import { escapeHtml } from "./security";

const DEFAULT_SCOPE = "nexwave:read";

type ConsentClient = {
  clientName?: string;
};

type ConsentRequest = {
  scope: string[];
};

type ConsentOptions = {
  scriptNonce: string;
  siteUrl?: string;
  error?: string;
};

export function renderConsent(
  client: ConsentClient,
  request: ConsentRequest,
  pendingId: string,
  csrfToken: string,
  options: ConsentOptions,
): string {
  const clientName = client.clientName || "An MCP client";
  const scopeText = request.scope.length ? request.scope.join(", ") : DEFAULT_SCOPE;
  const error = options.error
    ? `<div class="notice error" role="alert"><span class="notice-icon" aria-hidden="true">!</span><div><strong>Connection not found</strong><p>${escapeHtml(options.error)}</p></div></div>`
    : "";

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect NexWave</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172034;background:#f3f6fb}body{margin:0;display:grid;min-height:100vh;place-items:center}.card{box-sizing:border-box;width:min(520px,calc(100% - 32px));background:#fff;border:1px solid #dce3ef;border-radius:18px;padding:28px;box-shadow:0 16px 50px rgba(28,45,78,.1)}h1{margin:0 0 12px;font-size:28px}p{color:#59667d;line-height:1.55}label{display:block;font-size:13px;font-weight:750;margin:22px 0 7px}input[type=url]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bdc8d9;border-radius:9px;background:#fff;font:inherit}.hint{font-size:13px;margin:7px 0 0}.scope{background:#f2f6fa;border-radius:9px;padding:11px;color:#3f4c61;font-size:14px}[hidden]{display:none!important}.notice{display:flex;gap:12px;align-items:flex-start;margin:18px 0 0;border-radius:10px;padding:13px 14px}.notice strong{display:block;font-size:14px}.notice p{font-size:13px;margin:3px 0 0}.notice-icon{display:grid;flex:0 0 24px;height:24px;place-items:center;border-radius:50%;font-size:13px;font-weight:800}.error{background:#fff1f0;border:1px solid #facac5}.error .notice-icon{background:#c9362b;color:#fff}.error p{color:#7b302a}.progress{background:#eef8f6;border:1px solid #bfe5dc}.progress p{color:#315e55}.spinner{box-sizing:border-box;display:block;flex:0 0 22px;width:22px;height:22px;border:3px solid #b8d9d2;border-top-color:#087a65;border-radius:50%;animation:spin .8s linear infinite}.actions{display:flex;gap:10px;margin-top:22px}button{border:0;border-radius:9px;padding:11px 17px;font:inherit;font-weight:750;cursor:pointer}.approve{background:#087a65;color:#fff}.cancel{background:#e9eef5;color:#3f4c61}form[data-submitting=true] button{pointer-events:none;opacity:.7}form[data-submitting=true] input{background:#f6f8fb;color:#536078}.handoff{margin-top:17px;padding-top:15px;border-top:1px solid #e4e9f1;font-size:13px}.handoff strong{color:#344158}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinner{animation:none;border-color:#087a65}}
  </style></head><body><main class="card"><h1>Connect to NexWave</h1><p><strong>${escapeHtml(clientName)}</strong> wants read-only access to your NexWave site through this MCP server.</p><div class="scope">Requested access: ${escapeHtml(scopeText)}</div>${error}<form id="connect-form" method="post" action="/authorize"><input type="hidden" name="pending_id" value="${escapeHtml(pendingId)}"><input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}"><label for="site_url">Your NexWave site URL</label><input id="site_url" name="site_url" type="url" inputmode="url" autocomplete="url" placeholder="https://your-site.example.com" value="${escapeHtml(options.siteUrl ?? "")}" required><p class="hint">Paste any page URL from your NexWave site. Registered sites are not listed for privacy.</p><div id="connect-status" class="notice progress" role="status" aria-live="polite" hidden><span class="spinner" aria-hidden="true"></span><div><strong>Connecting to NexWave…</strong><p>You may be asked to sign in and approve access. Keep this window open.</p></div></div><div class="actions"><button id="continue-button" class="approve" name="decision" value="approve">Continue to NexWave</button><button class="cancel" name="decision" value="deny">Cancel</button></div><p class="handoff"><strong>What happens next?</strong> Your MCP client will show the final success or failure result after NexWave authorization.</p></form></main><script nonce="${escapeHtml(options.scriptNonce)}">
  const form=document.getElementById("connect-form");const input=document.getElementById("site_url");const status=document.getElementById("connect-status");const button=document.getElementById("continue-button");form.addEventListener("submit",event=>{if(event.submitter&&event.submitter.value==="deny")return;if(form.dataset.submitting==="true"){event.preventDefault();return}form.dataset.submitting="true";form.setAttribute("aria-busy","true");input.readOnly=true;status.hidden=false;button.textContent="Connecting…"});window.addEventListener("pageshow",()=>{form.dataset.submitting="false";form.removeAttribute("aria-busy");input.readOnly=false;status.hidden=true;button.textContent="Continue to NexWave"});
  </script></body></html>`;
}

export function renderErrorPage(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>
  :root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#172034;background:#f3f6fb}body{margin:0;display:grid;min-height:100vh;place-items:center}.card{box-sizing:border-box;width:min(500px,calc(100% - 32px));background:#fff;border:1px solid #dce3ef;border-radius:18px;padding:28px;box-shadow:0 16px 50px rgba(28,45,78,.1)}.icon{display:grid;width:42px;height:42px;place-items:center;border-radius:50%;background:#fff1f0;color:#c9362b;font-size:24px;font-weight:800}h1{margin:18px 0 10px;font-size:26px}p{margin:0;color:#59667d;line-height:1.55}.next{margin-top:18px;padding:13px 14px;border-radius:10px;background:#f2f6fa;color:#3f4c61;font-size:14px}
  </style></head><body><main class="card" role="alert"><div class="icon" aria-hidden="true">!</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><div class="next">Return to your MCP client and start the connection again.</div></main></body></html>`;
}
