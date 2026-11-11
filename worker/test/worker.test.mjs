// Tests for the sign-in Worker. Run: node --test worker/test/
// Microsoft and GitHub are simulated, with real RS256 signatures from a test key.
import test from "node:test";
import assert from "node:assert/strict";
import worker, { normaliseConfig } from "../src/index.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const GROUP = "99999999-8888-7777-6666-555555555555";
const ORIGIN = "https://amasud5550.github.io";
const env = { TENANT_ID: TENANT, CLIENT_ID: CLIENT, ADMIN_GROUP_ID: GROUP, ALLOWED_ORIGIN: ORIGIN, GITHUB_OWNER: "Amasud5550", GITHUB_REPO: "mosque-aisha-display", GITHUB_TOKEN: "github_pat_test" };

// ---- simulated Microsoft signing keys ----
const good = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const evil = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pubJwk = { ...(await crypto.subtle.exportKey("jwk", good.publicKey)), kid: "k1", use: "sig" };
const b64u = (buf) => Buffer.from(buf).toString("base64url");
async function token(claims = {}, { key = good.privateKey, kid = "k1", alg = "RS256" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { aud: CLIENT, iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, scp: "Display.Manage", groups: [GROUP], name: "Test Volunteer", oid: "u1", exp: now + 3600, nbf: now - 10, iat: now - 10, ...claims };
  const head = b64u(JSON.stringify({ alg, kid, typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

// ---- simulated GitHub ----
const calls = [];
const files = {
  "config.json": JSON.stringify({ version: 1, slides: [], ticker: [] }),
  "prayerTimes.json": JSON.stringify({ day: "2026-11-11", locations: [] }),
};
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith("https://login.microsoftonline.com/")) return Response.json({ keys: [pubJwk] });
  const u = new URL(url);
  const method = opts.method || "GET";
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ method, path: u.pathname + u.search, body, auth: opts.headers?.Authorization });
  assert.equal(opts.headers.Authorization, "Bearer github_pat_test");
  assert.ok(u.pathname.startsWith("/repos/Amasud5550/mosque-aisha-display"), "only the one repo: " + u.pathname);
  if (u.pathname === "/repos/Amasud5550/mosque-aisha-display") return Response.json({ default_branch: "main" });
  if (u.pathname.endsWith("/git/trees/main")) return Response.json({ tree: [{ path: "config.json", type: "blob", sha: "1", size: 9 }, { path: "a.png", type: "blob", sha: "2", size: 9 }, { path: ".github/workflows/update-prayer-times.yml", type: "blob", sha: "3", size: 9 }] });
  if (u.pathname.endsWith("/runs")) return Response.json({ workflow_runs: [{ status: "completed", conclusion: "success", created_at: "x", html_url: "h", actor: { login: "secret" } }] });
  if (u.pathname.endsWith("/dispatches")) return new Response(null, { status: 204 });
  const m = u.pathname.match(/\/contents\/(.+)$/);
  if (m) {
    const p = decodeURIComponent(m[1]);
    if (method === "GET") return p in files ? Response.json({ sha: "s", content: Buffer.from(files[p]).toString("base64") }) : Response.json({ message: "Not Found" }, { status: 404 });
    if (method === "PUT") { files[p] = Buffer.from(body.content, "base64").toString("latin1"); return Response.json({ content: { sha: "new" } }, { status: 201 }); }
    if (method === "DELETE") { delete files[p]; return Response.json({}); }
  }
  return Response.json({ message: "unexpected " + u.pathname }, { status: 500 });
};

async function call(path, { method = "GET", tok, body, origin = ORIGIN, headers = {} } = {}) {
  const h = { ...(origin ? { Origin: origin } : {}), ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers };
  const res = await worker.fetch(new Request("https://worker.test" + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), env);
  let data = null; try { data = await res.clone().json(); } catch {}
  return { status: res.status, data, res };
}
const R = "/github/repos/Amasud5550/mosque-aisha-display";
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]).toString("base64");

// ---------------- sign-in checks ----------------
test("valid Mosque Aisha volunteer can read settings", async () => {
  const r = await call(R + "/contents/config.json", { tok: await token() });
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});
test("/me returns the volunteer's name", async () => {
  const r = await call("/me", { tok: await token({ name: "Aisha Volunteer" }) });
  assert.deepEqual(r.data, { name: "Aisha Volunteer" });
});
test("no token is refused", async () => assert.equal((await call(R + "/contents/config.json")).status, 401));
test("garbage token is refused", async () => assert.equal((await call(R, { tok: "abc.def.ghi" })).status, 401));
test("token signed by someone else's key is refused", async () => assert.equal((await call(R, { tok: await token({}, { key: evil.privateKey }) })).status, 401));
test("unsigned 'alg: none' token is refused", async () => {
  const t = (await token()).split("."); const none = Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url");
  assert.equal((await call(R, { tok: `${none}.${t[1]}.` })).status, 401);
});
test("token with tampered claims is refused", async () => {
  const [h, , s] = (await token({ groups: [] })).split(".");
  const forged = Buffer.from(JSON.stringify({ aud: CLIENT, iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, tid: TENANT, scp: "Display.Manage", groups: [GROUP], exp: 9e9 })).toString("base64url");
  assert.equal((await call(R, { tok: `${h}.${forged}.${s}` })).status, 401);
});
test("expired token is refused", async () => assert.equal((await call(R, { tok: await token({ exp: Math.floor(Date.now() / 1000) - 3600 }) })).status, 401));
test("account from another tenant is refused", async () => {
  const other = "00000000-0000-0000-0000-000000000000";
  assert.equal((await call(R, { tok: await token({ tid: other, iss: `https://login.microsoftonline.com/${other}/v2.0` }) })).status, 403);
});
test("token for a different app is refused", async () => assert.equal((await call(R, { tok: await token({ aud: "00000003-0000-0000-c000-000000000000" }) })).status, 401));
test("token without the Display.Manage permission is refused", async () => assert.equal((await call(R, { tok: await token({ scp: "User.Read" }) })).status, 403));
test("Mosque Aisha account NOT in Display Admins group is refused", async () => {
  const r = await call(R, { tok: await token({ groups: ["12345678-0000-0000-0000-000000000000"] }) });
  assert.equal(r.status, 403); assert.match(r.data.message, /Display Admins/);
});
test("group overage is explained, not silently allowed", async () => {
  const r = await call(R, { tok: await token({ groups: undefined, _claim_names: { groups: "src1" } }) });
  assert.equal(r.status, 403); assert.match(r.data.message, /too many groups/);
});
test("requests from another website are refused", async () => assert.equal((await call(R, { tok: await token(), origin: "https://evil.example" })).status, 403));
test("v1 token issuer and api:// audience are accepted", async () => {
  assert.equal((await call(R, { tok: await token({ iss: `https://sts.windows.net/${TENANT}/`, aud: `api://${CLIENT}` }) })).status, 200);
});

// ---------------- what a signed-in volunteer may do ----------------
test("saving settings re-validates them on the server and records the name only", async () => {
  const hostile = { slideSeconds: '"><img onerror=x>', slides: [{ src: "javascript:alert(1)" }, { src: "ok.png", seconds: "9999" }], ticker: [{ text: "Hi" }], extra: "ignored" };
  const r = await call(R + "/contents/config.json", { method: "PUT", tok: await token({ name: "Test Volunteer", preferred_username: "vol@mosqueaisha.ca" }), body: { message: "Admin: update display", content: Buffer.from(JSON.stringify(hostile)).toString("base64"), sha: "s", branch: "evil-branch" } });
  assert.equal(r.status, 201);
  const put = calls.findLast((c) => c.method === "PUT");
  const saved = JSON.parse(Buffer.from(put.body.content, "base64").toString());
  assert.equal(saved.slideSeconds, 15);
  assert.deepEqual(saved.slides.map((s) => [s.src, s.seconds]), [["ok.png", 300]]);
  assert.equal(saved.extra, undefined);
  assert.equal(put.body.branch, "main", "branch is forced");
  assert.equal(put.body.message, "Admin (Test Volunteer): update display");
  assert.ok(!put.body.message.includes("@"), "no email in public history");
});
test("uploading a real PNG to announcements/ works", async () => {
  const r = await call(R + "/contents/announcements/20261111-poster.png", { method: "PUT", tok: await token(), body: { message: "x", content: png, branch: "main" } });
  assert.equal(r.status, 201);
});
test("a script disguised as .png is refused", async () => {
  const fake = Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64");
  assert.equal((await call(R + "/contents/announcements/evil.png", { method: "PUT", tok: await token(), body: { content: fake } })).status, 400);
});
test("uploads outside announcements/ (e.g. replacing the screen's code) are refused", async () => {
  for (const p of ["index.html", "screen.js", "announcements/../index.html", ".github/workflows/update-prayer-times.yml", "announcements/x.svg", "announcements/sub/x.png"]) {
    const r = await call(R + "/contents/" + p.split("/").map(encodeURIComponent).join("/"), { method: "PUT", tok: await token(), body: { content: png } });
    assert.ok([400, 403].includes(r.status), `${p} → ${r.status}`);
  }
});
test("overwriting an existing image is refused", async () => {
  assert.equal((await call(R + "/contents/announcements/a.png", { method: "PUT", tok: await token(), body: { content: png, sha: "abc" } })).status, 400);
});
test("only images can be deleted", async () => {
  assert.equal((await call(R + "/contents/a.png", { method: "DELETE", tok: await token(), body: { sha: "2" } })).status, 200);
  for (const p of ["index.html", "admin.js", "config.json", ".github/workflows/update-prayer-times.yml", "worker/src/index.js"]) {
    assert.equal((await call(R + "/contents/" + encodeURIComponent(p), { method: "DELETE", tok: await token(), body: { sha: "1" } })).status, 403, p);
  }
});
test("image list only shows images", async () => {
  const r = await call(R + "/git/trees/main?recursive=1", { tok: await token() });
  assert.deepEqual(r.data.tree.map((t) => t.path), ["a.png"]);
});
test("workflow status hides extra GitHub data; refresh is forced onto main", async () => {
  const r = await call(R + "/actions/workflows/update-prayer-times.yml/runs?per_page=1", { tok: await token() });
  assert.equal(r.data.workflow_runs[0].actor, undefined);
  const d = await call(R + "/actions/workflows/update-prayer-times.yml/dispatches", { method: "POST", tok: await token(), body: { ref: "evil" } });
  assert.equal(d.status, 204);
  assert.equal(calls.findLast((c) => c.path.endsWith("/dispatches")).body.ref, "main");
});
test("anything else on GitHub is refused (other repos, secrets, collaborators, workflow edits)", async () => {
  const bad = [
    ["GET", "/github/repos/Amasud5550/other-repo/contents/x"],
    ["PUT", R + "/contents/index.html"],
    ["GET", R + "/actions/secrets"],
    ["PUT", R + "/collaborators/attacker"],
    ["POST", R + "/actions/workflows/other.yml/dispatches"],
    ["GET", R + "/contents/admin.js"],
    ["GET", "/github/user/repos"],
  ];
  const before = calls.length;
  for (const [method, p] of bad) {
    const r = await call(p, { method, tok: await token(), body: method === "GET" ? undefined : { content: png } });
    if (p.includes("other-repo")) {
      // owner/repo in the URL are ignored: this can only ever read the configured repo
      assert.ok(!calls.slice(before).some((c) => c.path.includes("other-repo")));
    } else assert.ok([403, 404].includes(r.status), `${method} ${p} → ${r.status}`);
  }
});
test("oversized uploads are refused before reading them", async () => {
  const r = await call(R + "/contents/announcements/x.png", { method: "PUT", tok: await token(), body: { content: png }, headers: { "Content-Length": String(20 * 1024 * 1024) } });
  assert.equal(r.status, 413);
});
test("missing Worker settings fail closed", async () => {
  const res = await worker.fetch(new Request("https://worker.test/me", { headers: { Origin: ORIGIN, Authorization: `Bearer ${await token()}` } }), { ...env, ADMIN_GROUP_ID: "PASTE-GROUP-OBJECT-ID" });
  assert.equal(res.status, 500);
});
test("CORS preflight only names the GitHub Pages site", async () => {
  const r = await call(R, { method: "OPTIONS", origin: "https://evil.example" });
  assert.equal(r.res.headers.get("Access-Control-Allow-Origin"), ORIGIN);
});
test("server-side settings cleaner matches the admin page's rules", () => {
  const c = normaliseConfig({ overrides: [{ prayer: "__proto__", time: "7:30" }], nightDim: { level: 5 } });
  assert.equal(c.overrides[0].prayer, "isha"); assert.equal(c.overrides[0].time, "07:30"); assert.equal(c.nightDim.level, 0.9);
});
test("protective headers are on every response, errors included", async () => {
  for (const r of [await call("/me"), await call(R, { tok: await token() }), await call(R, { tok: await token(), origin: "https://evil.example" })]) {
    assert.equal(r.res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(r.res.headers.get("X-Frame-Options"), "DENY");
    assert.equal(r.res.headers.get("Cache-Control"), "no-store");
    assert.match(r.res.headers.get("Content-Security-Policy"), /frame-ancestors 'none'/);
  }
});
