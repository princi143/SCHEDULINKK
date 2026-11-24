/* Shared helpers: API calls, formatting, toasts, sign-in, alerts, and real nearby places. */
const SL = (() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function api(path, opts = {}) {
    const init = { method: opts.method || (opts.body ? "POST" : "GET"), headers: {}, credentials: "same-origin" };
    if (opts.body) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.body); }
    let res;
    try { res = await fetch(path, init); }
    catch (e) { throw new Error("Can't reach Schedulink. Check your connection and try again."); }
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) { const err = new Error(data.error || "Something went wrong. Try again."); err.status = res.status; throw err; }
    return data;
  }

  function toast(msg, bad = false) {
    let box = $("#toasts");
    if (!box) { box = document.createElement("div"); box.id = "toasts"; box.setAttribute("aria-live", "polite"); document.body.appendChild(box); }
    const t = document.createElement("div");
    t.className = "toast" + (bad ? " bad" : "");
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 3600);
  }

  // ---- time & dates (the server speaks YYYY-MM-DD and 24h HH:MM)
  const pad = (n) => String(n).padStart(2, "0");
  const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const parseDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const dayStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (s, n) => { const d = parseDay(s); d.setDate(d.getDate() + n); return dayStr(d); };
  function time12(t) {
    const [h, m] = t.split(":").map(Number);
    return { hm: `${h % 12 || 12}:${pad(m)}`, ap: h < 12 ? "AM" : "PM", text: `${h % 12 || 12}:${pad(m)} ${h < 12 ? "AM" : "PM"}` };
  }
  function dayLabel(s, todayS) {
    if (s === todayS) return "Today";
    if (todayS && s === addDays(todayS, 1)) return "Tomorrow";
    const d = parseDay(s);
    return `${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`;
  }
  const km = (v) => (v == null ? "" : v < 1 ? `${Math.round(v * 1000 / 10) * 10} m` : `${v.toFixed(1)} km`);
  const rupees = (n) => (n ? "₹" + Number(n).toLocaleString("en-IN") : "Price on visit");
  function distanceKm(a, b, c, d) {
    const R = 6371, r = Math.PI / 180, dp = (c - a) * r, dl = (d - b) * r;
    const x = Math.sin(dp / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin(dl / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // ---- overlays
  function scrim() {
    let s = $("#scrim");
    if (!s) { s = document.createElement("div"); s.id = "scrim"; s.className = "scrim"; document.body.appendChild(s); s.addEventListener("click", closeAll); }
    return s;
  }
  function open(el) { scrim().classList.add("show"); el.classList.add("show"); const f = $("input,select,textarea,button.btn", el); if (f && el.classList.contains("modal")) setTimeout(() => f.focus(), 60); }
  function close(el) { el.classList.remove("show"); if (!$(".drawer.show,.modal.show")) scrim().classList.remove("show"); }
  function closeAll() { $$(".drawer.show,.modal.show").forEach((e) => e.classList.remove("show")); scrim().classList.remove("show"); }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
  document.addEventListener("click", (e) => { const x = e.target.closest("[data-close]"); if (x) close(x.closest(".drawer,.modal")); });

  // ---- alerts drawer (works for both account types)
  async function openAlerts() {
    let d = $("#alertsDrawer");
    if (!d) {
      d = document.createElement("aside");
      d.id = "alertsDrawer"; d.className = "drawer";
      d.innerHTML = `<div class="drawer-head"><div><h2>Alerts</h2><p class="muted small">Updates about your bookings</p></div><button class="close-x" data-close aria-label="Close">×</button></div><div class="drawer-body"><div class="note-list" id="alertsList"></div></div>`;
      document.body.appendChild(d);
    }
    open(d);
    const list = $("#alertsList");
    list.innerHTML = `<div class="skeleton"></div>`;
    try {
      const data = await api("/api/notifications");
      list.innerHTML = data.notifications.length
        ? data.notifications.map((n) => `<div class="note ${n.is_read ? "" : "unread"}"><b>${esc(n.title)}</b>${esc(n.body)}<br><time>${esc(n.created_at.slice(5, 16))}</time></div>`).join("")
        : `<div class="empty"><h3>No alerts yet</h3><p>Booking confirmations and queue updates show up here.</p></div>`;
      api("/api/notifications/read", { method: "POST" }).then(() => setBadge(0));
    } catch (e) { list.innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; }
  }
  function setBadge(n) { const b = $("#alertDot"); if (b) { b.textContent = n; b.hidden = !n; } }

  // ---- real nearby places from OpenStreetMap (Overpass API)
  const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
  function osmCategory(t) {
    if (t.amenity === "dentist" || t.healthcare === "dentist") return "dentist";
    if (t.amenity === "veterinary") return "vet";
    if (t.healthcare === "laboratory" || t.healthcare === "physiotherapist") return "lab";
    if (["doctors", "clinic", "hospital"].includes(t.amenity) || ["doctor", "clinic", "hospital"].includes(t.healthcare)) return "doctor";
    if (t.shop === "hairdresser" || t.shop === "beauty") return "salon";
    if (t.shop === "massage" || t.leisure === "spa") return "spa";
    if (t.leisure === "fitness_centre") return "fitness";
    if (t.office === "lawyer") return "legal";
    if (t.office === "accountant" || t.office === "tax_advisor") return "finance";
    if (t.shop === "car_repair" || t.shop === "motorcycle_repair") return "repair";
    return "other";
  }
  // OpenStreetMap tags for each profession. One profession can be searched across a whole city.
  const OSM_TAGS = {
    doctor: ['[amenity~"^(doctors|clinic|hospital)$"]', '[healthcare~"^(doctor|clinic|hospital)$"]'],
    dentist: ['[amenity=dentist]', '[healthcare=dentist]'],
    salon: ['[shop~"^(hairdresser|beauty)$"]'],
    spa: ['[shop=massage]', '[leisure=spa]'],
    vet: ['[amenity=veterinary]'],
    fitness: ['[leisure=fitness_centre]'],
    lab: ['[healthcare~"^(laboratory|physiotherapist)$"]'],
    legal: ['[office=lawyer]'],
    finance: ['[office~"^(accountant|tax_advisor)$"]'],
    repair: ['[shop~"^(car_repair|motorcycle_repair)$"]'],
  };
  function overpassQuery(lat, lng, r, category) {
    const a = `(around:${Math.round(r)},${lat},${lng})`;
    const tags = OSM_TAGS[category] || [].concat(...Object.values(OSM_TAGS));
    return `[out:json][timeout:25];(` + tags.map((t) => `nwr${a}[name]${t};`).join("") + `);out center tags ${category ? 600 : 300};`;
  }
  async function overpass(query) {
    let lastErr;
    for (const url of OVERPASS) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 14000);
      try {
        const res = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(query), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error("HTTP " + res.status);
        return await res.json();
      } catch (e) { clearTimeout(timer); lastErr = e; }
    }
    throw lastErr || new Error("Map data is unavailable");
  }
  /** Real businesses around a point. Cached for 6 hours per ~100 m cell. */
  async function nearbyPlaces(lat, lng, radiusM = 2500, category = "") {
    const key = `sl_places2_${lat.toFixed(3)}_${lng.toFixed(3)}_${radiusM}_${category}`;
    try {
      const hit = JSON.parse(localStorage.getItem(key) || "null");
      if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.places;
    } catch (e) { /* storage unavailable */ }
    const data = await overpass(overpassQuery(lat, lng, radiusM, category));
    const seen = new Set();
    const places = [];
    for (const el of data.elements || []) {
      const t = el.tags || {};
      const plat = el.lat ?? el.center?.lat, plng = el.lon ?? el.center?.lon;
      if (!t.name || plat == null) continue;
      const dedupe = t.name.toLowerCase() + "|" + plat.toFixed(3) + "|" + plng.toFixed(3);
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      const addr = [[t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" "), t["addr:suburb"] || t["addr:neighbourhood"], t["addr:city"]].filter(Boolean).join(", ");
      places.push({
        osm_id: `${el.type}/${el.id}`, name: t.name, category: osmCategory(t), lat: plat, lng: plng,
        address: addr, phone: t.phone || t["contact:phone"] || t["contact:mobile"] || "", hours: t.opening_hours || "",
        website: t.website || t["contact:website"] || "",
        distance_km: distanceKm(lat, lng, plat, plng),
      });
    }
    places.sort((a, b) => a.distance_km - b.distance_km);
    try { localStorage.setItem(key, JSON.stringify({ at: Date.now(), places })); } catch (e) { /* quota */ }
    return places;
  }
  /** Look up an area, PIN code or city. `spanKm` says how big the matched place is
      (a city is tens of km across, a PIN code a few). */
  async function geocode(text) {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=in&q=${encodeURIComponent(text)}`, { headers: { "Accept-Language": "en" } });
    const hits = await res.json();
    if (!hits.length) throw new Error(`Couldn't find “${text}”. Try a nearby landmark or a 6-digit PIN code.`);
    const h = hits[0], bb = (h.boundingbox || []).map(Number);
    const spanKm = bb.length === 4 ? distanceKm(bb[0], bb[2], bb[1], bb[3]) : 0;
    return { lat: +h.lat, lng: +h.lon, label: h.display_name.split(",").slice(0, 2).join(","), spanKm };
  }
  async function reverseGeocode(lat, lng) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=16&lat=${lat}&lon=${lng}`, { headers: { "Accept-Language": "en" } });
      const j = await res.json();
      const a = j.address || {};
      return {
        label: [...new Set([a.neighbourhood || a.suburb || a.road || a.village, a.city || a.town || a.county].filter(Boolean))].join(", ") || "your location",
        city: a.city || a.town || a.county || "", pincode: a.postcode || "",
        address: [...new Set([a.road, a.neighbourhood || a.suburb].filter(Boolean))].join(", "),
      };
    } catch (e) { return { label: "your location", city: "", pincode: "", address: "" }; }
  }
  function locate() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error("This browser can't share location. Type your area instead."));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        (e) => reject(new Error(e.code === 1 ? "Location is blocked for this site. Allow it in your browser's site settings, or type your area instead." : "Couldn't get your location. Type your area instead.")),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 });
    });
  }

  const CAT_ICON = { doctor: "🩺", dentist: "🦷", salon: "✂️", spa: "💆", vet: "🐾", fitness: "🏋️", lab: "🧪", legal: "⚖️", finance: "🧾", repair: "🔧", other: "📍" };

  return { $, $$, esc, api, toast, pad, DOW, MON, parseDay, dayStr, addDays, time12, dayLabel, km, rupees, distanceKm, open, close, closeAll, openAlerts, setBadge, nearbyPlaces, geocode, reverseGeocode, locate, CAT_ICON };
})();
