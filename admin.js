"use strict";
if (window.top !== window.self) {
  document.documentElement.innerHTML = "<body style='font-family:sans-serif;padding:24px'>For your security, the admin page can't be opened inside another page. <a href='" + location.href.replace(/'/g, "%27") + "' target='_top'>Open it directly</a>.</body>";
  throw new Error("admin.html refused to run inside a frame");
}
    /* ============================================================
       Mosque Aisha · Display admin
       Saves config.json and slide images to the GitHub repo that
       serves the screen. Screens pick up changes within ~2 minutes.
       ============================================================ */

    const TZ = "America/Toronto";
    const CONFIG_PATH = "config.json";
    const PRAYERS_PATH = "prayerTimes.json";
    const WORKFLOW = "update-prayer-times.yml";
    const UPLOAD_DIR = "announcements";
    const LOCATIONS_FALLBACK = [{ id: 1, name: "Mosque Aisha (Stanley Ave)" }, { id: 2, name: "Mosque Aisha (Thorold)" }];
    const PRAYER_IDS = [["fajr", "Fajr"], ["dhuhr", "Dhuhr"], ["jumuah1", "Jumu'ah 1"], ["jumuah2", "Jumu'ah 2"], ["asr", "Asr"], ["maghrib", "Maghrib"], ["isha", "Isha"]];

    const DEFAULT_CONFIG = {
      version: 1,
      locationId: 1,
      slideSeconds: 15,
      salahInProgressMin: 10,
      reloadToken: 0,
      alert: { enabled: false, title: "", text: "", locations: "all", from: "", to: "" },
      ticker: [],
      slides: [],
      overrides: [],
      nightDim: { enabled: false, afterIshaMin: 60, beforeFajrMin: 30, level: 0.65 }
    };

    const S = {
      token: "", owner: "", repo: "", branch: "main",
      saved: null, draft: null, configSha: null,
      prayers: null, images: [], run: null,
      tab: "overview", prayerLoc: null, previewLoc: null,
      busy: false
    };

    const $ = (id) => document.getElementById(id);
    const clone = (o) => JSON.parse(JSON.stringify(o));
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
    const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    const pagesUrl = () => `https://${S.owner.toLowerCase()}.github.io/${S.repo}/`;
    const rawUrl = (path) => /^https?:/i.test(path) ? path : `https://raw.githubusercontent.com/${S.owner}/${S.repo}/${S.branch}/${path.split("/").map(encodeURIComponent).join("/")}`;
    const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
    const locations = () => S.prayers?.locations?.map((l) => ({ id: l.id, name: l.name })) || LOCATIONS_FALLBACK;
    const locShort = (id) => (locations().find((l) => +l.id === +id)?.name || `Location ${id}`).replace(/^Mosque Aisha\s*\(?/i, "").replace(/\)$/, "");
    const fileName = (p) => decodeURIComponent(p.split("/").pop());

    /* ---------- Formatting ---------- */
    function prettyDate(d) {
      if (!d) return "";
      return new Date(d + "T12:00:00").toLocaleDateString("en-CA", { weekday: "short", month: "short", day: "numeric" });
    }

    function ago(iso) {
      if (!iso) return "";
      const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
      if (s < 60) return "just now";
      if (s < 3600) return `${Math.round(s / 60)} min ago`;
      if (s < 86400) return `${Math.round(s / 3600)} h ago`;
      return `${Math.round(s / 86400)} days ago`;
    }

    function to12(hhmm) {
      if (!hhmm) return "—";
      const [h, m] = hhmm.split(":").map(Number);
      return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    }

    // Live / Scheduled / Ended / Off — same rules the screen uses
    function status(item) {
      const d = today();
      if (item.enabled === false) return { cls: "off", text: "Off" };
      if (item.from && d < item.from) return { cls: "sched", text: `Starts ${prettyDate(item.from)}` };
      if (item.to && d > item.to) return { cls: "ended", text: `Ended ${prettyDate(item.to)}` };
      return { cls: "live", text: item.to ? `Live until ${prettyDate(item.to)}` : "Live" };
    }
    const chip = (st) => `<span class="chip ${st.cls}">${esc(st.text)}</span>`;

    /* ---------- Base64 (UTF-8 safe) ---------- */
    function b64encode(str) {
      const bytes = new TextEncoder().encode(str);
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(bin);
    }
    const b64decode = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));
    const blobToB64 = (blob) => new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.onerror = rej;
      r.readAsDataURL(blob);
    });

    /* ---------- Sign in with Microsoft (Entra ID, auth code + PKCE, no library) ----------
       Microsoft proves who you are; the Worker checks you're in Display Admins and makes the
       change on GitHub with its own token, so no GitHub token is ever in this browser. */
    const msMeta = document.querySelector('meta[name="ms-sign-in"]');
    const MS = {
      tenant: msMeta?.dataset.tenant || "",
      client: msMeta?.dataset.client || "",
      worker: (msMeta?.dataset.worker || "").replace(/\/+$/, "")
    };
    const MS_READY = [MS.tenant, MS.client, MS.worker].every((v) => v && !v.includes("PASTE-"));
    const MS_KEY = "mosque-aisha-admin-ms";
    const msScope = () => `api://${MS.client}/Display.Manage openid profile offline_access`;
    const msRedirect = () => location.origin + location.pathname;
    const msAuthority = () => `https://login.microsoftonline.com/${encodeURIComponent(MS.tenant)}/oauth2/v2.0`;
    const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const randomStr = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
    const ssGet = (k) => { try { return JSON.parse(sessionStorage.getItem(k) || "null"); } catch { return null; } };
    const ssSet = (k, v) => { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, JSON.stringify(v)); } catch {} };

    // Microsoft only returns to the registered https address, so a copy opened from a file
    // (file:///…) or anywhere else can't sign in. Say so plainly instead of showing Microsoft's error.
    const MS_HOME = "https://amasud5550.github.io/mosque-aisha-display/admin.html";
    async function msSignIn() {
      if (location.protocol !== "https:" || msRedirect() !== MS_HOME) {
        $("msErr").innerHTML = `Microsoft sign-in only works from the website. <a href="${MS_HOME}">Open the admin page here</a>.`;
        return;
      }
      const verifier = randomStr(48);
      const state = randomStr(16);
      const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
      ssSet(`${MS_KEY}:pkce`, { verifier, state });
      const q = new URLSearchParams({
        client_id: MS.client, response_type: "code", redirect_uri: msRedirect(), response_mode: "query",
        scope: msScope(), state, code_challenge: challenge, code_challenge_method: "S256", prompt: "select_account"
      });
      location.assign(`${msAuthority()}/authorize?${q}`);
    }

    async function msToken(params) {
      const res = await fetch(`${msAuthority()}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: MS.client, scope: msScope(), ...params })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) throw new Error((data.error_description || "Microsoft sign-in failed.").split(/\r?\n/)[0]);
      const session = { access: data.access_token, exp: Date.now() + (data.expires_in || 3600) * 1000, refresh: data.refresh_token || null };
      ssSet(MS_KEY, session);
      return session;
    }

    // Back from Microsoft with ?code=…: swap it for a token, then clean the address bar
    async function msHandleRedirect() {
      const q = new URLSearchParams(location.search);
      if (!q.has("code") && !q.has("error")) return false;
      history.replaceState(null, "", msRedirect());
      if (q.has("error")) throw new Error((q.get("error_description") || q.get("error")).split(/\r?\n/)[0]);
      const pkce = ssGet(`${MS_KEY}:pkce`);
      ssSet(`${MS_KEY}:pkce`, null);
      if (!pkce || pkce.state !== q.get("state")) throw new Error("That sign-in didn't match this page. Please try again.");
      await msToken({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: msRedirect(), code_verifier: pkce.verifier });
      return true;
    }

    async function msAccessToken() {
      let s = ssGet(MS_KEY);
      if (!s) throw Object.assign(new Error("Please sign in again."), { status: 401 });
      if (Date.now() > s.exp - 2 * 60 * 1000) {
        if (!s.refresh) throw Object.assign(new Error("Your sign-in expired. Please sign in again."), { status: 401 });
        s = await msToken({ grant_type: "refresh_token", refresh_token: s.refresh });
      }
      return s.access;
    }

    async function connectMicrosoft() {
      S.mode = "microsoft";
      const res = await fetch(`${MS.worker}/me`, { cache: "no-store", headers: { Authorization: `Bearer ${await msAccessToken()}` } });
      const me = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(me.message || `The admin service answered ${res.status}.`);
      [S.owner, S.repo] = guessRepo().split("/");
      const info = await gh(repoPath());
      Object.assign(S, { user: me.name, owner: info.owner.login, repo: info.name, branch: info.default_branch || "main", tokenWarning: "" });
    }

    /* ---------- GitHub API (directly with a token, or through the Worker after Microsoft sign-in) ---------- */
    async function gh(path, { method = "GET", body, raw = false } = {}) {
      const viaWorker = S.mode === "microsoft";
      const res = await fetch(`${viaWorker ? `${MS.worker}/github` : "https://api.github.com"}${path}`, {
        method,
        cache: "no-store",
        headers: {
          Authorization: `Bearer ${viaWorker ? await msAccessToken() : S.token}`,
          Accept: raw ? "application/vnd.github.raw+json" : "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        let msg = `GitHub error ${res.status}`;
        try { msg = (await res.json()).message || msg; } catch {}
        const err = new Error(msg);
        err.status = res.status;
        throw err;
      }
      if (res.status === 204) return null;
      return raw ? res.text() : res.json();
    }
    const repoPath = (p = "") => `/repos/${S.owner}/${S.repo}${p}`;

    /* ---------- Credentials ---------- */
    const CRED_KEY = "mosque-aisha-admin";
    function readCreds() {
      for (const store of [localStorage, sessionStorage]) {
        try { const v = store.getItem(CRED_KEY); if (v) return JSON.parse(v); } catch {}
      }
      return null;
    }
    function writeCreds(c, remember) {
      try { localStorage.removeItem(CRED_KEY); sessionStorage.removeItem(CRED_KEY); } catch {}
      try { (remember ? localStorage : sessionStorage).setItem(CRED_KEY, JSON.stringify(c)); } catch {}
    }
    function signOut() {
      try { localStorage.removeItem(CRED_KEY); sessionStorage.removeItem(CRED_KEY); sessionStorage.removeItem(MS_KEY); } catch {}
      location.reload();
    }

    function guessRepo() {
      const known = "Amasud5550/mosque-aisha-display";
      const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
      if (m) {
        const seg = location.pathname.split("/").filter(Boolean)[0];
        const guess = `${m[1]}/${seg && !seg.includes(".") ? seg : `${m[1]}.github.io`}`;
        return guess.toLowerCase() === known.toLowerCase() ? known : guess;
      }
      return known;
    }

    async function connect(token, repoFull) {
      const [owner, repo] = repoFull.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").split("/");
      if (!owner || !repo) throw new Error("Repository should look like owner/repo");
      Object.assign(S, { mode: "github", token: token.trim(), owner, repo });
      let info;
      try { info = await gh(repoPath()); }
      catch (e) {
        if (e.status === 401) throw new Error("GitHub didn't accept that token. Check it was copied in full and hasn't expired.");
        if (e.status === 404) throw new Error(`Can't see ${owner}/${repo} with this token. Make sure the token includes this repository.`);
        throw e;
      }
      if (!info.permissions?.push) throw new Error("This token can read the repo but can't save. Set Contents to “Read and write”.");
      S.branch = info.default_branch || "main";
      // Classic tokens (ghp_) and OAuth tokens (gho_) can reach every repo the account owns.
      S.tokenWarning = /^gh[po]_/.test(S.token)
        ? "You're signed in with a classic GitHub token, which can change all of your repositories. For safety, create a fine-grained token for this repo only and sign in with that."
        : "";
      S.owner = info.owner.login;
      S.repo = info.name;
    }

    /* ---------- Loading ---------- */
    /* Everything read from config.json is coerced to the exact shape and type we expect.
       Anyone with write access to the repo can edit that file, so nothing in it is trusted. */
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
    const PRAYER_KEYS = PRAYER_IDS.map(([k]) => k);
    const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const str = (v, max) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").slice(0, max);
    const num = (v, lo, hi, dflt) => { const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
    const optNum = (v, lo, hi) => (v === null || v === undefined || v === "") ? null : num(v, lo, hi, null);
    const dateStr = (v) => (typeof v === "string" && DATE_RE.test(v) ? v : "");
    const timeStr = (v) => (typeof v === "string" && TIME_RE.test(v) ? v.padStart(5, "0") : "");
    const locVal = (v) => (Number.isInteger(+v) && +v > 0 && v !== "" && v !== null && typeof v !== "boolean" ? +v : "all");
    const boolVal = (v, d) => (typeof v === "boolean" ? v : d);
    const idVal = (v, p) => { const s = str(v, 40); return /^[\w-]+$/.test(s) ? s : uid(p); };
    function safeSrc(v) {
      const s = str(v, 300).trim();
      if (/^https:\/\/[^\s"'<>()\\]+$/i.test(s)) return s;                                   // full https link
      if (/^[\w][\w\-. ()]*(\/[\w][\w\-. ()]*)*\.(jpe?g|png|gif|webp)$/i.test(s) && !s.includes("..")) return s; // image in this repo
      return "";
    }
    const list = (v, max) => (Array.isArray(v) ? v.filter(isObj).slice(0, max) : []);

    function normaliseConfig(cfg) {
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

    /* prayerTimes.json is written by the GitHub job from mosqueaisha.ca data: also untrusted */
    function normalisePrayers(data) {
      if (!isObj(data)) return null;
      const prayer = (p) => ({ name: str(p.name, 40), start: str(p.start, 8), time: str(p.time, 8), is_jummah: p.is_jummah === true, jummah_order: Number.isInteger(p.jummah_order) ? p.jummah_order : null });
      let locs = Array.isArray(data.locations) ? data.locations
        : [{ id: data.locationId || 1, name: data.locationName || LOCATIONS_FALLBACK[0].name, prayers: data.prayers || [] }];
      locs = locs.filter(isObj).slice(0, 20)
        .map((l) => ({ id: Number.isInteger(+l.id) && +l.id > 0 ? +l.id : null, name: str(l.name, 80) || "Location", prayers: list(l.prayers, 20).map(prayer) }))
        .filter((l) => l.id !== null);
      return { day: dateStr(data.day), updatedAt: str(data.updatedAt, 30), locations: locs };
    }

    async function loadConfig() {
      try {
        const file = await gh(repoPath(`/contents/${CONFIG_PATH}?ref=${S.branch}`));
        S.configSha = file.sha;
        let parsed = {};
        try { parsed = JSON.parse(b64decode(file.content)); } catch { toast("config.json was damaged, so defaults were loaded. Publishing will repair it.", "bad", 8000); }
        S.saved = normaliseConfig(parsed);
      } catch (e) {
        if (e.status !== 404) throw e;
        S.configSha = null;
        S.saved = normaliseConfig({});
      }
      S.draft = clone(S.saved);
    }

    async function loadPrayers() {
      try {
        const txt = await gh(repoPath(`/contents/${PRAYERS_PATH}?ref=${S.branch}`), { raw: true });
        S.prayers = normalisePrayers(JSON.parse(txt));
      } catch (e) {
        S.prayers = null;
      }
    }

    async function loadImages() {
      try {
        const tree = await gh(repoPath(`/git/trees/${S.branch}?recursive=1`));
        S.images = tree.tree
          .filter((t) => t.type === "blob" && /\.(jpe?g|png|gif|webp)$/i.test(t.path))
          .map((t) => ({ path: t.path, sha: t.sha, size: t.size }))
          .sort((a, b) => (b.path.startsWith(UPLOAD_DIR) - a.path.startsWith(UPLOAD_DIR)) || a.path.localeCompare(b.path));
      } catch { S.images = []; }
    }

    async function loadRun() {
      try {
        const r = await gh(repoPath(`/actions/workflows/${WORKFLOW}/runs?per_page=1`));
        S.run = r.workflow_runs?.[0] || { none: true };
      } catch (e) {
        S.run = { error: e.status === 404 ? "missing" : e.status === 403 ? "noperm" : "error" };
      }
    }

    async function loadAll() {
      await loadConfig();
      await Promise.allSettled([loadPrayers(), loadImages(), loadRun()]);
    }

    /* ---------- Draft helpers ---------- */
    const dirty = () => JSON.stringify(S.draft) !== JSON.stringify(S.saved);

    function setPath(obj, path, value) {
      const keys = path.split(".");
      let o = obj;
      for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
      o[keys.at(-1)] = value;
    }

    function readInput(el) {
      if (el.type === "checkbox") return el.checked;
      if (el.dataset.kind === "loc") return el.value === "all" ? "all" : +el.value;
      if (el.type === "number" || el.type === "range") return el.value === "" ? null : +el.value;
      return el.value;
    }

    function changed({ rerender = false } = {}) {
      if (rerender) render();
      updateSaveBar();
      pushPreview();
    }

    function updateSaveBar() {
      const d = dirty();
      $("savebar").classList.toggle("show", d);
      $("publishTop").disabled = !d || S.busy;
      $("discardTop").disabled = !d || S.busy;
      $("publishBtn").disabled = S.busy;
      $("discardBtn").disabled = S.busy;
      const st = $("saveState");
      st.className = `save-state${S.busy ? " busy" : d ? " dirty" : ""}`;
      st.textContent = S.busy ? "Publishing…" : d ? "Unpublished changes" : "All changes published";
      document.title = `${d ? "• " : ""}Display Admin · Mosque Aisha`;
      const live = S.draft.slides.filter((s) => status(s).cls === "live").length;
      const badge = $("slideBadge");
      badge.textContent = live;
      badge.classList.toggle("hidden", !live);
    }

    async function publish(message = "Admin: update display") {
      if (S.busy) return;
      S.busy = true; updateSaveBar();
      S.draft = normaliseConfig(S.draft);
      const content = JSON.stringify(S.draft, null, 2) + "\n";
      try {
        const res = await gh(repoPath(`/contents/${CONFIG_PATH}`), {
          method: "PUT",
          body: { message, content: b64encode(content), branch: S.branch, ...(S.configSha ? { sha: S.configSha } : {}) }
        });
        S.configSha = res.content.sha;
        S.saved = clone(S.draft);
        toast("Published. Screens update within about 2 minutes.", "ok");
      } catch (e) {
        if (e.status === 409 || e.status === 422) {
          toast("Someone else saved changes just now. Reload the page, then make your edit again.", "bad", 8000);
        } else {
          toast(`Couldn't publish: ${e.message}`, "bad", 7000);
        }
      } finally {
        S.busy = false;
        render();
        updateSaveBar();
      }
    }

    /* ---------- Toast ---------- */
    let toastTimer;
    function toast(msg, kind = "", ms = 3800) {
      const t = $("toast");
      t.textContent = msg;
      t.className = `toast show ${kind}`;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove("show"), ms);
    }

    /* ---------- Shared field templates ---------- */
    function locSelect(path, value, label = "Show at") {
      const opts = [["all", "Both locations"], ...locations().map((l) => [String(l.id), locShort(l.id)])];
      return `<label class="f">${label}
        <select class="in" data-bind="${path}" data-kind="loc">${opts.map(([v, t]) => `<option value="${v}" ${String(value ?? "all") === v ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      </label>`;
    }
    const dateField = (path, value, label) => `<label class="f">${label}<input class="in" type="date" data-bind="${path}" value="${esc(value || "")}" /></label>`;
    const toggle = (path, on, label) => `<label class="switch"><input type="checkbox" data-bind="${path}" ${on ? "checked" : ""} /><span class="track"></span>${label}</label>`;

    /* ---------- Views ---------- */
    const views = {
      overview() {
        const c = S.draft;
        const d = today();
        const liveSlides = c.slides.filter((s) => status(s).cls === "live").length;
        const schedSlides = c.slides.filter((s) => status(s).cls === "sched").length;
        const liveTicker = c.ticker.filter((m) => m.text && status(m).cls === "live").length;
        const liveOverrides = c.overrides.filter((o) => status(o).cls === "live").length;
        const alertOn = c.alert.enabled && (c.alert.title || c.alert.text) && status({ ...c.alert, enabled: true }).cls === "live";

        const pt = S.prayers;
        const fresh = pt?.day === d;
        const ptTile = !pt
          ? `<div class="v">Not set up <small>yet</small></div><div class="hint">No prayerTimes.json in the repo. Run the refresh once.</div>`
          : fresh
            ? `<div class="v">Up to date</div><div class="hint">${S.run?.created_at
                ? `Checked mosqueaisha.ca ${esc(ago(S.run.created_at))}${S.run.conclusion && S.run.conclusion !== "success" ? " (that check failed)" : ""} · times last changed ${esc(ago(pt.updatedAt) || "today")}`
                : `Times last changed ${esc(ago(pt.updatedAt) || "today")}. The job only saves when something changes.`}</div>`
            : `<div class="v" style="color:var(--warn)">Out of date</div><div class="hint">Last copy is from ${esc(prettyDate(pt.day))}. Screens that can't reach mosqueaisha.ca will show old times.</div>`;

        return `
          <h2>Overview</h2>
          <p class="lead">Everything here goes to the screens once you press <b>Publish</b>. Screens check for changes every 2 minutes.</p>

          <div class="tiles">
            <div class="card tile">
              <div class="k">Prayer times</div>
              ${ptTile}
              <div class="actions"><button class="btn sm" data-act="refresh-prayers">Refresh now</button><button class="btn sm ghost" data-act="goto" data-tab="prayers">View times</button></div>
            </div>
            <div class="card tile">
              <div class="k">Slides</div>
              <div class="v">${liveSlides} <small>showing${schedSlides ? ` · ${schedSlides} scheduled` : ""}</small></div>
              <div class="hint">${c.slides.length} in rotation, ${esc(c.slideSeconds || 15)}s each</div>
              <div class="actions"><button class="btn sm" data-act="upload">Upload image</button><button class="btn sm ghost" data-act="goto" data-tab="slides">Manage</button></div>
            </div>
            <div class="card tile">
              <div class="k">Notices</div>
              <div class="v">${alertOn ? `<span style="color:var(--warn)">Urgent notice on</span>` : `${liveTicker} <small>scrolling message${liveTicker === 1 ? "" : "s"}</small>`}</div>
              <div class="hint">${alertOn ? esc(c.alert.title || c.alert.text) : "Urgent notice is off"}</div>
              <div class="actions"><button class="btn sm" data-act="goto" data-tab="notices">${alertOn ? "Edit notice" : "Add a notice"}</button></div>
            </div>
            <div class="card tile">
              <div class="k">Time changes</div>
              <div class="v">${liveOverrides} <small>active today</small></div>
              <div class="hint">Iqamah times changed on the screen only</div>
              <div class="actions"><button class="btn sm" data-act="goto" data-tab="prayers">Change a time</button></div>
            </div>
          </div>

          <div class="section">
            <div class="section-head"><h3>Screens</h3><button class="btn sm" data-act="reload-screens">Reload all screens</button></div>
            <div class="card stack">
              <div>
                <div class="kv" style="margin-bottom:6px"><b>Main screen link</b><span class="chip live">Shows ${esc(locShort(c.locationId))}</span><button class="btn sm ghost" data-act="goto" data-tab="settings">Change</button></div>
                <div class="url"><code>${esc(pagesUrl())}</code><button class="btn sm" data-act="copy" data-text="${esc(pagesUrl())}">Copy</button><a class="btn sm ghost" href="${esc(pagesUrl())}" target="_blank" rel="noopener">Open</a></div>
                <div class="hint" style="margin-top:6px">This is the address the kiosk PC opens. Which mosque it shows is set by <b>Default location</b> in Settings.</div>
              </div>
              <details>
                <summary class="hint" style="cursor:pointer">Links that always show one mosque (for any extra screen)</summary>
                <div class="stack" style="margin-top:12px">
                  ${locations().map((l) => `
                    <div>
                      <div class="hint" style="margin-bottom:6px">${esc(locShort(l.id))}</div>
                      <div class="url"><code>${esc(screenUrl(l.id))}</code><button class="btn sm" data-act="copy" data-text="${esc(screenUrl(l.id))}">Copy</button><a class="btn sm ghost" href="${esc(screenUrl(l.id))}" target="_blank" rel="noopener">Open</a></div>
                    </div>`).join("")}
                </div>
              </details>
            </div>
          </div>`;
      },

      slides() {
        const c = S.draft;
        const cards = c.slides.map((s, i) => {
          const st = status(s);
          return `
            <div class="card slide ${st.cls === "off" ? "is-off" : ""}" data-slide="${i}">
              <div class="handle" title="Drag to reorder" aria-hidden="true"><svg viewBox="0 0 12 18" fill="currentColor"><circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/><circle cx="3" cy="9" r="1.5"/><circle cx="9" cy="9" r="1.5"/><circle cx="3" cy="15" r="1.5"/><circle cx="9" cy="15" r="1.5"/></svg></div>
              <img class="thumb" src="${esc(rawUrl(s.src))}" alt="" loading="lazy" decoding="async" />
              <div style="min-width:0">
                <div class="head">
                  <span class="fname" title="${esc(s.src)}">${esc(fileName(s.src))}</span>
                  ${chip(st)}
                  <span class="grow"></span>
                  ${toggle(`slides.${i}.enabled`, s.enabled !== false, "Show")}
                  <span class="acts">
                    <button class="btn icon sm" title="Move up" aria-label="Move up" data-act="move" data-list="slides" data-i="${i}" data-d="-1" ${i === 0 ? "disabled" : ""}>↑</button>
                    <button class="btn icon sm" title="Move down" aria-label="Move down" data-act="move" data-list="slides" data-i="${i}" data-d="1" ${i === c.slides.length - 1 ? "disabled" : ""}>↓</button>
                    <button class="btn icon sm danger" title="Remove from rotation" aria-label="Remove" data-act="remove" data-list="slides" data-i="${i}">✕</button>
                  </span>
                </div>
                <div class="fields">
                  ${locSelect(`slides.${i}.locations`, s.locations)}
                  ${dateField(`slides.${i}.from`, s.from, "From")}
                  ${dateField(`slides.${i}.to`, s.to, "Until")}
                  <label class="f">Secs<input class="in" type="number" min="3" max="300" placeholder="${esc(c.slideSeconds || 15)}" data-bind="slides.${i}.seconds" value="${esc(s.seconds ?? "")}" /></label>
                </div>
              </div>
            </div>`;
        }).join("");

        const live = c.slides.filter((s) => status(s).cls === "live").length;
        return `
          <div class="page-head">
            <div>
              <h2>Slides</h2>
              <p class="lead">Rotate in the bottom half of the screen, in this order. Use dates so event posters come down by themselves.</p>
            </div>
          </div>

          <div class="drop" id="drop">
            <strong>Drop images here</strong><span>or</span>
            <button class="btn sm primary" data-act="upload">Upload images</button>
            <button class="btn sm" data-act="library">Pick from library</button>
            <span class="hint">· big photos are shrunk automatically</span>
          </div>

          <div class="section">
            <div class="section-head"><h3>${c.slides.length} in rotation · ${live} showing now</h3><span class="hint drag-hint">Drag ⠿ to reorder</span></div>
            <div class="stack" id="slideList">
              ${cards || `<div class="empty">No slides yet. Upload a poster or pick one from the library.</div>`}
            </div>
          </div>`;
      },

      notices() {
        const a = S.draft.alert;
        const t = S.draft.ticker;
        const aSt = a.enabled ? status({ ...a, enabled: true }) : { cls: "off", text: "Off" };
        return `
          <div class="page-head">
            <div>
              <h2>Notices</h2>
              <p class="lead">Messages scroll along the bottom of the screen. An urgent notice takes over the slide area, for closures or a janazah.</p>
            </div>
          </div>

          <div>
            <div class="section">
              <div class="section-head"><h3>Scrolling messages</h3><button class="btn sm" data-act="add-ticker">+ Add message</button></div>
              <div class="stack">
                ${t.length ? t.map((m, i) => `
                  <div class="card item">
                    <div class="line">
                      ${toggle(`ticker.${i}.enabled`, m.enabled !== false, "")}
                      <input class="in" type="text" maxlength="200" data-bind="ticker.${i}.text" value="${esc(m.text)}" placeholder="Halaqa this Friday after Maghrib, everyone welcome" aria-label="Message" />
                      <button class="btn icon sm danger" title="Delete message" aria-label="Delete" data-act="remove" data-list="ticker" data-i="${i}">✕</button>
                    </div>
                    <div class="fields">
                      ${locSelect(`ticker.${i}.locations`, m.locations)}
                      ${dateField(`ticker.${i}.from`, m.from, "From")}
                      ${dateField(`ticker.${i}.to`, m.to, "Until")}
                    </div>
                    <div>${chip(status(m))}</div>
                  </div>`).join("") : `<div class="empty">No messages. The bar is hidden on the screen until you add one.</div>`}
              </div>
            </div>

            <div class="section">
              <div class="section-head"><h3>Urgent notice</h3>${chip(aSt)}</div>
              <div class="card stack">
                ${toggle("alert.enabled", a.enabled, "Show urgent notice")}
                <label class="f">Heading<input class="in" type="text" maxlength="60" data-bind="alert.title" value="${esc(a.title)}" placeholder="Fajr cancelled due to snow" /></label>
                <label class="f">Details<textarea class="in" maxlength="280" data-bind="alert.text" placeholder="Please pray at home. Dhuhr will go ahead as normal.">${esc(a.text)}</textarea></label>
                <div class="grid-3">
                  ${locSelect("alert.locations", a.locations)}
                  ${dateField("alert.from", a.from, "From")}
                  ${dateField("alert.to", a.to, "Until")}
                </div>
              </div>
            </div>
          </div>`;
      },

      prayers() {
        const pt = S.prayers;
        const locs = locations();
        if (!S.prayerLoc || !locs.some((l) => +l.id === +S.prayerLoc)) S.prayerLoc = locs[0]?.id;
        const loc = pt?.locations?.find((l) => +l.id === +S.prayerLoc);
        const d = today();
        const activeOverride = (pid) => S.draft.overrides.find((o) => o.prayer === pid && status(o).cls === "live" && (o.locations === "all" || +o.locations === +S.prayerLoc));

        const idFor = (p) => {
          const n = (p.name || "").toLowerCase();
          if (n.startsWith("jum")) return `jumuah${p.jummah_order || 1}`;
          return ["fajr", "dhuhr", "asr", "maghrib", "isha"].find((k) => n.startsWith(k.slice(0, 3))) || n;
        };

        const rows = (loc?.prayers || []).map((p) => {
          const pid = idFor(p);
          const ov = activeOverride(pid);
          const iq = (p.time || p.start || "").slice(0, 5);
          return `<tr>
            <td>${esc(p.is_jummah ? (p.name || "").replace(/Jummah/i, "Jumu'ah") : p.name)}</td>
            <td class="num">${esc(to12((p.start || "").slice(0, 5)))}</td>
            <td class="num">${ov ? `<span class="was">${esc(to12(iq))}</span><span class="changed">${esc(to12(ov.time))}</span>` : esc(to12(iq))}</td>
          </tr>`;
        }).join("");

        const run = S.run;
        const runLine = !run ? "" :
          run.error === "missing" ? `<span class="chip bad">Workflow not found</span> <span class="hint">Push .github/workflows/${WORKFLOW} to the repo.</span>` :
          run.error === "noperm" ? `<span class="chip sched">Can't see runs</span> <span class="hint">Give your token Actions → Read and write.</span>` :
          run.error ? `<span class="chip bad">Couldn't check</span>` :
          run.none ? `<span class="chip off">Never run</span>` :
          `${run.status !== "completed" ? `<span class="chip sched">Running…</span>` : run.conclusion === "success" ? `<span class="chip live">Last run OK</span>` : `<span class="chip bad">Last run failed</span>`}
           <span class="hint">${esc(ago(run.created_at))}</span> <a class="hint" href="${esc(run.html_url)}" target="_blank" rel="noopener">details</a>`;

        return `
          <div class="page-head">
            <div>
              <h2>Prayer times</h2>
              <p class="lead">Copied from mosqueaisha.ca automatically. To change a time on the screens only, add a time change.</p>
            </div>
            <button class="btn sm" data-act="refresh-prayers">Refresh from mosqueaisha.ca</button>
          </div>

          <div class="split">
            <div class="section">
              <div class="section-head">
                <div class="seg">${locs.map((l) => `<button data-act="prayer-loc" data-id="${esc(l.id)}" class="${+l.id === +S.prayerLoc ? "on" : ""}">${esc(locShort(l.id))}</button>`).join("")}</div>
                ${pt ? (pt.day === d ? `<span class="chip live">Today's times</span>` : `<span class="chip sched">From ${esc(prettyDate(pt.day))}</span>`) : ""}
              </div>
              <div class="card">
                ${loc ? `<table class="pt"><thead><tr><th>Prayer</th><th class="num">Adhan</th><th class="num">Iqamah on screen</th></tr></thead><tbody>${rows}</tbody></table>`
                      : `<div class="empty">No times saved yet. Press “Refresh from mosqueaisha.ca”.</div>`}
                <div class="kv" style="margin-top:10px">${runLine}</div>
              </div>
            </div>

            <div class="section">
              <div class="section-head"><h3>Time changes</h3><button class="btn sm" data-act="add-override">+ Change a time</button></div>
              <div class="stack">
                ${S.draft.overrides.length ? S.draft.overrides.map((o, i) => `
                  <div class="card item">
                    <div class="line"><strong style="flex:1">${esc(PRAYER_IDS.find(([k]) => k === o.prayer)?.[1] || o.prayer)} → ${esc(to12(o.time))}</strong>${chip(status(o))}<button class="btn icon sm danger" title="Delete time change" aria-label="Delete" data-act="remove" data-list="overrides" data-i="${i}">✕</button></div>
                    <div class="fields">
                      <label class="f">Prayer<select class="in" data-bind="overrides.${i}.prayer">${PRAYER_IDS.map(([k, n]) => `<option value="${k}" ${o.prayer === k ? "selected" : ""}>${n}</option>`).join("")}</select></label>
                      <label class="f">Iqamah time<input class="in" type="time" data-bind="overrides.${i}.time" value="${esc(o.time)}" /></label>
                      ${locSelect(`overrides.${i}.locations`, o.locations, "Location")}
                    </div>
                    <div class="fields">
                      ${dateField(`overrides.${i}.from`, o.from, "From")}
                      ${dateField(`overrides.${i}.to`, o.to, "Until")}
                      <label class="f">Note<input class="in" type="text" maxlength="120" data-bind="overrides.${i}.note" value="${esc(o.note || "")}" placeholder="e.g. Ramadan" /></label>
                    </div>
                  </div>`).join("") : `<div class="empty">No changes. The screens show exactly what mosqueaisha.ca has.</div>`}
              </div>
            </div>
          </div>`;
      },

      settings() {
        const c = S.draft;
        const n = c.nightDim;
        return `
          <h2>Settings</h2>
          <p class="lead">How the screens behave.</p>

          <div class="section">
            <div class="section-head"><h3>Screens</h3></div>
            <div class="card stack">
              <div class="grid-2">
                <label class="f">Default location
                  <select class="in" data-bind="locationId" data-kind="loc">${locations().map((l) => `<option value="${esc(l.id)}" ${+c.locationId === +l.id ? "selected" : ""}>${esc(locShort(l.id))}</option>`).join("")}</select>
                </label>
                <div class="hint" style="align-self:end">The mosque shown at <b>${esc(pagesUrl())}</b>, the address the kiosk PC opens.</div>
              </div>
              <div class="grid-2">
                <label class="f">Seconds per slide<input class="in" type="number" min="3" max="300" data-bind="slideSeconds" value="${esc(c.slideSeconds ?? 15)}" /></label>
                <label class="f">“Salah in progress” for (minutes)<input class="in" type="number" min="0" max="30" data-bind="salahInProgressMin" value="${esc(c.salahInProgressMin ?? 10)}" /></label>
              </div>
            </div>
          </div>

          <div class="section">
            <div class="section-head"><h3>Night dimming</h3></div>
            <div class="card stack">
              ${toggle("nightDim.enabled", n.enabled, "Dim the screen overnight")}
              <div class="grid-2">
                <label class="f">Start (minutes after Isha iqamah)<input class="in" type="number" min="0" max="360" data-bind="nightDim.afterIshaMin" value="${esc(n.afterIshaMin ?? 60)}" /></label>
                <label class="f">End (minutes before Fajr adhan)<input class="in" type="number" min="0" max="240" data-bind="nightDim.beforeFajrMin" value="${esc(n.beforeFajrMin ?? 30)}" /></label>
              </div>
              <label class="f">How dark: <span id="dimVal">${esc(Math.round((n.level ?? 0.65) * 100))}%</span>
                <input type="range" min="0.3" max="0.9" step="0.05" data-bind="nightDim.level" value="${esc(n.level ?? 0.65)}" />
              </label>
            </div>
          </div>

          <div class="section">
            <div class="section-head"><h3>Maintenance</h3></div>
            <div class="card stack">
              <div class="kv"><button class="btn" data-act="reload-screens">Reload all screens</button><span class="hint">Use after changing index.html, or if a screen looks stuck. Also publishes any pending changes.</span></div>
              <div class="kv"><button class="btn" data-act="refresh-prayers">Refresh prayer times now</button><span class="hint">Copies the latest times from mosqueaisha.ca. It also runs every 30 minutes by itself.</span></div>
            </div>
          </div>

          <div class="section">
            <div class="section-head"><h3>Account</h3></div>
            <div class="card kv">
              <span>${S.mode === "microsoft" ? `Signed in with Microsoft as <b>${esc(S.user)}</b>. Changes are saved to <b>${esc(S.owner)}/${esc(S.repo)}</b> in your name.` : `Saving to <b>${esc(S.owner)}/${esc(S.repo)}</b> on <b>${esc(S.branch)}</b> with a GitHub token`}</span>
              <span class="spacer" style="flex:1"></span>
              <button class="btn danger" data-act="signout">Sign out on this device</button>
            </div>
          </div>`;
      },

      preview() { return ""; }
    };

    const screenUrl = (id) => `${pagesUrl()}?location=${id}`;

    function render() {
      document.body.classList.toggle("tab-preview", S.tab === "preview");
      document.querySelectorAll("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.tab === S.tab));
      const y = window.scrollY;
      $("view").innerHTML = `<div class="wrap">${views[S.tab]()}</div>`;
      window.scrollTo(0, y);
      bindDrop();
      if (S.tab === "preview") fitPreview();
    }

    /* ---------- Events ---------- */
    $("nav").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-tab]");
      if (!b) return;
      S.tab = b.dataset.tab;
      render();
      window.scrollTo(0, 0);
    });

    $("view").addEventListener("input", (e) => {
      const el = e.target.closest("[data-bind]");
      if (!el) return;
      setPath(S.draft, el.dataset.bind, readInput(el));
      if (el.dataset.bind === "nightDim.level") $("dimVal").textContent = `${Math.round(el.value * 100)}%`;
      changed();
    });

    $("view").addEventListener("change", (e) => {
      const el = e.target.closest("[data-bind]");
      if (!el) return;
      setPath(S.draft, el.dataset.bind, readInput(el));
      // Re-render where it changes a status chip or heading; leave text fields alone so focus isn't lost
      const structural = el.type === "checkbox" || el.tagName === "SELECT" || el.type === "date" || el.type === "time";
      changed({ rerender: structural });
      if (el.dataset.bind === "locationId") {
        S.previewLoc = +S.draft.locationId;
        $("previewLoc").value = S.previewLoc;
        loadPreview();
      }
    });

    $("view").addEventListener("click", async (e) => {
      const b = e.target.closest("[data-act]");
      if (!b || b.disabled) return;
      const act = b.dataset.act;
      const d = S.draft;

      if (act === "goto") { S.tab = b.dataset.tab; render(); window.scrollTo(0, 0); }
      else if (act === "upload") $("fileIn").click();
      else if (act === "library") openLibrary();
      else if (act === "move") {
        const list = d[b.dataset.list], i = +b.dataset.i, j = i + +b.dataset.d;
        [list[i], list[j]] = [list[j], list[i]];
        changed({ rerender: true });
      }
      else if (act === "remove") {
        d[b.dataset.list].splice(+b.dataset.i, 1);
        changed({ rerender: true });
      }
      else if (act === "add-ticker") {
        d.ticker.push({ id: uid("t"), text: "", enabled: true, locations: "all", from: "", to: "" });
        changed({ rerender: true });
        const inputs = document.querySelectorAll('[data-bind$=".text"]');
        inputs[inputs.length - 1]?.focus();
      }
      else if (act === "add-override") {
        d.overrides.push({ id: uid("o"), prayer: "isha", time: "", locations: S.prayerLoc || "all", from: today(), to: "", note: "" });
        changed({ rerender: true });
      }
      else if (act === "prayer-loc") { S.prayerLoc = +b.dataset.id; render(); }
      else if (act === "refresh-prayers") refreshPrayers(b);
      else if (act === "reload-screens") {
        d.reloadToken = (+S.saved.reloadToken || 0) + 1;
        await publish("Admin: reload screens");
      }
      else if (act === "copy") {
        try { await navigator.clipboard.writeText(b.dataset.text); toast("Link copied"); } catch { toast("Couldn't copy. Select the link and copy it manually.", "bad"); }
      }
      else if (act === "signout") {
        if (!dirty() || confirm("You have unpublished changes. Sign out anyway?")) signOut();
      }
    });

    const discard = () => {
      if (!dirty()) return;
      S.draft = clone(S.saved);
      changed({ rerender: true });
      toast("Changes discarded");
    };
    $("publishTop").addEventListener("click", () => publish());
    $("publishBtn").addEventListener("click", () => publish());
    $("discardTop").addEventListener("click", discard);
    $("discardBtn").addEventListener("click", discard);

    // ⌘S / Ctrl+S publishes
    const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    if (!IS_MAC) {
      $("kbdHint").textContent = "Ctrl+S";
      document.querySelectorAll(".kbd-mod").forEach((k) => (k.textContent = "Ctrl"));
      $("publishTop").title = "Publish (Ctrl+S)";
    }
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if ($("app").classList.contains("hidden")) return;
        e.preventDefault();
        // commit a value that's still being typed
        if (document.activeElement?.dataset?.bind) document.activeElement.dispatchEvent(new Event("change", { bubbles: true }));
        if (dirty()) publish(); else toast("Nothing to publish");
      }
    });

    /* ---------- Show / hide the preview column ---------- */
    const PREVIEW_KEY = "mosque-aisha-admin:preview";
    function setPreviewVisible(on) {
      document.body.classList.toggle("no-preview", !on);
      $("previewToggle").textContent = on ? "Hide preview" : "Show preview";
      try { localStorage.setItem(PREVIEW_KEY, on ? "1" : "0"); } catch {}
      requestAnimationFrame(fitPreview);
    }
    $("previewToggle").addEventListener("click", () => setPreviewVisible(document.body.classList.contains("no-preview")));
    try { if (localStorage.getItem(PREVIEW_KEY) === "0") setPreviewVisible(false); } catch {}

    /* ---------- Drag slides to reorder ---------- */
    let dragFrom = null;
    $("view").addEventListener("pointerdown", (e) => {
      const handle = e.target.closest(".handle");
      const card = handle?.closest("[data-slide]");
      if (card) card.draggable = true;
    });
    $("view").addEventListener("dragstart", (e) => {
      const card = e.target.closest?.("[data-slide]");
      if (!card || !card.draggable) return;
      dragFrom = +card.dataset.slide;
      card.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(dragFrom));
    });
    $("view").addEventListener("dragover", (e) => {
      if (dragFrom === null) return;
      const card = e.target.closest("[data-slide]");
      if (!card) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      document.querySelectorAll(".drop-before, .drop-after").forEach((c) => c.classList.remove("drop-before", "drop-after"));
      card.classList.add(after ? "drop-after" : "drop-before");
    });
    $("view").addEventListener("drop", (e) => {
      if (dragFrom === null) return;
      const card = e.target.closest("[data-slide]");
      if (!card) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      let to = +card.dataset.slide + (e.clientY > r.top + r.height / 2 ? 1 : 0);
      const list = S.draft.slides;
      const [moved] = list.splice(dragFrom, 1);
      if (to > dragFrom) to--;
      list.splice(to, 0, moved);
      dragFrom = null;
      changed({ rerender: true });
    });
    $("view").addEventListener("dragend", () => {
      dragFrom = null;
      document.querySelectorAll("[data-slide]").forEach((c) => { c.draggable = false; c.classList.remove("dragging", "drop-before", "drop-after"); });
    });

    window.addEventListener("beforeunload", (e) => {
      if (S.draft && dirty()) { e.preventDefault(); e.returnValue = ""; }
    });

    /* ---------- Prayer refresh (runs the GitHub Action) ---------- */
    async function refreshPrayers(btn) {
      if (btn) { btn.disabled = true; btn.textContent = "Starting…"; }
      try {
        await gh(repoPath(`/actions/workflows/${WORKFLOW}/dispatches`), { method: "POST", body: { ref: S.branch } });
        toast("Refreshing from mosqueaisha.ca. This takes about a minute.");
      } catch (e) {
        const msg = e.status === 404 ? `The refresh workflow isn't in the repo yet (.github/workflows/${WORKFLOW}).`
                  : e.status === 403 ? (S.mode === "microsoft" ? "The admin service's GitHub token needs Actions → Read and write." : "Your token needs Actions → Read and write to do this.")
                  : e.message;
        toast(msg, "bad", 7000);
        render();
        return;
      }
      const started = Date.now();
      await new Promise((r) => setTimeout(r, 4000));
      while (Date.now() - started < 150000) {
        await loadRun();
        if (S.tab === "prayers") render();
        const r = S.run;
        if (r?.created_at && new Date(r.created_at).getTime() >= started - 15000 && r.status === "completed") break;
        await new Promise((r) => setTimeout(r, 5000));
      }
      await loadPrayers();
      render();
      const r = S.run;
      if (r?.conclusion === "success") toast("Prayer times refreshed.", "ok");
      else if (r?.conclusion) toast("The refresh failed. Open “details” on the Prayer times page to see why.", "bad", 7000);
    }

    /* ---------- Uploads ---------- */
    $("fileIn").addEventListener("change", (e) => { handleFiles([...e.target.files]); e.target.value = ""; });

    function bindDrop() {
      const drop = $("drop");
      if (!drop) return;
      ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
      ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
      drop.addEventListener("drop", (e) => handleFiles([...e.dataTransfer.files]));
    }

    async function prepareImage(file) {
      const MAX = 1920;
      const kind = await sniffImage(file);
      if (kind === "gif") return { blob: file, ext: "gif" };
      let bmp;
      try { bmp = await createImageBitmap(file); } catch { throw new Error("the image couldn't be read"); }
      const big = Math.max(bmp.width, bmp.height) > MAX;
      if (!big && file.size < 1.5e6 && /jpe?g|png|webp/.test(file.type)) {
        bmp.close?.();
        return { blob: file, ext: kind };
      }
      const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * k);
      canvas.height = Math.round(bmp.height * k);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#0d1629";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close?.();
      const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.86));
      return { blob, ext: "jpg" };
    }

    function slugify(name) {
      return name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "slide";
    }

    // SVG and other formats can carry scripts, so only these four are accepted
    async function sniffImage(file) {
      const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
      const at = (i, ...xs) => xs.every((x, k) => b[i + k] === x);
      if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
      if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
      if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
      if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
      return null;
    }

    async function handleFiles(files) {
      const accepted = [];
      for (const f of files) {
        if (await sniffImage(f)) accepted.push(f);
        else toast(`${f.name} isn't a JPG, PNG, WebP or GIF image, so it was skipped.`, "bad", 6000);
      }
      files = accepted;
      if (!files.length) return;
      let ok = 0;
      for (const [n, file] of files.entries()) {
        toast(`Uploading ${n + 1} of ${files.length}…`, "", 60000);
        try {
          const { blob, ext } = await prepareImage(file);
          if (blob.size > 20e6) throw new Error("image is over 20 MB");
          const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
          const path = `${UPLOAD_DIR}/${stamp}-${slugify(file.name)}.${ext}`;
          const res = await gh(repoPath(`/contents/${encPath(path)}`), {
            method: "PUT",
            body: { message: `Admin: upload ${path}`, content: await blobToB64(blob), branch: S.branch }
          });
          S.images.unshift({ path, sha: res.content.sha, size: blob.size });
          S.draft.slides.push({ id: uid("s"), src: path, enabled: true, locations: "all", from: "", to: "", seconds: null });
          ok++;
        } catch (e) {
          toast(`Couldn't upload ${file.name}: ${e.message}`, "bad", 7000);
          await new Promise((r) => setTimeout(r, 2500));
        }
      }
      if (ok) {
        if (S.tab !== "slides") S.tab = "slides";
        changed({ rerender: true });
        toast(`${ok} image${ok > 1 ? "s" : ""} added. Press Publish to show ${ok > 1 ? "them" : "it"} on the screens.`, "ok", 6000);
      }
    }

    /* ---------- Library ---------- */
    function openLibrary() {
      renderLibrary();
      $("libDlg").showModal();
    }

    function renderLibrary() {
      const inUse = new Set(S.draft.slides.map((s) => s.src));
      $("libGrid").innerHTML = S.images.length ? S.images.map((img) => `
        <div class="card">
          <img class="thumb" src="${esc(rawUrl(img.path))}" alt="" loading="lazy" decoding="async" />
          <div class="fn">${esc(img.path)} · ${Math.round(img.size / 1024)} KB</div>
          <div class="row">
            <button class="btn sm ${inUse.has(img.path) ? "" : "primary"}" data-lib="add" data-path="${esc(img.path)}" ${inUse.has(img.path) ? "disabled" : ""}>${inUse.has(img.path) ? "In slides" : "Add"}</button>
            <button class="btn sm danger" data-lib="delete" data-path="${esc(img.path)}" title="Delete from the repository">Delete</button>
          </div>
        </div>`).join("") : `<div class="empty" style="grid-column:1/-1">No images in the repository yet.</div>`;
    }

    $("libDlg").addEventListener("click", async (e) => {
      if (e.target === $("libDlg") || e.target.closest("[data-close]")) { $("libDlg").close(); return; }
      const b = e.target.closest("[data-lib]");
      if (!b) return;
      const path = b.dataset.path;
      if (b.dataset.lib === "add") {
        S.draft.slides.push({ id: uid("s"), src: path, enabled: true, locations: "all", from: "", to: "", seconds: null });
        renderLibrary();
        changed({ rerender: S.tab === "slides" });
        toast("Added. Press Publish to show it on the screens.");
      } else {
        const img = S.images.find((i) => i.path === path);
        const used = S.saved.slides.some((s) => s.src === path);
        if (!confirm(`Delete “${path}” from the repository?${used ? "\n\nIt's currently on the screens. It will also be removed from the slides." : ""}`)) return;
        b.disabled = true;
        try {
          await gh(repoPath(`/contents/${encPath(path)}`), { method: "DELETE", body: { message: `Admin: delete ${path}`, sha: img.sha, branch: S.branch } });
          S.images = S.images.filter((i) => i.path !== path);
          const before = S.draft.slides.length;
          S.draft.slides = S.draft.slides.filter((s) => s.src !== path);
          renderLibrary();
          changed({ rerender: S.tab === "slides" });
          toast(before !== S.draft.slides.length ? "Image deleted. Publish to update the screens." : "Image deleted.", "ok");
        } catch (err) {
          b.disabled = false;
          toast(`Couldn't delete: ${err.message}`, "bad", 7000);
        }
      }
    });

    /* ---------- Preview ---------- */
    let previewReady = false, previewTimer;

    function previewSrc() {
      const loc = S.previewLoc || S.draft.locationId || 1;
      const sameSite = location.protocol.startsWith("http") && location.href.startsWith(pagesUrl().replace(/\/$/, ""));
      const base = sameSite ? new URL("index.html", location.href).href : pagesUrl();
      return `${base}?preview=1&location=${loc}`;
    }

    function loadPreview() {
      previewReady = false;
      $("previewFrame").src = previewSrc();
      $("previewOpen").href = screenUrl(S.previewLoc || S.draft.locationId || 1);
    }

    function pushPreview() {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => {
        if (!previewReady) return;
        $("previewFrame").contentWindow?.postMessage({ type: "mad-config", config: clone(S.draft) }, "*");
      }, 250);
    }

    window.addEventListener("message", (e) => {
      if (e.data?.type === "mad-preview-ready" && e.source === $("previewFrame").contentWindow) {
        previewReady = true;
        pushPreview();
      }
    });

    function fitPreview() {
      const frame = $("frame");
      const w = Math.min(frame.clientWidth, frame.clientHeight * 1080 / 1920 || frame.clientWidth);
      if (!w) return;
      const k = w / 1080;
      $("frameBox").style.width = `${w}px`;
      $("frameBox").style.height = `${w * 1920 / 1080}px`;
      $("previewFrame").style.transform = `scale(${k})`;
    }
    new ResizeObserver(fitPreview).observe($("frame"));

    $("previewLoc").addEventListener("change", (e) => { S.previewLoc = +e.target.value; loadPreview(); });

    /* ---------- Boot ---------- */
    async function start() {
      $("connect").classList.add("hidden");
      $("app").classList.remove("hidden");
      $("repoPill").textContent = S.mode === "microsoft" ? `Signed in as ${S.user}` : `${S.owner}/${S.repo}`;
      $("view").innerHTML = `<div class="empty">Loading…</div>`;
      try {
        await loadAll();
      } catch (e) {
        $("view").innerHTML = `<div class="empty" style="color:var(--bad)">Couldn't load settings: ${esc(e.message)}</div>`;
        return;
      }
      $("previewLoc").innerHTML = locations().map((l) => `<option value="${esc(l.id)}">${esc(locShort(l.id))}</option>`).join("");
      S.previewLoc = +S.draft.locationId || locations()[0].id;
      $("previewLoc").value = S.previewLoc;
      render();
      updateSaveBar();
      loadPreview();
      if (S.tokenWarning) toast(S.tokenWarning, "bad", 12000);
      startStatusRefresh();
      fitPreview();
    }

    /* ---------- Keep the prayer-times status current while the page stays open ----------
       Re-checks the job's last run and the saved times every 5 minutes and whenever the tab
       comes back into view. Only the status panels re-draw, and never while you're typing. */
    let statusTimer = null, lastStatusCheck = 0;
    async function refreshStatus() {
      if (S.busy || !S.draft) return;
      lastStatusCheck = Date.now();
      await Promise.allSettled([loadRun(), loadPrayers()]);
      const typing = document.activeElement && $("view").contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
      if (!typing && (S.tab === "overview" || S.tab === "prayers")) render();
    }
    function startStatusRefresh() {
      if (statusTimer) return;
      statusTimer = setInterval(refreshStatus, 5 * 60 * 1000);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastStatusCheck > 60 * 1000) refreshStatus();
      });
      lastStatusCheck = Date.now();
    }

    $("connectForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("connectBtn");
      btn.disabled = true; btn.textContent = "Checking…"; $("connectErr").textContent = "";
      try {
        await connect($("tokenIn").value, $("repoIn").value);
        writeCreds({ token: S.token, repo: `${S.owner}/${S.repo}` }, $("rememberIn").checked);
        await start();
      } catch (err) {
        $("connectErr").textContent = err.message;
      } finally {
        btn.disabled = false; btn.textContent = "Connect";
      }
    });

    if (MS_READY) $("msBtn").addEventListener("click", () => { $("msErr").textContent = ""; msSignIn(); });

    (async function boot() {
      const guess = guessRepo();
      $("repoIn").value = guess;
      $("repoHint").textContent = guess.split("/")[1];
      if (MS_READY) $("msBlock").classList.remove("hidden");
      else $("tokenSection").open = true;

      // Microsoft sign-in (returning from Microsoft, or already signed in this session)
      if (MS_READY) {
        try {
          if ((await msHandleRedirect()) || ssGet(MS_KEY)) {
            await connectMicrosoft();
            await start();
            return;
          }
        } catch (e) {
          ssSet(MS_KEY, null);
          S.mode = "github";
          $("msErr").textContent = e.message;
        }
      }

      const creds = readCreds();
      if (creds?.token) {
        try {
          await connect(creds.token, creds.repo || guess);
          await start();
          return;
        } catch (e) {
          $("connectErr").textContent = `Please sign in again: ${e.message}`;
          $("repoIn").value = creds.repo || guess;
        }
      }
      $("connect").classList.remove("hidden");
    })();
  
