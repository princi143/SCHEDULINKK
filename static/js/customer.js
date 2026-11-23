/* Customer page: live location → real nearby places → book → track your turn. */
(() => {
  const { $, $$, esc, api, toast, time12, dayLabel, addDays, parseDay, km, rupees, DOW, CAT_ICON } = SL;
  const CATS = window.SL_CATEGORIES;
  const S = {
    me: null, loc: null, today: null,
    businesses: [], places: null, placesError: null, leads: new Set(),
    cat: "all", q: "",
    map: null, layer: null, markers: {},
    book: null,            // { biz, serviceId, date, time, slots, reschedule }
    afterAuth: null, authMode: "login", pollTimer: null,
  };

  // ------------------------------------------------------------ account
  async function loadMe() {
    const data = await api("/api/me");
    S.me = data.account && data.account.role === "customer" ? data.account : null;
    const pro = data.account && data.account.role === "professional";
    $("#whoBox").innerHTML = S.me
      ? `<div class="who"><span class="avatar">${esc(S.me.name[0].toUpperCase())}</span><button class="link small" id="signOut" type="button">Sign out</button></div>`
      : pro ? `<a class="btn sm soft" href="/professional">Open my dashboard</a>`
      : `<button class="btn sm ghost" id="signInBtn" type="button">Sign in</button>`;
    $("#alertsBtn").hidden = !S.me;
    if (S.me) {
      SL.setBadge(data.unread);
      api("/api/leads/mine").then((d) => { S.leads = new Set(d.osm_ids); renderResults(); }).catch(() => {});
    }
  }
  document.addEventListener("click", async (e) => {
    if (e.target.id === "signInBtn") openAuth();
    if (e.target.id === "signOut") { await api("/api/auth/logout", { method: "POST" }); location.reload(); }
  });
  $("#alertsBtn").addEventListener("click", SL.openAlerts);

  function openAuth(then, title) {
    S.afterAuth = then || null;
    $("#authTitle").textContent = title || "Sign in";
    $("#authError").textContent = "";
    SL.open($("#authModal"));
  }
  function requireAuth(then, title) { if (S.me) then(); else openAuth(then, title); }
  $$("#authModal .seg button").forEach((b) => b.addEventListener("click", () => {
    S.authMode = b.dataset.mode;
    $$("#authModal .seg button").forEach((x) => x.classList.toggle("on", x === b));
    $("#authNameField").hidden = S.authMode !== "register";
    $("#authSubmit").textContent = S.authMode === "register" ? "Create account" : "Sign in";
    $("#authPass").autocomplete = S.authMode === "register" ? "new-password" : "current-password";
  }));
  $("#authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#authSubmit");
    btn.disabled = true;
    try {
      if (S.authMode === "register") {
        await api("/api/auth/register", { body: { role: "customer", name: $("#authName").value, phone: $("#authPhone").value, password: $("#authPass").value } });
      } else {
        await api("/api/auth/login", { body: { role: "customer", login: $("#authPhone").value, password: $("#authPass").value } });
      }
      await loadMe();
      SL.close($("#authModal"));
      toast(`Signed in as ${S.me.name}`);
      const next = S.afterAuth; S.afterAuth = null;
      if (next) next();
    } catch (err) { $("#authError").textContent = err.message; }
    btn.disabled = false;
  });

  // ------------------------------------------------------------ views
  function show(view) {
    $$(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    $("#view-discover").hidden = view !== "discover";
    $("#view-bookings").hidden = view !== "bookings";
    clearInterval(S.pollTimer);
    if (view === "bookings") { loadBookings(); S.pollTimer = setInterval(() => { if (!document.hidden) loadBookings(true); }, 20000); }
    if (view === "discover" && S.map) setTimeout(() => S.map.invalidateSize(), 50);
  }
  $$(".tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));

  // ------------------------------------------------------------ location
  $("#useLocation").addEventListener("click", async () => {
    const btn = $("#useLocation");
    $("#locateError").textContent = "";
    btn.disabled = true; btn.lastChild.textContent = " Finding you…";
    try {
      const p = await SL.locate();
      setLocation(p.lat, p.lng, null);
    } catch (e) { $("#locateError").textContent = e.message; }
    btn.disabled = false; btn.lastChild.textContent = " Use my location";
  });
  $("#areaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#areaInput").value.trim();
    if (!text) return;
    $("#locateError").textContent = "";
    try { const g = await SL.geocode(text); setLocation(g.lat, g.lng, g.label); }
    catch (err) { $("#locateError").textContent = err.message || "Couldn't look that up. Try again."; }
  });
  $("#locPill").addEventListener("click", () => {
    $("#finder").hidden = true; $("#locatePanel").hidden = false; $("#locPill").hidden = true;
    localStorage.removeItem("sl_loc");
  });

  async function setLocation(lat, lng, label) {
    S.loc = { lat, lng, label: label || "your location" };
    $("#locatePanel").hidden = true; $("#finder").hidden = false; $("#locPill").hidden = false;
    $("#locLabel").textContent = "Near " + S.loc.label;
    try { localStorage.setItem("sl_loc", JSON.stringify(S.loc)); } catch (e) { /* ignore */ }
    initMap();
    S.places = null; S.placesError = null;
    renderResults();
    loadBusinesses();
    loadPlaces();
    if (!label) SL.reverseGeocode(lat, lng).then((r) => {
      S.loc.label = r.label; $("#locLabel").textContent = "Near " + r.label;
      try { localStorage.setItem("sl_loc", JSON.stringify(S.loc)); } catch (e) { /* ignore */ }
    });
  }

  async function loadBusinesses() {
    try {
      const d = await api(`/api/businesses?lat=${S.loc.lat}&lng=${S.loc.lng}&radius=25`);
      S.businesses = d.businesses.filter((b) => b.distance_km != null);
      S.today = d.today;
    } catch (e) { toast(e.message, true); }
    renderResults();
  }
  async function loadPlaces() {
    try {
      let places = await SL.nearbyPlaces(S.loc.lat, S.loc.lng, 2500);
      if (places.length < 8) places = await SL.nearbyPlaces(S.loc.lat, S.loc.lng, 7000);
      S.places = places;
    } catch (e) { S.places = []; S.placesError = true; }
    renderResults();
  }

  // ------------------------------------------------------------ map
  function initMap() {
    if (!S.map) {
      S.map = L.map("map", { zoomControl: false, attributionControl: true }).setView([S.loc.lat, S.loc.lng], 15);
      L.control.zoom({ position: "bottomright" }).addTo(S.map);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(S.map);
      S.layer = L.layerGroup().addTo(S.map);
    } else S.map.setView([S.loc.lat, S.loc.lng], 15);
    if (S.meMarker) S.meMarker.remove();
    S.meMarker = L.marker([S.loc.lat, S.loc.lng], { icon: L.divIcon({ className: "", html: '<div class="me-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), zIndexOffset: 1000, keyboard: false }).addTo(S.map).bindPopup("You are here");
    setTimeout(() => S.map.invalidateSize(), 80);
  }
  function pin(kind, cat) {
    return L.divIcon({ className: "", html: `<div class="pin ${kind}"><span>${CAT_ICON[cat] || "📍"}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -28] });
  }
  function drawMarkers(live, unlisted) {
    S.layer.clearLayers(); S.markers = {};
    unlisted.forEach((p) => {
      const m = L.marker([p.lat, p.lng], { icon: pin("", p.category), title: p.name }).addTo(S.layer);
      m.bindPopup(`<b>${esc(p.name)}</b><br>${esc(CATS[p.category])} · ${km(p.distance_km)}<br><span class="muted">Not on Schedulink yet</span>`);
      m.on("click", () => focusCard("p-" + p.osm_id));
      S.markers["p-" + p.osm_id] = m;
    });
    live.forEach((b) => {
      const m = L.marker([b.lat, b.lng], { icon: pin("live", b.category), title: b.name, zIndexOffset: 500 }).addTo(S.layer);
      m.on("click", () => openBusiness(b.id));
      S.markers["b-" + b.id] = m;
    });
  }
  function focusCard(key) {
    $$(".place.hl").forEach((c) => c.classList.remove("hl"));
    const card = document.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (card) { card.classList.add("hl"); card.scrollIntoView({ behavior: "smooth", block: "center" }); }
  }

  // ------------------------------------------------------------ results list
  function matches(item) {
    if (S.cat !== "all" && item.category !== S.cat) return false;
    if (!S.q) return true;
    const hay = `${item.name} ${CATS[item.category] || ""} ${item.address || ""} ${item.owner_name || ""}`.toLowerCase();
    return S.q.split(/\s+/).every((w) => hay.includes(w));
  }
  function nextSlotChip(b) {
    if (!b.next_slot) return `<span class="next-slot none">No open slots this week</span>`;
    const t = time12(b.next_slot.time);
    return `<span class="next-slot">Next free <b>${dayLabel(b.next_slot.date, S.today)} ${t.text}</b></span>`;
  }
  function renderResults() {
    if (!S.loc) return;
    const claimed = new Set(S.businesses.map((b) => b.osm_id).filter(Boolean));
    const allUnlisted = (S.places || []).filter((p) => !claimed.has(p.osm_id));
    const present = new Set([...S.businesses, ...allUnlisted].map((x) => x.category));
    $("#catChips").innerHTML = [`<button class="chip ${S.cat === "all" ? "on" : ""}" data-cat="all" type="button">All nearby</button>`]
      .concat(Object.keys(CATS).filter((c) => present.has(c)).map((c) => `<button class="chip ${S.cat === c ? "on" : ""}" data-cat="${c}" type="button">${CAT_ICON[c]} ${esc(CATS[c])}</button>`)).join("");

    const live = S.businesses.filter(matches);
    const unlisted = allUnlisted.filter(matches);
    let html = "";

    html += `<div class="group-head"><h2>Book now on Schedulink</h2><span>${live.length ? live.length + " nearby" : ""}</span></div>`;
    if (live.length) {
      html += live.map((b) => `
        <button class="place live" data-key="b-${b.id}" data-biz="${b.id}" type="button">
          <div class="top">
            <div class="ico">${CAT_ICON[b.category]}</div>
            <div style="min-width:0"><h3>${esc(b.name)}</h3><div class="sub">${esc(b.category_label)}${b.rating ? ` · <span class="rating">${b.rating.avg}</span> (${b.rating.count})` : ""}</div></div>
            <div class="dist">${km(b.distance_km)}</div>
          </div>
          <div class="bottom">${nextSlotChip(b)}${b.seats_today ? `<span class="badge amber">${b.seats_today} left today</span>` : ""}<span class="grow"></span><span class="btn sm">Book</span></div>
        </button>`).join("");
    } else {
      html += `<div class="card small" style="margin-bottom:10px"><b>No one near you takes Schedulink bookings ${S.cat === "all" && !S.q ? "yet" : "for this filter"}.</b><br><span class="muted">Ask a place below for online booking — each request is shown to the business when it joins, and you're alerted the moment it's bookable.</span></div>`;
    }

    html += `<div class="group-head"><h2>Also near you</h2><span>${S.places ? unlisted.length + " places" : ""}</span></div>`;
    if (S.places === null) html += `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    else if (S.placesError) html += `<div class="empty"><h3>Map data didn't load</h3><p>OpenStreetMap's servers are busy. Your bookable results above are unaffected.</p><button class="btn ghost" id="retryPlaces" type="button">Try again</button></div>`;
    else if (!unlisted.length) html += `<div class="empty"><p>No mapped places match here. Try another category or a wider area.</p></div>`;
    else {
      html += `<p class="source-note">Real places from OpenStreetMap. They haven't joined Schedulink, so times aren't shown.</p>`;
      html += unlisted.slice(0, 80).map((p) => {
        const asked = S.leads.has(p.osm_id);
        return `
        <div class="place unlisted" data-key="p-${esc(p.osm_id)}" data-place="${esc(p.osm_id)}">
          <div class="top">
            <div class="ico">${CAT_ICON[p.category]}</div>
            <div style="min-width:0"><h3>${esc(p.name)}</h3><div class="sub">${esc(CATS[p.category])}${p.address ? " · " + esc(p.address) : ""}</div></div>
            <div class="dist">${km(p.distance_km)}</div>
          </div>
          <div class="bottom">
            <button class="btn sm ${asked ? "ghost" : "soft"}" data-ask="${esc(p.osm_id)}" type="button" ${asked ? "disabled" : ""}>${asked ? "Requested ✓" : "Ask for online booking"}</button>
            ${p.phone ? `<a class="btn sm ghost" href="tel:${esc(p.phone.split(";")[0])}">Call</a>` : ""}
            <a class="btn sm ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}">Directions</a>
          </div>
        </div>`;
      }).join("");
    }
    $("#results").innerHTML = html;
    if (S.map) drawMarkers(live, unlisted.slice(0, 80));
  }
  $("#catChips").addEventListener("click", (e) => { const c = e.target.closest("[data-cat]"); if (c) { S.cat = c.dataset.cat; renderResults(); } });
  $("#search").addEventListener("input", (e) => { S.q = e.target.value.trim().toLowerCase(); renderResults(); });
  $("#results").addEventListener("click", (e) => {
    if (e.target.id === "retryPlaces") { S.places = null; S.placesError = null; renderResults(); loadPlaces(); return; }
    const ask = e.target.closest("[data-ask]");
    if (ask) return askForBooking(ask.dataset.ask);
    if (e.target.closest("a")) return;
    const biz = e.target.closest("[data-biz]");
    if (biz) return openBusiness(+biz.dataset.biz);
    const place = e.target.closest("[data-place]");
    if (place) { const m = S.markers["p-" + place.dataset.place]; if (m) { S.map.setView(m.getLatLng(), 17); m.openPopup(); } }
  });
  $("#results").addEventListener("mouseover", (e) => {
    const card = e.target.closest("[data-key]"); if (!card) return;
    const m = S.markers[card.dataset.key]; if (m && m._icon) { m._icon.firstChild.classList.add("hot"); card.addEventListener("mouseleave", () => m._icon && m._icon.firstChild.classList.remove("hot"), { once: true }); }
  });
  function askForBooking(osmId) {
    const p = (S.places || []).find((x) => x.osm_id === osmId);
    if (!p) return;
    requireAuth(async () => {
      try {
        const d = await api("/api/leads", { body: { osm_id: p.osm_id, name: p.name, category: p.category, lat: p.lat, lng: p.lng } });
        S.leads.add(p.osm_id); renderResults();
        toast(d.requests > 1 ? `Requested — ${d.requests} people want to book ${p.name}` : `Requested. We'll alert you when ${p.name} is bookable.`);
      } catch (e) { toast(e.message, true); }
    }, "Sign in to request");
  }

  // ------------------------------------------------------------ booking drawer
  async function openBusiness(id, reschedule) {
    const drawer = $("#bookDrawer");
    $("#bdName").textContent = "Loading…"; $("#bdCategory").textContent = ""; $("#bdMeta").textContent = "";
    $("#bdBody").innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
    $("#bdFoot").hidden = true;
    SL.open(drawer);
    try {
      const biz = await api(`/api/businesses/${id}`);
      S.today = biz.today;
      const firstOpen = Object.keys(biz.open_days)[0];
      S.book = { biz, serviceId: reschedule ? null : biz.services[0]?.id ?? null, date: firstOpen || biz.today, time: null, slots: null, reschedule: reschedule || null };
      renderDrawer();
      loadSlots();
    } catch (e) { $("#bdName").textContent = "Not available"; $("#bdBody").innerHTML = `<div class="empty"><p>${esc(e.message)}</p></div>`; }
  }
  function renderDrawer() {
    const { biz, reschedule } = S.book;
    const known = S.businesses.find((b) => b.id === biz.id);
    $("#bdCategory").textContent = reschedule ? "Move your booking" : biz.category_label;
    $("#bdName").textContent = biz.name;
    $("#bdMeta").innerHTML = [known ? km(known.distance_km) + " away" : "", biz.rating ? `<span class="rating">${biz.rating.avg}</span> (${biz.rating.count})` : "", biz.auto_approve ? "Confirms instantly" : "Confirms after a quick check"].filter(Boolean).join(" · ");
    const days = [...Array(10)].map((_, i) => addDays(biz.today, i));
    let html = "";
    if (!reschedule) {
      html += `<h3>What do you need?</h3>` + (biz.services.length
        ? biz.services.map((s) => `<button class="svc ${s.id === S.book.serviceId ? "on" : ""}" data-svc="${s.id}" type="button"><span><b>${esc(s.name)}</b><span class="small muted">${s.duration_min} min</span></span><span class="price">${rupees(s.price)}</span></button>`).join("")
        : `<p class="muted small">General appointment</p>`);
    } else {
      html += `<div class="card small" style="margin-bottom:6px">Currently <b>${esc(reschedule.when)}</b>. Pick a new time — your old slot is released for someone else.</div>`;
    }
    html += `<h3>When?</h3><div class="days" id="bdDays">` + days.map((d) => {
      const dt = parseDay(d), free = biz.open_days[d] || 0;
      return `<button class="day ${d === S.book.date ? "on" : ""} ${free ? "" : "none"}" data-day="${d}" type="button"><div class="dow">${d === biz.today ? "Today" : DOW[dt.getDay()]}</div><div class="num">${dt.getDate()}</div><div class="free">${free ? free + " free" : "none"}</div></button>`;
    }).join("") + `</div><div id="bdSlots"><div class="skeleton" style="height:60px"></div></div>`;
    if (!reschedule) html += `<h3>Add a note (optional)</h3><textarea class="input" id="bdNote" rows="2" maxlength="300" placeholder="Anything they should know before you arrive"></textarea>`;
    html += `<h3>About</h3><div class="info-rows">
      ${biz.address || biz.city ? `<div><span>📍</span><span>${esc([biz.address, biz.city, biz.pincode].filter(Boolean).join(", "))}</span></div>` : ""}
      ${biz.phone ? `<div><span>📞</span><a href="tel:${esc(biz.phone)}">${esc(biz.phone)}</a></div>` : ""}
      ${biz.staff.length ? `<div><span>👥</span><span>${biz.staff.map((s) => esc(s.name)).join(", ")}</span></div>` : ""}
      ${biz.about ? `<div><span>ℹ️</span><span>${esc(biz.about)}</span></div>` : ""}
      ${biz.lat != null ? `<div><span>🧭</span><a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${biz.lat},${biz.lng}">Get directions</a></div>` : ""}
    </div>`;
    if (biz.reviews.length) html += `<h3>Recent ratings</h3>` + biz.reviews.map((r) => `<div class="review"><span class="rating">${r.rating}</span> · ${esc(r.customer_name || "Customer")}${r.comment ? `<br>${esc(r.comment)}` : ""}</div>`).join("");
    $("#bdBody").innerHTML = html;
    $("#bdFoot").hidden = false;
    updateConfirm();
  }
  async function loadSlots() {
    const { biz, date } = S.book;
    S.book.time = null; updateConfirm();
    try {
      const d = await api(`/api/businesses/${biz.id}/slots?date=${date}`);
      if (S.book.date !== date) return;
      S.book.slots = d.slots;
    } catch (e) { S.book.slots = []; }
    renderSlots();
  }
  function renderSlots() {
    const box = $("#bdSlots"); if (!box) return;
    const { slots, biz, date } = S.book;
    const open = slots.filter((s) => s.left > 0);
    if (!slots.length) {
      box.innerHTML = `<div class="card small">${esc(biz.name)} hasn't opened slots for ${dayLabel(date, biz.today).toLowerCase()}. Try another day.</div>`;
    } else {
      box.innerHTML = `<div class="slot-grid">` + slots.map((s) => {
        const t = time12(s.time);
        return `<button class="slot ${s.state} ${s.time === S.book.time ? "on" : ""}" data-time="${s.time}" type="button" ${s.left ? "" : "disabled"}>${t.text}<small>${s.left ? (s.state === "filling" ? `${s.left} left` : "open") : "full"}</small></button>`;
      }).join("") + `</div>` + (!open.length ? `<div class="card small" style="margin-top:10px">Every slot is taken ${dayLabel(date, biz.today).toLowerCase()}. <button class="link" id="waitlistBtn" type="button">Alert me if one opens</button></div>` : "");
    }
  }
  function updateConfirm() {
    const btn = $("#confirmBtn"); if (!S.book) return;
    if (S.book.time) { btn.disabled = false; btn.textContent = `${S.book.reschedule ? "Move to" : "Book"} ${dayLabel(S.book.date, S.book.biz.today)}, ${time12(S.book.time).text}`; }
    else { btn.disabled = true; btn.textContent = "Pick a time"; }
  }
  $("#bdBody").addEventListener("click", (e) => {
    const svc = e.target.closest("[data-svc]");
    if (svc) { S.book.serviceId = +svc.dataset.svc; $$(".svc").forEach((x) => x.classList.toggle("on", x === svc)); return; }
    const day = e.target.closest("[data-day]");
    if (day) { S.book.date = day.dataset.day; $$("#bdDays .day").forEach((x) => x.classList.toggle("on", x === day)); $("#bdSlots").innerHTML = `<div class="skeleton" style="height:60px"></div>`; loadSlots(); return; }
    const slot = e.target.closest("[data-time]");
    if (slot && !slot.disabled) { S.book.time = slot.dataset.time; $$(".slot").forEach((x) => x.classList.toggle("on", x === slot)); updateConfirm(); return; }
    if (e.target.id === "waitlistBtn") requireAuth(async () => {
      try { await api("/api/waitlist", { body: { business_id: S.book.biz.id, date: S.book.date } }); toast("You're on the list. We'll alert you if a slot opens."); e.target.replaceWith("You're on the list ✓"); }
      catch (err) { toast(err.message, true); }
    }, "Sign in to get the alert");
    if (e.target.id === "goBookings") { SL.closeAll(); show("bookings"); }
    if (e.target.dataset.ics) downloadIcs(S.lastBooking);
  });
  $("#confirmBtn").addEventListener("click", () => requireAuth(confirmBooking, "Sign in to book"));
  async function confirmBooking() {
    const btn = $("#confirmBtn");
    const { biz, serviceId, date, time, reschedule } = S.book;
    if (!time) return;
    btn.disabled = true; btn.textContent = "Booking…";
    try {
      const d = reschedule
        ? await api(`/api/bookings/${reschedule.id}/reschedule`, { body: { date, time } })
        : await api("/api/bookings", { body: { business_id: biz.id, service_id: serviceId, date, time, note: $("#bdNote")?.value || "" } });
      S.lastBooking = d.booking;
      $("#bdFoot").hidden = true;
      const confirmed = d.booking.status === "confirmed";
      $("#bdBody").innerHTML = `<div class="success">
        <div class="tick">✓</div>
        <h2>${reschedule ? "Booking moved" : confirmed ? "You're booked" : "Request sent"}</h2>
        <p class="muted">${confirmed ? "Arrive at your time — no waiting room guesswork." : `${esc(biz.name)} will confirm shortly. You'll get an alert.`}</p>
        ${ticketHtml(d.booking, { plain: true })}
        <div style="display:grid;gap:8px">
          <button class="btn block" id="goBookings" type="button">Track it in My bookings</button>
          <button class="btn ghost block" data-ics="1" type="button">Add to calendar</button>
        </div></div>`;
      loadBusinesses();
      api("/api/me").then((m) => SL.setBadge(m.unread));
    } catch (e) {
      toast(e.message, true);
      if (e.status === 409) loadSlots();
      updateConfirm();
    }
  }

  // ------------------------------------------------------------ my bookings
  function ticketHtml(b, opt = {}) {
    const t = time12(b.time);
    const active = ["pending", "confirmed", "checked_in", "in_service"].includes(b.status);
    const tone = { pending: "amber", confirmed: "teal", checked_in: "teal", in_service: "dark", completed: "", cancelled: "red", rejected: "red", no_show: "red" }[b.status];
    let queue = "";
    if (b.status === "in_service") queue = `<div class="queue-line"><span class="badge live dark">Now</span> It's your turn — you're being served.</div>`;
    else if (b.queue) {
      const q = b.queue, eta = time12(q.eta).text;
      queue = q.delay_min >= 5
        ? `<div class="queue-line late">Running about <b>${q.delay_min} min</b> late · <b>${q.ahead}</b> ahead of you · expect <b>${eta}</b></div>`
        : `<div class="queue-line"><span class="badge live teal">Live</span> ${q.ahead ? `<b>${q.ahead}</b> ahead of you` : "You're next"} · on time for <b>${eta}</b></div>`;
    }
    const biz = b.business || {};
    const actions = opt.plain ? "" : `<div class="actions">
        ${["pending", "confirmed"].includes(b.status) ? `<button class="btn sm soft" data-act="move" data-id="${b.id}" type="button">Change time</button><button class="btn sm danger" data-act="cancel" data-id="${b.id}" type="button">Cancel</button>` : ""}
        ${active && biz.lat != null ? `<a class="btn sm ghost" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${biz.lat},${biz.lng}">Directions</a>` : ""}
        ${active ? `<button class="btn sm ghost" data-act="ics" data-id="${b.id}" type="button">Add to calendar</button>` : ""}
        ${b.status === "completed" && !b.reviewed ? `<button class="btn sm amber" data-act="rate" data-id="${b.id}" type="button">Rate visit</button>` : ""}
        ${!active ? `<button class="btn sm ghost" data-act="again" data-id="${b.id}" type="button">Book again</button>` : ""}
      </div>`;
    return `<article class="ticket ${b.queue || b.status === "in_service" ? "now" : ""} ${active ? "" : "dim"}">
      <div class="main">
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><span class="badge ${tone}">${esc(b.status_label)}</span>${b.reviewed ? `<span class="badge">Rated</span>` : ""}</div>
        <h4>${esc(biz.name || "Appointment")}</h4>
        <div class="meta">${esc(b.service_name)}${b.price ? " · " + rupees(b.price) : ""} · ${dayLabel(b.date, S.today)}</div>
        ${queue}${actions}
      </div>
      <div class="stub"><div class="time">${t.hm}</div><div class="ampm">${t.ap}</div><div class="token">${esc(b.token)}</div></div>
    </article>`;
  }
  async function loadBookings(quiet) {
    const box = $("#bookingsBox");
    if (!S.me) {
      box.innerHTML = `<div class="empty card"><h3>Sign in to see your bookings</h3><p>Your upcoming appointments and live queue position live here.</p><button class="btn" id="bkSignIn" type="button">Sign in</button></div>`;
      $("#bkSignIn").onclick = () => openAuth(() => loadBookings());
      return;
    }
    if (!quiet) box.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div>`;
    try {
      const d = await api("/api/my/bookings");
      S.today = d.today; S.myBookings = d.bookings;
      const live = (b) => ["pending", "confirmed", "checked_in", "in_service"].includes(b.status) && b.date >= d.today;
      const up = d.bookings.filter(live).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      const past = d.bookings.filter((b) => !live(b));
      box.innerHTML = (up.length
        ? `<p class="section-label">Coming up</p>` + up.map((b) => ticketHtml(b)).join("")
        : `<div class="empty card"><h3>Nothing booked</h3><p>Find someone nearby with a free slot — it takes two taps.</p><button class="btn" id="bkFind" type="button">Find a slot</button></div>`)
        + (past.length ? `<p class="section-label">Earlier</p>` + past.map((b) => ticketHtml(b)).join("") : "");
      const f = $("#bkFind"); if (f) f.onclick = () => show("discover");
    } catch (e) { if (!quiet) box.innerHTML = `<div class="empty card"><p>${esc(e.message)}</p></div>`; }
  }
  $("#bookingsBox").addEventListener("click", async (e) => {
    const el = e.target.closest("[data-act]"); if (!el) return;
    const b = (S.myBookings || []).find((x) => x.id === +el.dataset.id); if (!b) return;
    const act = el.dataset.act;
    if (act === "cancel") {
      if (el.dataset.sure !== "1") { el.dataset.sure = "1"; el.textContent = "Tap again to cancel"; setTimeout(() => { el.dataset.sure = ""; el.textContent = "Cancel"; }, 3500); return; }
      try { await api(`/api/bookings/${b.id}/cancel`, { method: "POST" }); toast("Booking cancelled. The slot is free for someone else."); loadBookings(true); }
      catch (err) { toast(err.message, true); }
    }
    if (act === "move") openBusiness(b.business_id, b);
    if (act === "again") openBusiness(b.business_id);
    if (act === "ics") downloadIcs(b);
    if (act === "rate") openRate(b);
  });

  function downloadIcs(b) {
    if (!b) return;
    const [y, m, d] = b.date.split("-"), [hh, mm] = b.time.split(":");
    const start = `${y}${m}${d}T${hh}${mm}00`;
    const endDate = new Date(+y, +m - 1, +d, +hh, +mm + (b.duration_min || 30));
    const end = `${endDate.getFullYear()}${SL.pad(endDate.getMonth() + 1)}${SL.pad(endDate.getDate())}T${SL.pad(endDate.getHours())}${SL.pad(endDate.getMinutes())}00`;
    const biz = b.business || {};
    const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Schedulink//EN", "BEGIN:VEVENT", `UID:schedulink-${b.id}@schedulink`, `DTSTART:${start}`, `DTEND:${end}`,
      `SUMMARY:${b.service_name} at ${biz.name || "appointment"}`, `LOCATION:${[biz.address, biz.city].filter(Boolean).join(", ")}`, `DESCRIPTION:Schedulink token ${b.token}`,
      "BEGIN:VALARM", "TRIGGER:-PT30M", "ACTION:DISPLAY", "DESCRIPTION:Appointment in 30 minutes", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
    a.download = `schedulink-${b.token}.ics`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------ rating
  let rating = { booking: null, stars: 0 };
  function openRate(b) {
    rating = { booking: b, stars: 0 };
    $("#rateSub").textContent = `${b.business?.name || ""} · ${b.when}`;
    $("#rateComment").value = ""; $("#rateError").textContent = "";
    $("#rateStars").innerHTML = [1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" role="radio" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("");
    SL.open($("#rateModal"));
  }
  $("#rateStars").addEventListener("click", (e) => {
    const s = e.target.closest("[data-star]"); if (!s) return;
    rating.stars = +s.dataset.star;
    $$("#rateStars button").forEach((b) => b.classList.toggle("on", +b.dataset.star <= rating.stars));
  });
  $("#rateSubmit").addEventListener("click", async () => {
    if (!rating.stars) { $("#rateError").textContent = "Pick 1 to 5 stars."; return; }
    try {
      await api(`/api/bookings/${rating.booking.id}/review`, { body: { rating: rating.stars, comment: $("#rateComment").value } });
      SL.close($("#rateModal")); toast("Rating posted. Thanks."); loadBookings(true);
    } catch (e) { $("#rateError").textContent = e.message; }
  });

  // ------------------------------------------------------------ start
  (async function start() {
    try { await loadMe(); } catch (e) { /* signed out */ }
    const params = new URLSearchParams(location.search);
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem("sl_loc") || "null"); } catch (e) { /* ignore */ }
    if (saved && saved.lat != null) setLocation(saved.lat, saved.lng, saved.label);
    if (params.get("view") === "bookings") show("bookings");
    if (params.get("b")) openBusiness(+params.get("b"));
    setInterval(() => { if (S.me && !document.hidden) api("/api/me").then((m) => SL.setBadge(m.unread)).catch(() => {}); }, 30000);
  })();
})();
