// Portal confidencial Pina
// - O PDF nunca é servido: o painel /admin converte cada página em imagem no
//   navegador e só as imagens ficam guardadas (KV).
// - As imagens só saem com sessão válida e embaralhadas (XOR com chave da sessão).
// - Todo acesso é registrado (data/hora, IP, local, provedor, VPN) e avisado por e-mail.

const VIEW_SESSION_MIN = 60; // duração máxima de uma sessão do cliente
const ADMIN_SESSION_MIN = 240;
const TZ = "America/Sao_Paulo";

const enc = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (!env.ADMIN_PASSWORD) return json({ error: "Portal ainda não configurado (ADMIN_PASSWORD)." }, 500);

      // ---------- cliente ----------
      if (path === "/api/login" && request.method === "POST") return login(request, env, ctx);
      if (path === "/api/logout" && request.method === "POST") return logout();
      if (path === "/api/doc" && request.method === "GET") return docInfo(request, env);
      const pm = path.match(/^\/api\/page\/(\d+)$/);
      if (pm && request.method === "GET") return pageImage(request, env, Number(pm[1]));

      // ---------- admin ----------
      if (path === "/api/admin/login" && request.method === "POST") return adminLogin(request, env);
      if (path.startsWith("/api/admin/")) {
        const s = await readSession(request, env, "a");
        if (!s) return json({ error: "Não autorizado" }, 401);
        return admin(request, env, ctx, path.slice("/api/admin/".length));
      }
      return json({ error: "Não encontrado" }, 404);
    } catch (e) {
      console.error(e);
      return json({ error: "Erro interno" }, 500);
    }
  },
};

// ======================= cliente =======================

async function login(request, env, ctx) {
  const { password } = await request.json().catch(() => ({}));
  const cfg = await getConfig(env);
  const doc = await env.STORE.get("doc", "json");
  const now = Date.now();

  let ok = false;
  let reason = "";
  if (!doc) reason = "Nenhum documento disponível no momento.";
  else if (!cfg.passHash) reason = "Acesso encerrado.";
  else if (now > cfg.expiresAt) reason = "Esta senha expirou. Solicite uma nova.";
  else if (typeof password === "string" && timingSafeEqual(await sha256(cfg.salt + password.trim()), cfg.passHash)) ok = true;
  else reason = "Senha incorreta.";

  if (!ok) {
    await sleep(900); // desacelera tentativas de adivinhar
    return json({ error: reason }, 401);
  }

  const visitor = await describeVisitor(request, env);
  const id = crypto.randomUUID();
  const entry = { id, at: now, ...visitor, doc: doc.title };
  const exp = Math.min(now + VIEW_SESSION_MIN * 60_000, cfg.expiresAt);
  const token = await signSession(env, cfg, { r: "v", id, exp, ip: visitor.ip, at: now });

  ctx.waitUntil(
    Promise.all([
      env.STORE.put(`log:${String(9e15 - now).padStart(16, "0")}:${id}`, JSON.stringify(entry), {
        expirationTtl: 60 * 60 * 24 * 365,
      }),
      notifyAccess(env, entry),
    ]).catch((e) => console.error("log/notify", e)),
  );

  return json({ ok: true }, 200, { "Set-Cookie": cookie("pv", token, exp) });
}

function logout() {
  return json({ ok: true }, 200, { "Set-Cookie": cookie("pv", "", 0) });
}

async function docInfo(request, env) {
  const s = await readSession(request, env, "v");
  if (!s) return json({ error: "Sessão expirada" }, 401);
  const doc = await env.STORE.get("doc", "json");
  if (!doc) return json({ error: "Documento indisponível" }, 404);
  return json({
    title: doc.title,
    pages: doc.pages,
    sizes: doc.sizes,
    key: await sessionKeyB64(env, s.id),
    watermark: {
      ip: s.ip,
      at: fmtDate(s.at),
      id: s.id.slice(0, 8).toUpperCase(),
    },
    expiresAt: s.exp,
  });
}

async function pageImage(request, env, n) {
  const s = await readSession(request, env, "v");
  if (!s) return new Response("", { status: 401 });
  const doc = await env.STORE.get("doc", "json");
  if (!doc || n < 1 || n > doc.pages) return new Response("", { status: 404 });
  const buf = await env.STORE.get(`page:${doc.version}:${n}`, "arrayBuffer");
  if (!buf) return new Response("", { status: 404 });
  const key = await sessionKey(env, s.id);
  const out = new Uint8Array(buf);
  for (let i = 0; i < out.length; i++) out[i] ^= key[i & 31];
  return new Response(out, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

// ======================= admin =======================

async function adminLogin(request, env) {
  const { password } = await request.json().catch(() => ({}));
  if (typeof password !== "string" || !timingSafeEqual(await sha256("admin|" + password), await sha256("admin|" + env.ADMIN_PASSWORD))) {
    await sleep(1200);
    return json({ error: "Senha incorreta." }, 401);
  }
  const cfg = await getConfig(env);
  const exp = Date.now() + ADMIN_SESSION_MIN * 60_000;
  const token = await signSession(env, cfg, { r: "a", id: crypto.randomUUID(), exp });
  return json({ ok: true }, 200, { "Set-Cookie": cookie("pa", token, exp) });
}

async function admin(request, env, ctx, action) {
  const M = request.method;

  if (action === "status" && M === "GET") {
    const cfg = await getConfig(env);
    const doc = await env.STORE.get("doc", "json");
    return json({
      doc: doc && { title: doc.title, pages: doc.pages, uploadedAt: doc.uploadedAt },
      password: cfg.passHash ? { expiresAt: cfg.expiresAt, expired: Date.now() > cfg.expiresAt, createdAt: cfg.createdAt } : null,
      emailConfigured: Boolean(env.RESEND_API_KEY && env.NOTIFY_EMAIL),
    });
  }

  if (action === "logs" && M === "GET") {
    const list = await env.STORE.list({ prefix: "log:", limit: 200 });
    const logs = (await Promise.all(list.keys.map((k) => env.STORE.get(k.name, "json")))).filter(Boolean);
    logs.sort((a, b) => b.at - a.at);
    return json({ logs });
  }

  // Upload: o navegador do admin renderiza o PDF e envia cada página como JPEG.
  if (action === "upload/start" && M === "POST") {
    const { title, pages, sizes } = await request.json();
    if (!(pages > 0 && pages <= 400)) return json({ error: "Número de páginas inválido" }, 400);
    const version = crypto.randomUUID().slice(0, 8);
    await env.STORE.put("upload", JSON.stringify({ version, title: String(title || "Documento").slice(0, 120), pages, sizes }), {
      expirationTtl: 60 * 60 * 6,
    });
    return json({ version });
  }
  const up = action.match(/^upload\/page\/([\w-]+)\/(\d+)$/);
  if (up && M === "PUT") {
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 20 * 1024 * 1024) return json({ error: "Página muito grande" }, 413);
    await env.STORE.put(`page:${up[1]}:${up[2]}`, buf);
    return json({ ok: true });
  }
  if (action === "upload/finish" && M === "POST") {
    const pending = await env.STORE.get("upload", "json");
    if (!pending) return json({ error: "Nenhum envio em andamento" }, 400);
    const old = await env.STORE.get("doc", "json");
    await env.STORE.put("doc", JSON.stringify({ ...pending, uploadedAt: Date.now() }));
    await env.STORE.delete("upload");
    if (old) ctx.waitUntil(deletePages(env, old));
    return json({ ok: true });
  }

  if (action === "password" && M === "POST") {
    const { days } = await request.json().catch(() => ({}));
    const d = Math.min(Math.max(Number(days) || 7, 1), 90);
    const password = generatePassword();
    const salt = crypto.randomUUID();
    const now = Date.now();
    const cfg = {
      salt,
      passHash: await sha256(salt + password),
      createdAt: now,
      expiresAt: now + d * 86_400_000,
      version: crypto.randomUUID(), // invalida sessões abertas com a senha anterior
    };
    await env.STORE.put("config", JSON.stringify(cfg));
    ctx.waitUntil(
      sendEmail(
        env,
        "Nova senha temporária do portal Pina",
        `<p>Senha gerada para o cliente: <b style="font-size:18px;letter-spacing:1px">${esc(password)}</b></p>
         <p>Válida até <b>${esc(fmtDate(cfg.expiresAt))}</b>.</p>`,
      ).catch(() => {}),
    );
    // Nova sessão admin (a versão mudou)
    const token = await signSession(env, cfg, { r: "a", id: crypto.randomUUID(), exp: now + ADMIN_SESSION_MIN * 60_000 });
    return json({ password, expiresAt: cfg.expiresAt }, 200, {
      "Set-Cookie": cookie("pa", token, now + ADMIN_SESSION_MIN * 60_000),
    });
  }

  if (action === "revoke" && M === "POST") {
    const cfg = { version: crypto.randomUUID(), passHash: null, expiresAt: 0 };
    await env.STORE.put("config", JSON.stringify(cfg));
    const token = await signSession(env, cfg, { r: "a", id: crypto.randomUUID(), exp: Date.now() + ADMIN_SESSION_MIN * 60_000 });
    return json({ ok: true }, 200, { "Set-Cookie": cookie("pa", token, Date.now() + ADMIN_SESSION_MIN * 60_000) });
  }

  if (action === "document" && M === "DELETE") {
    const doc = await env.STORE.get("doc", "json");
    await env.STORE.delete("doc");
    if (doc) ctx.waitUntil(deletePages(env, doc));
    return json({ ok: true });
  }

  if (action === "test-email" && M === "POST") {
    const r = await sendEmail(env, "Teste do portal Pina", "<p>Os avisos de acesso estão funcionando. ✅</p>");
    return json(r, r.ok ? 200 : 500);
  }

  if (action === "logout" && M === "POST") return json({ ok: true }, 200, { "Set-Cookie": cookie("pa", "", 0) });

  return json({ error: "Não encontrado" }, 404);
}

async function deletePages(env, doc) {
  for (let i = 1; i <= doc.pages; i++) await env.STORE.delete(`page:${doc.version}:${i}`);
}

// ======================= visitante / VPN =======================

const VPN_HINTS = [
  "vpn", "proxy", "nord", "express", "surfshark", "mullvad", "proton", "private internet", "cyberghost",
  "hide.me", "windscribe", "m247", "datacamp", "cdn77", "hostinger", "digitalocean", "linode", "akamai",
  "vultr", "choopa", "ovh", "hetzner", "amazon", "aws", "google cloud", "microsoft", "azure", "oracle",
  "leaseweb", "contabo", "hosting", "datacenter", "data center", "server", "tor ", "zscaler",
];

async function describeVisitor(request, env) {
  const cf = request.cf || {};
  const ip = request.headers.get("CF-Connecting-IP") || "desconhecido";
  const org = cf.asOrganization || "";
  const v = {
    ip,
    city: cf.city || "",
    region: cf.region || "",
    country: cf.country || "",
    org,
    asn: cf.asn || "",
    userAgent: (request.headers.get("User-Agent") || "").slice(0, 300),
    device: describeUA(request.headers.get("User-Agent") || ""),
    vpn: "não detectado",
  };
  const low = org.toLowerCase();
  if (low.includes("cloudflare")) v.vpn = "provável (Cloudflare WARP / iCloud Private Relay)";
  else if (low.includes("apple")) v.vpn = "provável (iCloud Private Relay)";
  else if (VPN_HINTS.some((h) => low.includes(h))) v.vpn = `provável (IP de datacenter/VPN: ${org})`;

  // Checagem extra gratuita (proxycheck.io) — não bloqueia o acesso se falhar.
  try {
    const q = new URL(`https://proxycheck.io/v2/${encodeURIComponent(ip)}`);
    q.searchParams.set("vpn", "1");
    q.searchParams.set("asn", "1");
    if (env.PROXYCHECK_KEY) q.searchParams.set("key", env.PROXYCHECK_KEY);
    const r = await fetch(q, { signal: AbortSignal.timeout(2500) });
    const data = await r.json();
    const info = data && data[ip];
    if (info) {
      if (info.proxy === "yes") v.vpn = `SIM — ${info.type || "VPN/Proxy"}${info.provider ? " (" + info.provider + ")" : ""}`;
      else if (v.vpn === "não detectado") v.vpn = "não";
      if (!v.org && info.provider) v.org = info.provider;
    }
  } catch {}
  return v;
}

function describeUA(ua) {
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "?";
  const br = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "?";
  return `${br} · ${os}`;
}

async function notifyAccess(env, e) {
  const where = [e.city, e.region, e.country].filter(Boolean).join(", ") || "—";
  const rows = [
    ["Documento", e.doc],
    ["Data e hora", fmtDate(e.at) + " (Brasília)"],
    ["IP", e.ip],
    ["Local aproximado", where],
    ["Provedor", `${e.org || "—"}${e.asn ? " (AS" + e.asn + ")" : ""}`],
    ["VPN / Proxy", e.vpn],
    ["Dispositivo", e.device],
  ]
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#666">${k}</td><td style="padding:6px 0"><b>${esc(v)}</b></td></tr>`)
    .join("");
  return sendEmail(env, `👀 Acesso ao portal Pina — ${fmtDate(e.at)}`, `<p>Alguém acabou de abrir o material confidencial.</p><table>${rows}</table>`);
}

async function sendEmail(env, subject, html) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return { ok: false, error: "E-mail não configurado" };
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "Portal Pina <onboarding@resend.dev>",
      to: [env.NOTIFY_EMAIL],
      subject,
      html: `<div style="font-family:Arial,sans-serif;font-size:14px;color:#222">${html}</div>`,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("resend", r.status, t);
    return { ok: false, error: `Resend ${r.status}: ${t.slice(0, 200)}` };
  }
  return { ok: true };
}

// ======================= sessão / cripto =======================

async function getConfig(env) {
  let cfg = await env.STORE.get("config", "json");
  if (!cfg) {
    cfg = { version: crypto.randomUUID(), passHash: null, expiresAt: 0 };
    await env.STORE.put("config", JSON.stringify(cfg));
  }
  return cfg;
}

async function hmacKey(env, cfgVersion) {
  return crypto.subtle.importKey("raw", enc.encode(`${env.ADMIN_PASSWORD}|${cfgVersion}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signSession(env, cfg, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env, cfg.version), enc.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

async function readSession(request, env, role) {
  const raw = getCookie(request, role === "a" ? "pa" : "pv");
  if (!raw || !raw.includes(".")) return null;
  const [body, sig] = raw.split(".");
  const cfg = await getConfig(env);
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env, cfg.version), unb64url(sig), enc.encode(body));
  if (!ok) return null;
  const p = JSON.parse(new TextDecoder().decode(unb64url(body)));
  if (p.r !== role || Date.now() > p.exp) return null;
  if (role === "v" && (!cfg.passHash || Date.now() > cfg.expiresAt)) return null;
  return p;
}

async function sessionKey(env, id) {
  const k = await crypto.subtle.importKey("raw", enc.encode("page|" + env.ADMIN_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(id)));
}
async function sessionKeyB64(env, id) {
  return b64url(await sessionKey(env, id));
}

function cookie(name, value, exp) {
  const maxAge = Math.max(0, Math.floor((exp - Date.now()) / 1000));
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
function getCookie(request, name) {
  const m = (request.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : null;
}

async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function generatePassword() {
  // sem caracteres ambíguos (0/O, 1/l/I)
  const A = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const s = [...bytes].map((b) => A[b % A.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s) {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function fmtDate(ts) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, dateStyle: "short", timeStyle: "medium" }).format(new Date(ts));
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
