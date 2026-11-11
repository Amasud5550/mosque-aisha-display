"use strict";
    /* =====================================================
       Day-to-day changes are made in admin.html, which saves
       config.json in this repo. These are the fixed settings.
       ===================================================== */
    const SETUP = {
      timezone: "America/Toronto",
      apiBase: "https://api.mosqueaisha.ca/mosque-api",

      // GitHub repo that holds config.json, prayerTimes.json and the slides.
      // Detected automatically on *.github.io; these are the fallbacks.
      owner: "Amasud5550",
      repo: "mosque-aisha-display",
      branch: "main",

      configPollMs: 2 * 60 * 1000,    // pick up admin changes every 2 min
      prayerPollMs: 10 * 60 * 1000    // re-check prayer times every 10 min
    };

    const DEFAULT_CONFIG = {
      locationId: 1,
      slideSeconds: 15,
      salahInProgressMin: 10,
      reloadToken: 0,
      alert: { enabled: false, title: "", text: "", locations: "all" },
      ticker: [],
      slides: [],
      overrides: [],
      nightDim: { enabled: false, afterIshaMin: 60, beforeFajrMin: 30, level: 0.65 }
    };

    (function detectRepo() {
      const m = location.hostname.match(/^([^.]+)\.github\.io$/i);
      if (m) {
        SETUP.owner = m[1];
        const seg = location.pathname.split("/").filter(Boolean)[0];
        if (seg && !seg.includes(".")) SETUP.repo = seg;
      }
    })();

    const params = new URLSearchParams(location.search);
    const PREVIEW = params.get("preview") === "1";
    const URL_LOCATION = params.get("location") ? +params.get("location") : null;
    if (PREVIEW) document.body.classList.add("preview");

    const RAW_BASE = () => `https://raw.githubusercontent.com/${SETUP.owner}/${SETUP.repo}/${SETUP.branch}/`;

    const ARABIC = {
      fajr: "الفجر", dhuhr: "الظهر", jumuah: "الجمعة",
      asr: "العصر", maghrib: "المغرب", isha: "العشاء"
    };

    const CACHE_PRAYERS = "mosque-aisha-display:prayers";
    const CACHE_CONFIG = "mosque-aisha-display:config";
    const $ = (id) => document.getElementById(id);
    const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

    const state = {
      config: structuredClone(DEFAULT_CONFIG),
      configStamp: 0,
      firstReloadToken: null,
      raw: null,          // last good prayer payload (any supported format)
      data: null,         // normalised for the current location
      source: "",
      loadedAt: null,
      today: null,
      renderedFor: "",
      slideSig: "",
      tickerSig: "",
      alertSig: ""
    };

    const locationId = () => URL_LOCATION || +state.config.locationId || 1;

    /* ---------- Time helpers (always Toronto wall-clock) ---------- */
    const partsFmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: SETUP.timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hourCycle: "h23", weekday: "short"
    });

    function nowLocal() {
      const p = {};
      for (const part of partsFmt.formatToParts(new Date())) p[part.type] = part.value;
      const h = +p.hour % 24, m = +p.minute, s = +p.second;
      return { day: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, h, m, s, secs: h * 3600 + m * 60 + s };
    }

    // "13:40:00", "13:40", "1:40 PM", "1:40pm" -> seconds since midnight
    function toSecs(value) {
      if (!value) return null;
      const t = String(value).replace(/[  .]/g, " ").trim().toUpperCase();
      const m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/);
      if (!m) return null;
      let h = +m[1];
      const min = +m[2];
      if (m[3] === "PM" && h !== 12) h += 12;
      if (m[3] === "AM" && h === 12) h = 0;
      return h * 3600 + min * 60;
    }

    function fmt12(secs) {
      if (secs == null) return { hm: "—", ap: "" };
      const h24 = Math.floor(secs / 3600) % 24;
      const m = Math.floor((secs % 3600) / 60);
      return { hm: `${h24 % 12 || 12}:${String(m).padStart(2, "0")}`, ap: h24 < 12 ? "AM" : "PM" };
    }

    const timeHTML = (secs) => { const t = fmt12(secs); return t.ap ? `${t.hm}<small>${t.ap}</small>` : t.hm; };
    const timeText = (secs) => { const t = fmt12(secs); return `${t.hm} ${t.ap}`.trim(); };

    function fmtCountdown(sec) {
      sec = Math.max(0, Math.floor(sec));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      const pad = (n) => String(n).padStart(2, "0");
      return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    // Shared rules for anything the admin can schedule
    const inDateRange = (item, day) => (!item.from || day >= item.from) && (!item.to || day <= item.to);
    const forHere = (item) => !item.locations || item.locations === "all" || +item.locations === locationId();
    const isLive = (item, day) => item && item.enabled !== false && inDateRange(item, day) && forHere(item);

    /* ---------- Hijri date ---------- */
    const HIJRI_MONTHS = {
      "muharram": "Muharram", "safar": "Safar",
      "rabi al-awwal": "Rabi al-Awwal", "rabi al-thani": "Rabi al-Thani", "rabi al-akhir": "Rabi al-Thani",
      "jumada al-ula": "Jumada al-Ula", "jumada al-akhirah": "Jumada al-Akhirah", "jumada al-thaniyah": "Jumada al-Akhirah",
      "rajab": "Rajab", "shaban": "Sha'ban", "ramadan": "Ramadan", "shawwal": "Shawwal",
      "dhu al-qadah": "Dhul Qa'dah", "dhu al-hijjah": "Dhul Hijjah"
    };

    function cleanHijri(raw) {
      if (!raw) return null;
      const plain = raw.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[ʿʾ'`]/g, "");
      const m = plain.match(/^(\d{1,2})\s+(.+?),?\s+(\d{4})$/);
      if (!m) return plain;
      return `${m[1]} ${HIJRI_MONTHS[m[2].toLowerCase().trim()] || m[2]} ${m[3]} AH`;
    }

    function hijriFallback() {
      try {
        return new Intl.DateTimeFormat("en-u-ca-islamic-umalqura", { day: "numeric", month: "long", year: "numeric", timeZone: SETUP.timezone }).format(new Date());
      } catch { return ""; }
    }

    /* ---------- Prayer data normalisation ---------- */
    function keyFor(name) {
      const n = name.toLowerCase();
      if (n.startsWith("jum")) return "jumuah";
      if (n.startsWith("fajr")) return "fajr";
      if (n.startsWith("dhu") || n.startsWith("zuh")) return "dhuhr";
      if (n.startsWith("asr")) return "asr";
      if (n.startsWith("magh")) return "maghrib";
      if (n.startsWith("isha")) return "isha";
      return n;
    }

    // Accepts: multi-location prayerTimes.json (from the GitHub Action),
    // a single API prayer list, or the old flat { fajr, dhuhr, ... } file.
    function normalise(raw, locId) {
      let day = raw.day || (typeof raw.date === "string" ? raw.date : null);
      let hijri = raw.date?.hijri || raw.hijri || null;
      let locationName = raw.locationName || null;
      let apiList = Array.isArray(raw) ? raw : Array.isArray(raw.prayers) ? raw.prayers : null;

      if (Array.isArray(raw.locations)) {
        const loc = raw.locations.find((l) => +l.id === +locId) || raw.locations[0];
        apiList = loc?.prayers || null;
        locationName = loc?.name || locationName;
      }

      let list;
      if (apiList) {
        list = apiList.filter(isObj).slice(0, 20).map((p) => {
          p = { ...p, name: str(p.name, 40), start: str(p.start, 8), time: str(p.time, 8), jummah_order: Number.isInteger(p.jummah_order) ? p.jummah_order : null };
          const key = keyFor(p.name || "");
          const order = p.jummah_order || null;
          return {
            key,
            id: key === "jumuah" ? `jumuah${Math.min(9, Math.max(1, order || 1))}` : key,
            label: key === "jumuah" ? `Jumu'ah${order ? " " + order : ""}` : p.name,
            arabic: Object.prototype.hasOwnProperty.call(ARABIC, key) ? ARABIC[key] : "",
            start: toSecs(p.start),
            iqamah: toSecs(p.time) ?? toSecs(p.start),
            jumuah: !!p.is_jummah || key === "jumuah"
          };
        });
      } else {
        const flat = [["fajr", "Fajr"], ["dhuhr", "Dhuhr"], ["jumah1", "Jumu'ah 1"], ["jumah2", "Jumu'ah 2"], ["asr", "Asr"], ["maghrib", "Maghrib"], ["isha", "Isha"]];
        list = flat.filter(([k]) => raw[k]).map(([k, label]) => {
          const jum = k.startsWith("jumah");
          const key = jum ? "jumuah" : k;
          return { key, id: jum ? k.replace("jumah", "jumuah") : k, label, arabic: ARABIC[key] || "", start: null, iqamah: toSecs(raw[k]), jumuah: jum };
        });
      }

      list = list.filter((p) => p.iqamah != null || p.start != null);
      if (!list.length) throw new Error("No prayer times in response");
      const jum = list.filter((p) => p.jumuah);
      if (jum.length === 1) jum[0].label = "Jumu'ah";
      return { day, hijri, locationName, prayers: list };
    }

    /* ---------- Loading ---------- */
    async function getJSON(url, opts = {}) {
      const res = await fetch(url, { cache: "no-store", ...opts });
      if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
      return res.json();
    }

    const cacheGet = (k) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
    const cacheSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

    const net = { etag: null, apiPausedUntil: 0, livePausedUntil: 0 };

    // GitHub API: no CDN delay. Uses ETags, so "unchanged" answers (304) don't count against
    // GitHub's 60-requests-an-hour limit, which several screens on one network share.
    async function configFromApi() {
      if (Date.now() < net.apiPausedUntil) throw new Error("GitHub API paused after hitting its rate limit");
      const headers = { Accept: "application/vnd.github.raw+json" };
      if (net.etag) headers["If-None-Match"] = net.etag;
      const res = await fetch(`https://api.github.com/repos/${SETUP.owner}/${SETUP.repo}/contents/config.json?ref=${SETUP.branch}`, { cache: "no-store", headers });
      if (res.status === 304) return null;
      if (res.status === 403 || res.status === 429) { net.apiPausedUntil = Date.now() + 30 * 60 * 1000; throw new Error(`GitHub API HTTP ${res.status}`); }
      if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
      net.etag = res.headers.get("ETag");
      return res.json();
    }

    async function loadConfig() {
      if (PREVIEW) return; // the admin page pushes config into the preview
      const sources = [
        configFromApi,
        () => getJSON(`${RAW_BASE()}config.json?t=${Date.now()}`),
        () => getJSON(`./config.json?t=${Date.now()}`)
      ];
      for (const src of sources) {
        try {
          const cfg = await src();
          if (cfg === null) return; // unchanged since last check
          cacheSet(CACHE_CONFIG, cfg);
          applyConfig(cfg, true);
          return;
        } catch (e) { console.warn("[display] config source failed:", e.message); }
      }
    }

    /* Everything in config.json is coerced to the exact shape we expect (it is editable by anyone
       with access to the repo, so nothing in it is trusted, and a typo must never stop the clock). */
    const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
    const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
    const PRAYER_KEYS = ["fajr", "dhuhr", "jumuah1", "jumuah2", "asr", "maghrib", "isha"];
    const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const str = (v, max) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "").slice(0, max);
    const num = (v, lo, hi, dflt) => { const n = typeof v === "string" && v.trim() === "" ? NaN : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
    const optNum = (v, lo, hi) => (v === null || v === undefined || v === "") ? null : num(v, lo, hi, null);
    const dateStr = (v) => (typeof v === "string" && DATE_RE.test(v) ? v : "");
    const timeStr = (v) => (typeof v === "string" && TIME_RE.test(v) ? v : "");
    const locVal = (v) => (Number.isInteger(+v) && +v > 0 && v !== "" && v !== null && typeof v !== "boolean" ? +v : "all");
    const boolVal = (v, d) => (typeof v === "boolean" ? v : d);
    const list = (v, max) => (Array.isArray(v) ? v.filter(isObj).slice(0, max) : []);
    function safeSrc(v) {
      const s = str(v, 300).trim();
      if (/^https:\/\/[^\s"'<>()\\]+$/i.test(s)) return s;
      if (/^[\w][\w\-. ()]*(\/[\w][\w\-. ()]*)*\.(jpe?g|png|gif|webp)$/i.test(s) && !s.includes("..")) return s;
      return "";
    }

    function sanitizeConfig(cfg) {
      const c = isObj(cfg) ? cfg : {};
      const a = isObj(c.alert) ? c.alert : {};
      const n = isObj(c.nightDim) ? c.nightDim : {};
      return {
        locationId: Math.round(num(c.locationId, 1, 99, 1)),
        slideSeconds: num(c.slideSeconds, 3, 300, 15),
        salahInProgressMin: num(c.salahInProgressMin, 0, 30, 10),
        reloadToken: Math.round(num(c.reloadToken, 0, 1e9, 0)),
        alert: { enabled: boolVal(a.enabled, false), title: str(a.title, 80), text: str(a.text, 400), locations: locVal(a.locations), from: dateStr(a.from), to: dateStr(a.to) },
        ticker: list(c.ticker, 30).map((m) => ({ text: str(m.text, 240), enabled: boolVal(m.enabled, true), locations: locVal(m.locations), from: dateStr(m.from), to: dateStr(m.to) })),
        slides: list(c.slides, 60).map((x) => ({ src: safeSrc(x.src), enabled: boolVal(x.enabled, true), locations: locVal(x.locations), from: dateStr(x.from), to: dateStr(x.to), seconds: optNum(x.seconds, 3, 300) })).filter((x) => x.src),
        overrides: list(c.overrides, 60).map((o) => ({ prayer: PRAYER_KEYS.includes(o.prayer) ? o.prayer : "", time: timeStr(o.time), locations: locVal(o.locations), from: dateStr(o.from), to: dateStr(o.to), enabled: true })).filter((o) => o.prayer && o.time),
        nightDim: { enabled: boolVal(n.enabled, false), afterIshaMin: num(n.afterIshaMin, 0, 360, 60), beforeFajrMin: num(n.beforeFajrMin, 0, 240, 30), level: num(n.level, 0.3, 0.9, 0.65) }
      };
    }

    // Reload only when the site is actually reachable, so an internet outage at midnight
    // can't leave the TV stuck on a browser error page.
    let reloading = false;
    async function safeReload(reason) {
      if (reloading) return;
      reloading = true;
      try {
        const r = await fetch(`./index.html?online-check=${Date.now()}`, { cache: "no-store" });
        if (r.ok) { console.info("[display] reloading:", reason); location.reload(); return; }
      } catch {}
      console.warn("[display] site unreachable, staying on the current page:", reason);
      reloading = false;
    }

    function applyConfig(cfg, fromRemote = false) {
      const before = locationId();
      state.config = sanitizeConfig(cfg);
      state.configStamp++;

      if (!PREVIEW && fromRemote) {
        const token = state.config.reloadToken ?? 0;
        if (state.firstReloadToken === null) state.firstReloadToken = token;
        else if (token !== state.firstReloadToken) { state.firstReloadToken = token; safeReload("admin pressed Reload all screens"); }
      }

      if (state.raw) {
        try { state.data = normalise(state.raw, locationId()); } catch {}
      }
      if (before !== locationId()) loadPrayers().then(tick);
      tick();
    }

    async function loadLive() {
      const id = locationId();
      const [prayers, date, locations] = await Promise.all([
        getJSON(`${SETUP.apiBase}/prayerTimes/regular/${id}`),
        getJSON(`${SETUP.apiBase}/prayerTimes/date`).catch(() => null),
        getJSON(`${SETUP.apiBase}/prayerTimes/locations`).catch(() => null)
      ]);
      const loc = Array.isArray(locations) ? locations.find((l) => l.id === id) : null;
      return { prayers, day: nowLocal().day, date: date?.date, locationName: loc?.name };
    }

    async function loadBackup() {
      let lastErr;
      for (const url of [`${RAW_BASE()}prayerTimes.json`, "./prayerTimes.json"]) {
        try { return await getJSON(`${url}?t=${Date.now()}`); } catch (e) { lastErr = e; }
      }
      throw lastErr;
    }

    async function loadPrayers() {
      for (const [source, fn] of [["live", loadLive], ["backup", loadBackup]]) {
        if (source === "live" && Date.now() < net.livePausedUntil) continue;
        try {
          const raw = await fn();
          const data = normalise(raw, locationId());
          Object.assign(state, { raw, data, source, loadedAt: new Date(), renderedFor: "" });
          cacheSet(CACHE_PRAYERS, raw);
          return;
        } catch (e) {
          console.warn(`[display] ${source} prayers failed:`, e.message);
          if (source === "live") net.livePausedUntil = Date.now() + 60 * 60 * 1000;
        }
      }
      if (!state.data) {
        const cached = cacheGet(CACHE_PRAYERS);
        if (cached) { try { Object.assign(state, { raw: cached, data: normalise(cached, locationId()), source: "cache", renderedFor: "" }); } catch {} }
      }
    }

    /* ---------- Schedule logic ---------- */
    function todaysPrayers(now) {
      if (!state.data) return [];
      const friday = now.weekday.toLowerCase().startsWith("fri");
      const overrides = (state.config.overrides || []).filter((o) => isLive(o, now.day) && toSecs(o.time) != null);

      return state.data.prayers
        .filter((p) => (friday ? p.key !== "dhuhr" : !p.jumuah))
        .map((p) => {
          const o = overrides.find((x) => x.prayer === p.id);
          return o ? { ...p, iqamah: toSecs(o.time), overridden: true } : p;
        })
        .sort((a, b) => (a.iqamah ?? a.start) - (b.iqamah ?? b.start));
    }

    function currentPhase(list, now) {
      const t = now.secs;
      const windowSecs = (+state.config.salahInProgressMin || 0) * 60;

      for (const p of list) {
        if (p.iqamah != null && t >= p.iqamah && t < p.iqamah + windowSecs) return { prayer: p, phase: "now" };
      }

      for (const p of list) {
        const iq = p.iqamah ?? p.start;
        if (iq > t) {
          if (p.jumuah) return { prayer: p, phase: "iqamah-only", target: iq };
          if (p.start != null && p.start < iq && t >= p.start) return { prayer: p, phase: "iqamah", target: iq };
          const target = p.start != null && p.start > t ? p.start : iq;
          return { prayer: p, phase: target === iq ? "iqamah-only" : "adhan", target };
        }
      }

      const fajr = list.find((p) => p.key === "fajr");
      if (!fajr) return null;
      return { prayer: fajr, phase: fajr.start != null ? "adhan" : "iqamah-only", target: (fajr.start ?? fajr.iqamah) + 86400, tomorrow: true };
    }

    /* ---------- Rendering ---------- */
    function renderRows(list) {
      $("rows").innerHTML = list.map((p) => `
        <div class="row" data-id="${esc(p.id)}">
          <div class="pname"><span class="en">${esc(p.label)}</span><span class="ar">${esc(p.arabic)}</span></div>
          <div class="col-time t">${p.start != null ? timeHTML(p.start) : "—"}</div>
          <div class="col-time t iq">${timeHTML(p.iqamah ?? p.start)}</div>
        </div>`).join("");
    }

    function renderHeaderData() {
      const d = state.data;
      const name = d?.locationName || (locationId() === 2 ? "Mosque Aisha (Thorold)" : "Mosque Aisha (Stanley Ave)");
      const short = name.replace(/^Mosque Aisha\s*\(?/i, "").replace(/\)$/, "");
      $("locationName").textContent = short.toLowerCase().includes("thorold") ? "Thorold, Ontario" : `${short} · Niagara Falls`;
      $("hijri").textContent = cleanHijri(d?.hijri) || hijriFallback();
    }

    function renderStatus(now) {
      const el = $("status"), txt = $("statusText");
      if (!state.data) { el.className = "status warn"; txt.textContent = "Prayer times unavailable — check internet"; return; }
      if (state.data.day && state.data.day !== now.day) {
        const label = new Date(state.data.day + "T12:00:00").toLocaleDateString("en-CA", { month: "short", day: "numeric" });
        el.className = "status warn";
        txt.textContent = `Offline · showing times from ${label}`;
        return;
      }
      el.className = "status";
      const at = state.loadedAt ? state.loadedAt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: SETUP.timezone }) : "";
      txt.textContent = PREVIEW ? "Preview" : state.source === "cache" ? "Using saved times" : `Updated ${at}`;
    }

    function renderClock(now) {
      const t = fmt12(now.secs);
      $("hm").textContent = t.hm;
      $("ss").textContent = `:${String(now.s).padStart(2, "0")}`;
      $("ap").textContent = t.ap;
      $("gregorian").textContent = new Intl.DateTimeFormat("en-CA", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: SETUP.timezone }).format(new Date());
    }

    function renderNext(list, now) {
      const card = $("next");
      card.classList.remove("is-iqamah", "is-now");
      document.querySelectorAll(".row").forEach((r) => r.classList.remove("active", "done"));

      const info = currentPhase(list, now);
      if (!info) {
        $("nextName").textContent = "—"; $("nextNameAr").textContent = "";
        $("nextSub").innerHTML = "&nbsp;"; $("countLabel").innerHTML = "&nbsp;"; $("count").textContent = "--";
        return;
      }

      const p = info.prayer;
      $("nextName").textContent = p.label;
      $("nextNameAr").textContent = p.arabic;

      if (info.phase === "now") {
        card.classList.add("is-now");
        $("nextLabel").textContent = "Now";
        $("nextSub").innerHTML = `Iqamah <strong>${timeText(p.iqamah)}</strong>`;
        $("countLabel").textContent = "Salah in progress";
        $("count").textContent = "Please silence your phone";
      } else {
        $("nextLabel").textContent = info.tomorrow ? "Next prayer · tomorrow" : "Next prayer";
        const isJum = p.jumuah;
        if (info.phase === "iqamah") {
          card.classList.add("is-iqamah");
          $("countLabel").textContent = "Iqamah in";
          $("nextSub").innerHTML = `Adhan was at <strong>${timeText(p.start)}</strong>`;
        } else if (info.phase === "adhan") {
          $("countLabel").textContent = "Adhan in";
          $("nextSub").innerHTML = p.iqamah != null && p.iqamah !== p.start
            ? `Iqamah at <strong>${timeText(p.iqamah)}</strong>`
            : `Adhan at <strong>${timeText(p.start)}</strong>`;
        } else {
          $("countLabel").textContent = isJum ? "Starts in" : "Iqamah in";
          $("nextSub").innerHTML = `${isJum ? "Starts" : "Iqamah"} at <strong>${timeText(p.iqamah)}</strong>`;
        }
        $("count").textContent = fmtCountdown(info.target - now.secs);
      }

      const rows = [...document.querySelectorAll("#rows .row")];
      const idx = rows.findIndex((r) => r.dataset.id === p.id);
      rows.forEach((r, k) => {
        if (k === idx) r.classList.add("active");
        else if (!info.tomorrow && k < idx) r.classList.add("done");
      });
    }

    /* ---------- Slides ---------- */
    const slideUrl = (src) => /^https?:\/\//i.test(src) ? src : RAW_BASE() + src.split("/").map(encodeURIComponent).join("/");
    const slideTimer = { id: null };

    function renderSlides(now) {
      const slides = (state.config.slides || []).filter((s) => s.src && isLive(s, now.day));
      const sig = JSON.stringify(slides.map((s) => [s.src, s.seconds])) + "|" + state.config.slideSeconds;
      if (sig === state.slideSig) return;
      state.slideSig = sig;

      clearTimeout(slideTimer.id);
      const layers = [$("imgA"), $("imgB")];
      layers.forEach((l) => { l.classList.remove("show"); l.removeAttribute("src"); l.onload = null; });
      updateBoardVisibility(slides.length);
      if (!slides.length) return;

      let i = 0, front = 0;
      const step = () => {
        const s = slides[i];
        const layer = layers[1 - front];
        layer.onload = () => {
          layer.classList.add("show");
          layers[front].classList.remove("show");
          front = 1 - front;
        };
        layer.onerror = () => console.warn("[display] slide failed to load:", s.src);
        layer.src = slideUrl(s.src);
        const secs = +s.seconds || +state.config.slideSeconds || 15;
        i = (i + 1) % slides.length;
        if (slides.length > 1) slideTimer.id = setTimeout(step, secs * 1000);
      };
      step();
    }

    function updateBoardVisibility(slideCount) {
      const hasAlert = $("board").classList.contains("has-alert");
      const count = slideCount ?? (state.config.slides || []).filter((s) => s.src && isLive(s, nowLocal().day)).length;
      $("board").classList.toggle("empty", !count && !hasAlert);
    }

    /* ---------- Ticker & alert ---------- */
    function renderTicker(now) {
      const msgs = (state.config.ticker || []).filter((m) => m.text && isLive(m, now.day)).map((m) => m.text.trim());
      const sig = JSON.stringify(msgs);
      if (sig === state.tickerSig) return;
      state.tickerSig = sig;

      const bar = $("ticker"), inner = $("tickerInner");
      bar.classList.toggle("hidden", !msgs.length);
      if (!msgs.length) { inner.innerHTML = ""; return; }

      const one = msgs.map((m) => `<span class="msg">${esc(m)}</span><span class="sep">◆</span>`).join("");
      inner.classList.remove("static");
      inner.innerHTML = one;
      requestAnimationFrame(() => {
        const trackW = bar.querySelector(".ticker-track").clientWidth;
        const w = inner.scrollWidth;
        if (msgs.length === 1 && w - 70 <= trackW) {
          inner.classList.add("static");
          inner.innerHTML = `<span class="msg">${esc(msgs[0])}</span>`;
          return;
        }
        // repeat until the strip is at least twice the track width, then loop at -50%
        let html = one, reps = 1;
        while (w * reps < trackW) { html += one; reps++; }
        inner.innerHTML = html + html;
        inner.style.animationDuration = `${Math.max(12, (w * reps) / 90)}s`; // ~90px per second
      });
    }

    function renderAlert(now) {
      const a = state.config.alert || {};
      const on = !!(a.enabled && (a.title || a.text) && isLive({ ...a, enabled: true }, now.day));
      const sig = on ? JSON.stringify([a.title, a.text]) : "";
      if (sig === state.alertSig) return;
      state.alertSig = sig;
      $("alertTitle").textContent = on ? a.title || "" : "";
      $("alertText").textContent = on ? a.text || "" : "";
      $("board").classList.toggle("has-alert", on);
      updateBoardVisibility();
    }

    /* ---------- Night dimming ---------- */
    function renderDim(list, now) {
      const d = state.config.nightDim || {};
      let dim = false;
      if (d.enabled && list.length) {
        const isha = list.find((p) => p.key === "isha");
        const fajr = list.find((p) => p.key === "fajr");
        if (isha && fajr) {
          const start = ((isha.iqamah ?? isha.start) + (+d.afterIshaMin || 0) * 60) % 86400;
          const end = ((fajr.start ?? fajr.iqamah) - (+d.beforeFajrMin || 0) * 60 + 86400) % 86400;
          dim = start > end ? now.secs >= start || now.secs < end : now.secs >= start && now.secs < end;
        }
      }
      $("dim").style.opacity = dim ? Math.min(0.9, Math.max(0, +d.level || 0.65)) : 0;
    }

    /* ---------- Main loop ---------- */
    // One broken panel must never freeze the clock or the countdown
    function safely(fn, ...args) {
      try { return fn(...args); } catch (e) { console.error(`[display] ${fn.name} failed:`, e); }
    }

    function tick() {
      const now = nowLocal();

      if (state.today && state.today !== now.day && !PREVIEW) {
        safeReload("new day");
        loadPrayers().then(tick); // in case the reload can't happen (offline)
      }
      state.today = now.day;

      safely(renderClock, now);

      const list = safely(todaysPrayers, now) || [];
      const sig = `${now.day}|${now.weekday}|${state.loadedAt?.getTime() || 0}|${state.source}|${state.configStamp}`;
      if (sig !== state.renderedFor) {
        safely(renderRows, list);
        safely(renderHeaderData);
        state.renderedFor = sig;
      }

      safely(renderNext, list, now);
      safely(renderStatus, now);
      safely(renderAlert, now);
      safely(renderSlides, now);
      safely(renderTicker, now);
      safely(renderDim, list, now);
    }

    /* ---------- Fit the canvas to any screen ----------
       Portrait TVs get the 1080x1920 layout, landscape TVs (Fire TV etc.)
       the 1920x1080 one. ?layout=portrait|landscape forces either. */
    const LAYOUT = params.get("layout");
    function fit() {
      const landscape = LAYOUT ? LAYOUT === "landscape" : window.innerWidth > window.innerHeight;
      if (document.body.classList.contains("landscape") !== landscape) {
        document.body.classList.toggle("landscape", landscape);
        state.tickerSig = ""; // ticker width changes with the layout
      }
      const [w, h] = landscape ? [1920, 1080] : [1080, 1920];
      const s = Math.min(window.innerWidth / w, window.innerHeight / h);
      $("stage").style.transform = `translate(-50%, -50%) scale(${s})`;
    }

    /* ---------- Keep the screen awake (browsers that support it) ---------- */
    let wakeLock = null;
    async function keepAwake() {
      try {
        if ("wakeLock" in navigator && document.visibilityState === "visible" && !wakeLock) {
          wakeLock = await navigator.wakeLock.request("screen");
          wakeLock.addEventListener("release", () => { wakeLock = null; });
        }
      } catch (e) { console.warn("[display] wake lock unavailable:", e.message); }
    }
    document.addEventListener("visibilitychange", keepAwake);
    ["click", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, keepAwake, { passive: true }));
    setInterval(keepAwake, 60 * 1000);

    /* ---------- Preview bridge for admin.html ---------- */
    if (PREVIEW) {
      window.addEventListener("message", (e) => {
        // Preview mode only changes what this one tab shows, so any admin origin may drive it
        if (e.data?.type !== "mad-config") return;
        applyConfig(e.data.config || {});
      });
      window.parent?.postMessage({ type: "mad-preview-ready" }, "*");
    }

    /* ---------- Boot ---------- */
    fit();
    window.addEventListener("resize", fit);
    if (!PREVIEW) keepAwake();

    if (!PREVIEW) {
      const cachedCfg = cacheGet(CACHE_CONFIG);
      if (cachedCfg) applyConfig(cachedCfg);
    }
    const cachedPrayers = cacheGet(CACHE_PRAYERS);
    if (cachedPrayers) { try { Object.assign(state, { raw: cachedPrayers, data: normalise(cachedPrayers, locationId()), source: "cache" }); } catch {} }

    tick();
    setInterval(tick, 1000);

    // Offline cache: lets the screen start up and run even if the internet is down
    if (!PREVIEW && "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
      navigator.serviceWorker.register("./sw.js").catch((e) => console.warn("[display] offline cache unavailable:", e.message));
    }

    loadConfig().then(loadPrayers).then(tick);
    setInterval(loadConfig, SETUP.configPollMs);
    setInterval(() => loadPrayers().then(tick), SETUP.prayerPollMs);
  
