/**
 * Mosque Aisha display: admin sign-in gateway (Cloudflare Worker)
 *
 * Lets volunteers sign in to admin.html with their Mosque Aisha Microsoft account instead
 * of a GitHub token. For every request it checks the Microsoft access token (genuine
 * signature, Mosque Aisha's tenant, this app, the Display.Manage permission, and membership
 * of the Display Admins group), then makes the change on GitHub with a token that only
 * this Worker holds. Volunteers never see a GitHub token or need a GitHub account.
 *
 * Only the few GitHub calls the admin page needs are allowed, all for one repository,
 * and everything written is checked again here (settings are re-validated, uploads must
 * be real images).
 *
 * Settings: see wrangler.toml. The GitHub token is a secret:  wrangler secret put GITHUB_TOKEN
 */

const SCOPE = "Display.Manage";
const MAX_BODY = 15 * 1024 * 1024;        // ~10 MB image once base64-encoded
const MAX_IMAGE = 10 * 1024 * 1024;
const WORKFLOW = "update-prayer-times.yml";
const IMAGE_PATH = /^(?!\.)(?!.*\.\.)(?!\.github\/)[\w][\w\-. ()/]{0,180}\.(jpe?g|png|gif|webp)$/i;
const UPLOAD_PATH = /^announcements\/[\w][\w.-]{0,120}\.(jpe?g|png|gif|webp)$/i;

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(env, origin);
    try {
      checkEnv(env);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (origin && origin !== env.ALLOWED_ORIGIN) return json({ message: "This site isn't allowed to use the admin service." }, 403, cors);
      if (+(request.headers.get("Content-Length") || 0) > MAX_BODY) return json({ message: "That upload is too large (10 MB max)." }, 413, cors);

      const user = await verifyMicrosoftToken(request, env);
      const res = await route(request, env, user);
      return withHeaders(res, cors);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json({ message: status === 500 ? "The admin service hit an error." : e.message }, status, cors);
    }
  }
};

/* ------------------------------------------------------------------ */
/* Routing: only these GitHub calls, only for env.GITHUB_OWNER/REPO    */
/* ------------------------------------------------------------------ */

async function route(request, env, user) {
  const url = new URL(request.url);
  const method = request.method;

  if (url.pathname === "/me" && method === "GET") return json({ name: user.name });

  // The admin page calls /github/repos/<owner>/<repo>/<rest>. Owner and repo in the URL are
  // ignored: this Worker only ever touches the repository in its own settings.
  const m = url.pathname.match(/^\/github\/repos\/[^/]+\/[^/]+(\/.*)?$/);
  if (!m) throw httpError(404, "Not found.");
  const rest = (m[1] || "").split("/").map(safeDecode).join("/");
  const repo = `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`;
  const branch = await defaultBranch(env);
  const accept = request.headers.get("Accept") || "application/vnd.github+json";

  // repository info
  if (rest === "" && method === "GET") {
    return json({ name: env.GITHUB_REPO, owner: { login: env.GITHUB_OWNER }, default_branch: branch, permissions: { push: true } });
  }

  // read the two data files
  if ((rest === "/contents/config.json" || rest === "/contents/prayerTimes.json") && method === "GET") {
    return github(env, `${repo}${rest}?ref=${encodeURIComponent(branch)}`, { accept });
  }

  // save settings: re-validated here, whatever the browser sent
  if (rest === "/contents/config.json" && method === "PUT") {
    const body = await readJson(request);
    let cfg;
    try { cfg = JSON.parse(b64ToText(body.content)); } catch { throw httpError(400, "Settings weren't valid JSON."); }
    const clean = JSON.stringify(normaliseConfig(cfg), null, 2) + "\n";
    return github(env, `${repo}/contents/config.json`, {
      method: "PUT",
      body: { message: commitMessage(user, body.message, "update display"), content: textToB64(clean), branch, ...(typeof body.sha === "string" ? { sha: body.sha } : {}) }
    });
  }

  // list images (the tree, trimmed to image files only)
  if (rest === `/git/trees/${branch}` && method === "GET") {
    const res = await github(env, `${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (!res.ok) return res;
    const tree = await res.json();
    return json({ tree: (tree.tree || []).filter((t) => t.type === "blob" && IMAGE_PATH.test(t.path)).map(({ path, sha, size, type }) => ({ path, sha, size, type })) });
  }

  // upload a new slide image
  if (rest.startsWith("/contents/announcements/") && method === "PUT") {
    const path = rest.slice("/contents/".length);
    if (!UPLOAD_PATH.test(path)) throw httpError(400, "Uploads must be .jpg, .png, .gif or .webp files in announcements/.");
    const body = await readJson(request);
    if (body.sha) throw httpError(400, "Uploads can't replace existing files.");
    const bytes = b64ToBytes(body.content);
    if (bytes.length > MAX_IMAGE) throw httpError(413, "That image is too large (10 MB max).");
    const kind = sniffImage(bytes);
    const ext = path.split(".").pop().toLowerCase().replace("jpeg", "jpg");
    if (!kind || kind !== ext) throw httpError(400, "That file isn't a real JPG, PNG, GIF or WebP image.");
    return github(env, `${repo}/contents/${encPath(path)}`, {
      method: "PUT",
      body: { message: commitMessage(user, null, `upload ${path}`), content: body.content, branch }
    });
  }

  // delete an image (images only; never code, settings or the workflow)
  if (rest.startsWith("/contents/") && method === "DELETE") {
    const path = rest.slice("/contents/".length);
    if (!IMAGE_PATH.test(path)) throw httpError(403, "Only images can be deleted from the admin page.");
    const body = await readJson(request);
    if (typeof body.sha !== "string") throw httpError(400, "Missing file version.");
    return github(env, `${repo}/contents/${encPath(path)}`, {
      method: "DELETE",
      body: { message: commitMessage(user, null, `delete ${path}`), sha: body.sha, branch }
    });
  }

  // prayer-times job: status and "Refresh now"
  if (rest === `/actions/workflows/${WORKFLOW}/runs` && method === "GET") {
    const res = await github(env, `${repo}/actions/workflows/${WORKFLOW}/runs?per_page=1`);
    if (!res.ok) return res;
    const r = await res.json();
    return json({ workflow_runs: (r.workflow_runs || []).slice(0, 1).map(({ status, conclusion, created_at, html_url }) => ({ status, conclusion, created_at, html_url })) });
  }
  if (rest === `/actions/workflows/${WORKFLOW}/dispatches` && method === "POST") {
    return github(env, `${repo}/actions/workflows/${WORKFLOW}/dispatches`, { method: "POST", body: { ref: branch } });
  }

  throw httpError(403, "That action isn't allowed from the admin page.");
}

/* ------------------------------------------------------------------ */
/* Microsoft (Entra ID) access-token check                             */
/* ------------------------------------------------------------------ */

let jwksCache = { keys: null, at: 0 };

async function verifyMicrosoftToken(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const parts = token.split(".");
  if (parts.length !== 3) throw httpError(401, "Please sign in with Microsoft.");

  let header, payload;
  try {
    header = JSON.parse(b64urlToText(parts[0]));
    payload = JSON.parse(b64urlToText(parts[1]));
  } catch { throw httpError(401, "Please sign in with Microsoft."); }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw httpError(401, "Unsupported sign-in token.");

  const key = await signingKey(header.kid, env);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw httpError(401, "Sign-in token isn't genuine.");

  const now = Math.floor(Date.now() / 1000);
  const skew = 300;
  if (typeof payload.exp !== "number" || payload.exp < now - skew) throw httpError(401, "Your sign-in has expired. Please sign in again.");
  if (typeof payload.nbf === "number" && payload.nbf > now + skew) throw httpError(401, "Sign-in token isn't valid yet.");

  const t = env.TENANT_ID.toLowerCase();
  if (String(payload.tid || "").toLowerCase() !== t) throw httpError(403, "Only Mosque Aisha accounts can use the display admin.");
  const issuers = [`https://login.microsoftonline.com/${t}/v2.0`, `https://sts.windows.net/${t}/`];
  if (!issuers.includes(String(payload.iss || "").toLowerCase())) throw httpError(401, "Sign-in token came from the wrong place.");
  const audiences = [env.CLIENT_ID.toLowerCase(), `api://${env.CLIENT_ID.toLowerCase()}`];
  if (!audiences.includes(String(payload.aud || "").toLowerCase())) throw httpError(401, "Sign-in token is for a different app.");
  const scopes = String(payload.scp || "").split(" ");
  if (!scopes.includes(SCOPE)) throw httpError(403, "This sign-in didn't include permission to manage the display.");

  if (payload._claim_names && payload._claim_names.groups) {
    throw httpError(403, "Your account is in too many groups for Microsoft to list them. Ask the admin to set the app's groups claim to \"Groups assigned to the application\".");
  }
  const groups = Array.isArray(payload.groups) ? payload.groups.map((g) => String(g).toLowerCase()) : [];
  if (!groups.includes(env.ADMIN_GROUP_ID.toLowerCase())) throw httpError(403, "Your account isn't in the Display Admins group. Ask the mosque's Microsoft 365 admin to add you.");

  const name = String(payload.name || payload.given_name || "Mosque Aisha admin").replace(/[^\p{L}\p{N} .'-]/gu, "").slice(0, 60) || "Mosque Aisha admin";
  return { name, oid: payload.oid };
}

async function signingKey(kid, env) {
  const fresh = Date.now() - jwksCache.at < 60 * 60 * 1000;
  let jwk = fresh && jwksCache.keys?.find((k) => k.kid === kid);
  if (!jwk) {
    const res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(env.TENANT_ID)}/discovery/v2.0/keys`);
    if (!res.ok) throw httpError(503, "Couldn't reach Microsoft to check your sign-in.");
    jwksCache = { keys: (await res.json()).keys || [], at: Date.now() };
    jwk = jwksCache.keys.find((k) => k.kid === kid);
  }
  if (!jwk || jwk.kty !== "RSA") throw httpError(401, "Sign-in token isn't genuine.");
  return crypto.subtle.importKey("jwk", { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}

/* ------------------------------------------------------------------ */
/* GitHub                                                              */
/* ------------------------------------------------------------------ */

let branchCache = { name: null, at: 0 };

async function defaultBranch(env) {
  if (branchCache.name && Date.now() - branchCache.at < 10 * 60 * 1000) return branchCache.name;
  const res = await github(env, `/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}`);
  if (!res.ok) throw httpError(502, "The admin service couldn't reach the GitHub repository. Check its GitHub token.");
  branchCache = { name: (await res.json()).default_branch || "main", at: Date.now() };
  return branchCache.name;
}

async function github(env, path, { method = "GET", body, accept = "application/vnd.github+json" } = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: accept === "application/vnd.github.raw+json" ? accept : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mosque-aisha-display-admin",
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  // pass GitHub's answer through, minus its headers
  const headers = { "Content-Type": res.headers.get("Content-Type") || "application/json" };
  return new Response(res.status === 204 ? null : await res.arrayBuffer(), { status: res.status, headers });
}

// Commit messages are public (the repo is public): name only, never email
function commitMessage(user, requested, fallback) {
  const what = String(requested || "").replace(/^Admin:\s*/i, "").replace(/[^\p{L}\p{N} .,:'()/_-]/gu, "").slice(0, 80) || fallback;
  return `Admin (${user.name}): ${what}`;
}

/* ------------------------------------------------------------------ */
/* Settings validation (same rules as the admin page and the screen)   */
/* ------------------------------------------------------------------ */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
const PRAYER_KEYS = ["fajr", "dhuhr", "jumuah1", "jumuah2", "asr", "maghrib", "isha"];
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v, max) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").slice(0, max);
const num = (v, lo, hi, dflt) => { const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const optNum = (v, lo, hi) => (v === null || v === undefined || v === "") ? null : num(v, lo, hi, null);
const dateStr = (v) => (typeof v === "string" && DATE_RE.test(v) ? v : "");
const timeStr = (v) => (typeof v === "string" && TIME_RE.test(v) ? v.padStart(5, "0") : "");
const locVal = (v) => (Number.isInteger(+v) && +v > 0 && v !== "" && v !== null && typeof v !== "boolean" ? +v : "all");
const boolVal = (v, d) => (typeof v === "boolean" ? v : d);
const idVal = (v, p) => { const s = str(v, 40); return /^[\w-]+$/.test(s) ? s : `${p}-${crypto.randomUUID().slice(0, 12)}`; };
const list = (v, max) => (Array.isArray(v) ? v.filter(isObj).slice(0, max) : []);
function safeSrc(v) {
  const s = str(v, 300).trim();
  if (/^https:\/\/[^\s"'<>()\\]+$/i.test(s)) return s;
  if (/^[\w][\w\-. ()]*(\/[\w][\w\-. ()]*)*\.(jpe?g|png|gif|webp)$/i.test(s) && !s.includes("..")) return s;
  return "";
}

export function normaliseConfig(cfg) {
  const c = isObj(cfg) ? cfg : {};
  const a = isObj(c.alert) ? c.alert : {};
  const n = isObj(c.nightDim) ? c.nightDim : {};
  return {
    version: 1,
    locationId: Math.round(num(c.locationId, 1, 99, 1)),
    slideSeconds: num(c.slideSeconds, 3, 300, 15),
    salahInProgressMin: num(c.salahInProgressMin, 0, 30, 10),
    reloadToken: Math.round(num(c.reloadToken, 0, 1e9, 0)),
    alert: { enabled: boolVal(a.enabled, false), title: str(a.title, 80), text: str(a.text, 400), locations: locVal(a.locations), from: dateStr(a.from), to: dateStr(a.to) },
    ticker: list(c.ticker, 30).map((m) => ({ id: idVal(m.id, "t"), text: str(m.text, 240), enabled: boolVal(m.enabled, true), locations: locVal(m.locations), from: dateStr(m.from), to: dateStr(m.to) })),
    slides: list(c.slides, 60).map((x) => ({ id: idVal(x.id, "s"), src: safeSrc(x.src), enabled: boolVal(x.enabled, true), locations: locVal(x.locations), from: dateStr(x.from), to: dateStr(x.to), seconds: optNum(x.seconds, 3, 300) })).filter((x) => x.src),
    overrides: list(c.overrides, 60).map((o) => ({ id: idVal(o.id, "o"), prayer: PRAYER_KEYS.includes(o.prayer) ? o.prayer : "isha", time: timeStr(o.time), locations: locVal(o.locations), from: dateStr(o.from), to: dateStr(o.to), note: str(o.note, 120) })),
    nightDim: { enabled: boolVal(n.enabled, false), afterIshaMin: num(n.afterIshaMin, 0, 360, 60), beforeFajrMin: num(n.beforeFajrMin, 0, 240, 30), level: num(n.level, 0.3, 0.9, 0.65) }
  };
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function checkEnv(env) {
  for (const k of ["TENANT_ID", "CLIENT_ID", "ADMIN_GROUP_ID", "ALLOWED_ORIGIN", "GITHUB_OWNER", "GITHUB_REPO", "GITHUB_TOKEN"]) {
    if (!env[k] || String(env[k]).startsWith("PASTE-")) throw httpError(500, `Worker setting ${k} is missing.`);
  }
}

function corsHeaders(env, origin) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "null",
    "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-GitHub-Api-Version",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  };
}

function withHeaders(res, extra) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(res.body, { status: res.status, headers: h });
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
}

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

async function readJson(request) {
  try { const v = await request.json(); if (isObj(v)) return v; } catch {}
  throw httpError(400, "Request wasn't valid JSON.");
}

function safeDecode(s) { try { return decodeURIComponent(s); } catch { throw httpError(400, "Bad path."); } }
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");

function b64urlToBytes(s) { return b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/")); }
function b64urlToText(s) { return new TextDecoder().decode(b64urlToBytes(s)); }
function b64ToBytes(s) {
  if (typeof s !== "string") throw httpError(400, "Missing file content.");
  const clean = s.replace(/\s/g, "");
  const padded = clean + "===".slice((clean.length + 3) % 4);
  let bin;
  try { bin = atob(padded); } catch { throw httpError(400, "File content wasn't valid base64."); }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64ToText(s) { return new TextDecoder().decode(b64ToBytes(s)); }
function textToB64(t) {
  const bytes = new TextEncoder().encode(t);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function sniffImage(b) {
  const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}
