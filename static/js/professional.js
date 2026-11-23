/* Professional dashboard: today's queue, schedule, team, insights, profile. */
(() => {
  const { $, $$, esc, api, toast, time12, dayLabel, addDays, parseDay, rupees, DOW, MON, CAT_ICON } = SL;
  const CATS = window.SL_CATEGORIES;
  const S = { view: "today", date: null, ov: null, weekFrom: null, insightDays: 14, timer: null, profile: null, pmap: null };
  const WD = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  // ------------------------------------------------------------ shell
  function show(view) {
    S.view = view;
    $$("#nav button").forEach((b) => b.classList.toggle("on", b.dataset.view === view));
    ["today", "schedule", "team", "insights", "profile"].forEach((v) => { $("#view-" + v).hidden = v !== view; });
    clearInterval(S.timer);
    ({ today: loadToday, schedule: loadSchedule, team: loadTeam, insights: loadInsights, profile: loadProfile })[view]();
    if (view === "today") S.timer = setInterval(() => { if (!document.hidden && !$(".modal.show")) loadToday(true); }, 15000);
    window.scrollTo(0, 0);
  }
  $("#nav").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) show(b.dataset.view); });
  $("#alertsBtn").addEventListener("click", SL.openAlerts);
  async function signOut() { await api("/api/auth/logout", { method: "POST" }); location.href = "/"; }
  $("#signOut").addEventListener("click", signOut);
  document.addEventListener("click", (e) => { const g = e.target.closest("[data-go]"); if (g) show(g.dataset.go); });

  // generic form modal
  let fmHandler = null, fmExtraHandler = null;
  function formModal({ title, sub = "", fields, submit = "Save", onSubmit, extra, onExtra }) {
    $("#fmTitle").textContent = title; $("#fmSub").textContent = sub; $("#fmError").textContent = "";
    $("#fmFields").innerHTML = fields.map((f) => {
      if (f.html) return f.html;
      const attrs = `id="fm_${f.name}" name="${f.name}" class="input" ${f.attrs || ""}`;
      const control = f.type === "select"
        ? `<select ${attrs}>${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(f.value ?? "") ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`
        : `<input ${attrs} type="${f.type || "text"}" value="${esc(f.value ?? "")}" placeholder="${esc(f.placeholder || "")}">`;
      return `<div class="field"><label for="fm_${f.name}">${esc(f.label)}</label>${control}</div>`;
    }).join("");
    $("#fmSubmit").textContent = submit;
    $("#fmExtra").hidden = !extra; $("#fmExtra").textContent = extra || "";
    fmHandler = onSubmit; fmExtraHandler = onExtra;
    SL.open($("#formModal"));
  }
  $("#fmForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(new FormData(e.target).entries());
    $("#fmSubmit").disabled = true;
    try { await fmHandler(values); SL.close($("#formModal")); }
    catch (err) { $("#fmError").textContent = err.message; }
    $("#fmSubmit").disabled = false;
  });
  $("#fmExtra").addEventListener("click", async () => {
    try { await fmExtraHandler(); SL.close($("#formModal")); } catch (err) { $("#fmError").textContent = err.message; }
  });

  function setShell(biz) {
    $("#bizName").textContent = biz.name; $("#bizCat").textContent = biz.category_label;
    $("#bizAvatar").textContent = biz.name[0].toUpperCase();
  }

  // ------------------------------------------------------------ today
  const NEXT = {
    pending: [["confirm", "Confirm", ""], ["reject", "Decline", "danger"]],
    confirmed: [["check_in", "Check in", "soft"], ["start", "Start", ""]],
    checked_in: [["start", "Start", ""]],
    in_service: [["complete", "Done", "amber"]],
  };
  const TONE = { pending: "amber", confirmed: "teal", checked_in: "teal", in_service: "dark", completed: "", cancelled: "red", rejected: "red", no_show: "red" };

  async function loadToday(quiet) {
    const box = $("#view-today");
    if (!quiet && !S.ov) box.innerHTML = `<div class="skeleton" style="height:70px"></div><div class="skeleton" style="height:240px"></div>`;
    let ov;
    try { ov = await api("/api/pro/overview" + (S.date ? `?date=${S.date}` : "")); }
    catch (e) { if (e.status === 401) location.href = "/?signin=professional"; else if (!quiet) toast(e.message, true); return; }
    S.ov = ov; S.date = ov.date;
    setShell(ov.business);
    $("#pendingDot").hidden = !ov.pending.length;
    const k = ov.kpis, isToday = ov.date === ov.today;
    const staffName = Object.fromEntries(ov.staff.map((s) => [s.id, s.name]));
    const d = parseDay(ov.date);
    const setupDone = ov.setup.location && ov.setup.schedule;

    let html = `<div class="head">
      <div><h1>${isToday ? "Today" : dayLabel(ov.date, ov.today)}</h1><p class="sub">${DOW[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}${isToday ? ` · <span class="mono">${time12(ov.now).text}</span> <span class="badge live teal">Live</span>` : ""}</p></div>
      <span class="spacer"></span>
      <div class="day-nav"><button data-day="-1" aria-label="Previous day" type="button">‹</button>${isToday ? "" : `<button class="btn sm ghost" style="width:auto;border-radius:999px;padding:0 14px" data-day="0" type="button">Today</button>`}<button data-day="1" aria-label="Next day" type="button">›</button></div>
      ${isToday ? `<button class="btn amber" id="walkinBtn" type="button">+ Add walk-in</button>` : ""}
    </div>`;

    if (!setupDone) {
      html += `<div class="setup"><h2>Two steps and customers nearby can book you</h2><div class="setup-steps">
        <button class="step ${ov.setup.location ? "done" : ""}" data-go="profile" type="button"><span class="box">${ov.setup.location ? "✓" : ""}</span><span><b>Put your business on the map</b><span>So people near you find you first.</span></span></button>
        <button class="step ${ov.setup.schedule ? "done" : ""}" data-go="schedule" type="button"><span class="box">${ov.setup.schedule ? "✓" : ""}</span><span><b>Open your schedule</b><span>Set hours once; slots fill in for weeks.</span></span></button>
        <button class="step ${ov.setup.prices ? "done" : ""}" data-go="team" type="button"><span class="box">${ov.setup.prices ? "✓" : ""}</span><span><b>Set your prices</b><span>Optional — shown before booking.</span></span></button>
      </div></div>`;
    }

    html += `<div class="kpis">
      <div class="kpi accent"><div class="n">${k.booked}</div><div class="l">Booked ${isToday ? "today" : "this day"}</div><div class="meter"><i style="width:${Math.min(100, k.utilization)}%"></i></div></div>
      <div class="kpi ${k.waiting ? "warn" : ""}"><div class="n">${k.waiting}</div><div class="l">Waiting now</div></div>
      <div class="kpi"><div class="n">${k.in_service}</div><div class="l">Being served</div></div>
      <div class="kpi"><div class="n">${k.done}</div><div class="l">Served${k.revenue ? " · " + rupees(k.revenue) : ""}</div></div>
      <div class="kpi"><div class="n">${k.seats_left}</div><div class="l">Seats still open</div></div>
      <div class="kpi"><div class="n">${k.utilization}%</div><div class="l">Of capacity filled</div></div>
    </div><div class="cols"><div>`;

    if (ov.pending.length) {
      html += `<div class="panel" style="border-color:#ecd7b1"><h2>Waiting for your answer <span class="count">${ov.pending.length}</span></h2>` + ov.pending.map((b) => `
        <div class="q-row"><div class="q-time">${time12(b.time).hm}<small>${dayLabel(b.date, ov.today)}</small></div>
        <div class="q-who"><b>${esc(b.customer_name)}</b><div class="sub">${esc(b.service_name)}${b.note ? " · “" + esc(b.note) + "”" : ""}</div></div>
        <div class="q-acts"><button class="btn sm" data-act="confirm" data-id="${b.id}" type="button">Confirm</button><button class="btn sm danger" data-act="reject" data-id="${b.id}" type="button">Decline</button></div></div>`).join("") + `</div>`;
    }

    const rows = ov.bookings.filter((b) => !["cancelled", "rejected"].includes(b.status) && !(b.status === "pending"));
    html += `<div class="panel"><h2>Queue <span class="count">${rows.length}</span><span class="spacer"></span>${ov.has_sample ? `<span class="badge amber">Includes sample data</span>` : ""}</h2>`;
    if (!rows.length) {
      html += `<div class="empty"><h3>${ov.slots.length ? "No bookings yet" : "No slots open for this day"}</h3><p>${ov.slots.length ? "Bookings and walk-ins appear here the moment they're made." : "Open your schedule so customers can book."}</p>${ov.slots.length ? "" : `<button class="btn" data-go="schedule" type="button">Open schedule</button>`}</div>`;
    } else {
      let nowShown = !isToday;
      rows.forEach((b) => {
        if (!nowShown && b.time > ov.now) { html += `<div class="now-line">NOW ${time12(ov.now).text}</div>`; nowShown = true; }
        const t = time12(b.time);
        const overdue = isToday && b.status === "confirmed" && b.time < ov.now;
        const acts = (NEXT[b.status] || []).map(([a, label, cls]) => `<button class="btn sm ${cls}" data-act="${a}" data-id="${b.id}" type="button">${label}</button>`).join("");
        const more = b.status === "confirmed" ? `<button class="more" data-act="no_show" data-id="${b.id}" type="button">No-show</button>`
          : ["completed", "no_show", "checked_in", "in_service"].includes(b.status) ? `<button class="more" data-act="undo" data-id="${b.id}" type="button">Undo</button>` : "";
        html += `<div class="q-row ${b.status === "in_service" ? "serving" : ""} ${["completed", "no_show"].includes(b.status) ? "done" : ""} ${overdue ? "past" : ""}">
          <div class="q-time">${t.hm}<small>${t.ap} · ${esc(b.token)}</small></div>
          <div class="q-who"><b>${esc(b.customer_name)}</b> <span class="badge ${TONE[b.status]}">${esc(b.status === "confirmed" && overdue ? "Late" : b.status_label)}</span>${b.source === "walkin" ? ` <span class="badge">Walk-in</span>` : ""}
            <div class="sub">${esc(b.service_name)}${staffName[b.staff_id] ? " · with " + esc(staffName[b.staff_id]) : ""}${b.customer_phone ? ` · <a href="tel:${esc(b.customer_phone)}">${esc(b.customer_phone)}</a>` : ""}${b.note ? " · “" + esc(b.note) + "”" : ""}</div></div>
          <div class="q-acts">${acts}${more}</div></div>`;
      });
    }
    html += `</div></div><div>`;

    const maxLoad = Math.max(1, ...ov.staff.map((s) => s.load));
    html += `<div class="panel"><h2>Team workload</h2>` + ov.staff.filter((s) => s.active).map((s) => `
      <div class="load-row"><span>${esc(s.name)}</span><b>${s.load}</b><div class="bar"><i style="width:${(100 * s.load) / maxLoad}%"></i></div></div>`).join("")
      + `<p class="small muted">New bookings go to whoever has the lightest day.</p></div>`;
    html += `<div class="panel"><h2>Coming up</h2>` + (ov.upcoming.length ? ov.upcoming.map((u) => `<div class="up-row"><span>${dayLabel(u.date, ov.today)}</span><b class="mono">${u.n} booked</b></div>`).join("") : `<p class="small muted">No bookings on later days yet.</p>`) + `</div>`;
    html += `<div class="panel"><h2>Your booking link</h2><p class="small muted" style="margin-bottom:10px">Share it on WhatsApp or print it at the counter.</p><div class="linkbox"><input class="input" id="shareLink" readonly value="${location.origin}/customer?b=${ov.business.id}"><button class="btn sm soft" id="copyLink" type="button">Copy</button></div></div>`;
    html += `</div></div>`;
    box.innerHTML = html;
  }
  $("#view-today").addEventListener("click", async (e) => {
    const dn = e.target.closest("[data-day]");
    if (dn) { S.date = dn.dataset.day === "0" ? null : addDays(S.date, +dn.dataset.day); S.ov = null; return loadToday(); }
    if (e.target.id === "copyLink") { try { await navigator.clipboard.writeText($("#shareLink").value); toast("Link copied"); } catch (err) { $("#shareLink").select(); } return; }
    if (e.target.id === "walkinBtn") return walkIn();
    const a = e.target.closest("[data-act]");
    if (a) {
      a.disabled = true;
      try { await api(`/api/pro/bookings/${a.dataset.id}/action`, { body: { action: a.dataset.act } }); await loadToday(true); }
      catch (err) { toast(err.message, true); a.disabled = false; }
    }
  });
  function walkIn() {
    formModal({
      title: "Add a walk-in", sub: "They take a seat in the current slot, so online customers see true availability.",
      fields: [
        { name: "name", label: "Name", placeholder: "Customer name" },
        { name: "phone", label: "Mobile (optional)", attrs: 'inputmode="tel"' },
        { name: "service_id", label: "Service", type: "select", options: [["", "Walk-in"]].concat(S.ov.services.map((s) => [s.id, `${s.name} · ${s.duration_min} min`])) },
      ],
      submit: "Add to queue",
      onSubmit: async (v) => { await api("/api/pro/walkin", { body: v }); toast("Added to the queue"); loadToday(true); },
    });
  }

  // ------------------------------------------------------------ schedule
  async function loadSchedule() {
    const box = $("#view-schedule");
    if (!box.dataset.built) {
      const teamSize = S.ov ? S.ov.staff.filter((s) => s.active).length : 1;
      const step = S.ov ? S.ov.business.slot_minutes : 30;
      box.innerHTML = `<div class="head"><div><h1>Schedule</h1><p class="sub">Set your hours once. Customers only see what's really free.</p></div></div>
      <div class="panel"><h2>Open slots in bulk</h2>
        <form id="genForm">
          <div class="field"><span class="label">Working days</span><div class="weekdays">${WD.map((w, i) => `<label><input type="checkbox" name="wd" value="${i}" ${i < 6 ? "checked" : ""}><span>${w}</span></label>`).join("")}</div></div>
          <div class="row">
            <div class="field"><label for="gStart">Opens</label><input class="input" type="time" id="gStart" value="10:00" required></div>
            <div class="field"><label for="gEnd">Closes</label><input class="input" type="time" id="gEnd" value="19:00" required></div>
            <div class="field"><label for="gB1">Break from</label><input class="input" type="time" id="gB1" value="13:30"></div>
            <div class="field"><label for="gB2">Break to</label><input class="input" type="time" id="gB2" value="14:30"></div>
          </div>
          <div class="row">
            <div class="field"><label for="gStep">Each slot lasts</label><select class="input" id="gStep">${[10, 15, 20, 30, 45, 60, 90].map((m) => `<option value="${m}" ${m === step ? "selected" : ""}>${m} minutes</option>`).join("")}</select></div>
            <div class="field"><label for="gCap">Customers per slot</label><input class="input" type="number" id="gCap" min="1" max="50" value="${Math.max(1, teamSize)}"></div>
            <div class="field"><label for="gDays">For the next</label><select class="input" id="gDays"><option value="7">7 days</option><option value="14" selected>14 days</option><option value="30">30 days</option></select></div>
          </div>
          <p class="small muted" style="margin-bottom:12px">Customers per slot usually equals how many of your team can serve at once. Slots you already have are left as they are.</p>
          <button class="btn" type="submit">Open these slots</button>
        </form></div>
      <div class="head" style="margin-top:26px"><div><h2 id="wkTitle">This week</h2><p class="sub small">Tap a slot to change how many it takes, block it, or remove it.</p></div><span class="spacer"></span>
        <div class="day-nav"><button data-wk="-7" aria-label="Previous week" type="button">‹</button><button data-wk="7" aria-label="Next week" type="button">›</button></div></div>
      <div class="week" id="week"></div>`;
      box.dataset.built = "1";
      $("#genForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const weekdays = $$('#genForm input[name="wd"]:checked').map((c) => +c.value);
        if (!weekdays.length) return toast("Pick at least one working day.", true);
        try {
          const r = await api("/api/pro/slots/generate", { body: { weekdays, start: $("#gStart").value, end: $("#gEnd").value, break_start: $("#gB1").value, break_end: $("#gB2").value, slot_minutes: +$("#gStep").value, capacity: +$("#gCap").value, days: +$("#gDays").value } });
          toast(r.added ? `Opened ${r.added} slots${r.skipped ? ` · ${r.skipped} already existed` : ""}` : "Those slots already exist — nothing to add.");
          loadWeek();
        } catch (err) { toast(err.message, true); }
      });
      box.addEventListener("click", (e) => {
        const wk = e.target.closest("[data-wk]"); if (wk) { S.weekFrom = addDays(S.weekFrom, +wk.dataset.wk); return loadWeek(); }
        const sl = e.target.closest("[data-slot]"); if (sl) return editSlot(S.week.find((s) => s.id === +sl.dataset.slot));
        const cd = e.target.closest("[data-clear]"); if (cd) return clearDay(cd.dataset.clear, cd);
      });
    }
    loadWeek();
  }
  async function loadWeek() {
    const d = await api("/api/pro/slots" + (S.weekFrom ? `?from=${S.weekFrom}` : ""));
    S.weekFrom = d.from; S.week = d.slots;
    const a = parseDay(d.from), b = parseDay(d.to);
    $("#wkTitle").textContent = `${a.getDate()} ${MON[a.getMonth()]} – ${b.getDate()} ${MON[b.getMonth()]}`;
    $("#week").innerHTML = [...Array(7)].map((_, i) => {
      const day = addDays(d.from, i), dt = parseDay(day);
      const slots = d.slots.filter((s) => s.date === day);
      return `<div class="wk-day ${day === d.today ? "today" : ""}"><header><b>${dt.getDate()}</b><span>${day === d.today ? "Today" : DOW[dt.getDay()]}</span>${slots.length && day >= d.today ? `<button class="more" data-clear="${day}" type="button">Close</button>` : ""}</header>` +
        (slots.length ? slots.map((s) => {
          const gone = day < d.today || (day === d.today && s.time <= d.now);
          const cls = s.blocked ? "blocked" : s.booked >= s.capacity ? "full" : s.booked ? "has" : "";
          return `<button class="wk-slot ${cls} ${gone ? "gone" : ""}" data-slot="${s.id}" type="button"><span>${time12(s.time).text}</span><em>${s.blocked ? "off" : `${s.booked}/${s.capacity}`}</em></button>`;
        }).join("") : `<div class="wk-empty">Closed</div>`) + `</div>`;
    }).join("");
  }
  function editSlot(s) {
    if (!s) return;
    let cap = s.capacity;
    formModal({
      title: `${dayLabel(s.date, S.ov?.today)} · ${time12(s.time).text}`,
      sub: `${s.booked} booked right now.`,
      fields: [{ html: `<span class="label">Customers this slot can take</span><div class="stepper"><button type="button" id="capDown" aria-label="Fewer">−</button><b id="capNum">${cap}</b><button type="button" id="capUp" aria-label="More">+</button></div>
        <label class="switch" style="margin-bottom:16px"><input type="checkbox" id="slotBlocked" ${s.blocked ? "checked" : ""}> Block this slot (nobody new can book it)</label>` }],
      submit: "Save slot",
      onSubmit: async () => { await api(`/api/pro/slots/${s.id}`, { body: { capacity: cap, blocked: $("#slotBlocked").checked } }); loadWeek(); },
      extra: s.booked ? null : "Remove",
      onExtra: async () => { await api(`/api/pro/slots/${s.id}`, { method: "DELETE" }); loadWeek(); },
    });
    $("#capDown").onclick = () => { cap = Math.max(Math.max(1, s.booked), cap - 1); $("#capNum").textContent = cap; };
    $("#capUp").onclick = () => { cap = Math.min(50, cap + 1); $("#capNum").textContent = cap; };
  }
  async function clearDay(day, btn) {
    if (btn.dataset.sure !== "1") { btn.dataset.sure = "1"; btn.textContent = "Tap again"; setTimeout(() => { btn.dataset.sure = ""; btn.textContent = "Close"; }, 3000); return; }
    try { const r = await api("/api/pro/slots/clear-day", { body: { date: day } }); toast(`Closed: ${r.removed} empty slots removed${r.blocked ? `, ${r.blocked} with bookings blocked` : ""}`); loadWeek(); }
    catch (e) { toast(e.message, true); }
  }

  // ------------------------------------------------------------ team & services
  async function loadTeam() {
    const box = $("#view-team");
    const [st, sv] = await Promise.all([api("/api/pro/staff"), api("/api/pro/services")]);
    S.staff = st.staff; S.services = sv.services;
    box.innerHTML = `<div class="head"><div><h1>Team &amp; services</h1><p class="sub">Schedulink spreads bookings across your team so nobody is overloaded while others wait.</p></div></div>
    <div class="two">
      <div class="panel"><h2>Team <span class="count">${st.staff.filter((s) => s.active).length} active</span><span class="spacer"></span><button class="btn sm" id="addStaff" type="button">+ Add person</button></h2>
        ${st.staff.map((s) => `<div class="item ${s.active ? "" : "off"}"><div class="avatar">${esc(s.name[0].toUpperCase())}</div><div class="grow"><b>${esc(s.name)}</b><span class="sub">${esc(s.role || "Team member")}${s.active ? "" : " · off duty"}</span></div><button class="btn sm ghost" data-staff="${s.id}" type="button">Edit</button></div>`).join("")}
      </div>
      <div class="panel"><h2>Services <span class="count">${sv.services.length}</span><span class="spacer"></span><button class="btn sm" id="addSvc" type="button">+ Add service</button></h2>
        ${sv.services.length ? sv.services.map((s) => `<div class="item"><div class="grow"><b>${esc(s.name)}</b><span class="sub">${s.duration_min} min · ${rupees(s.price)}</span></div><button class="btn sm ghost" data-svc="${s.id}" type="button">Edit</button></div>`).join("") : `<p class="muted small">Add what customers can book.</p>`}
      </div>
    </div>`;
  }
  $("#view-team").addEventListener("click", (e) => {
    const sid = e.target.closest("[data-staff]")?.dataset.staff, vid = e.target.closest("[data-svc]")?.dataset.svc;
    if (e.target.id === "addStaff" || sid) {
      const s = S.staff.find((x) => x.id === +sid) || {};
      formModal({
        title: s.id ? "Edit team member" : "Add a team member",
        fields: [{ name: "name", label: "Name", value: s.name }, { name: "role", label: "Role", value: s.role, placeholder: "Stylist, Doctor, Assistant…" },
          ...(s.id ? [{ name: "active", label: "Status", type: "select", value: s.active ? "1" : "0", options: [["1", "On duty — gets bookings"], ["0", "Off duty — no new bookings"]] }] : [])],
        onSubmit: async (v) => { await api("/api/pro/staff", { body: { id: s.id, name: v.name, role: v.role, active: v.active !== "0" } }); toast("Team updated"); loadTeam(); },
      });
    }
    if (e.target.id === "addSvc" || vid) {
      const s = S.services.find((x) => x.id === +vid) || {};
      formModal({
        title: s.id ? "Edit service" : "Add a service",
        fields: [{ name: "name", label: "Service name", value: s.name, placeholder: "Haircut, Consultation…" },
          { name: "duration_min", label: "Takes (minutes)", type: "number", value: s.duration_min || 30, attrs: 'min="5" max="480"' },
          { name: "price", label: "Price in ₹ (0 = price on visit)", type: "number", value: s.price || 0, attrs: 'min="0"' }],
        onSubmit: async (v) => { await api("/api/pro/services", { body: { id: s.id, ...v } }); toast("Services updated"); loadTeam(); },
        extra: s.id ? "Remove" : null,
        onExtra: async () => { await api("/api/pro/services", { body: { id: s.id, name: s.name, duration_min: s.duration_min, price: s.price, active: false } }); loadTeam(); },
      });
    }
  });

  // ------------------------------------------------------------ insights
  async function loadInsights() {
    const box = $("#view-insights");
    box.innerHTML = `<div class="skeleton" style="height:80px"></div><div class="skeleton" style="height:260px"></div>`;
    const d = await api(`/api/pro/insights?days=${S.insightDays}`);
    const t = d.totals, maxDay = Math.max(1, ...d.by_day.map((x) => x.served + x.no_show + x.cancelled + x.upcoming));
    const thin = t.completed < 20;
    let call = "";
    if (d.peak) {
      const quiet = d.utilization < 60;
      call = `<div class="insight-call"><h2>Your busiest hour is ${WD[d.peak.weekday]} around ${time12(SL.pad(d.peak.hour) + ":00").text}</h2>
        <p>${d.no_show_rate >= 8 ? `${d.no_show_rate}% of finished bookings were no-shows — turning off auto-confirm for peak hours or calling late customers recovers those seats. ` : ""}${quiet ? `Only ${d.utilization}% of your open seats were used — fewer slots in quiet hours frees your team without losing customers.` : `You're filling ${d.utilization}% of open seats — adding a person at the peak would let you take more.`}${d.waitlist ? ` ${d.waitlist} customer${d.waitlist > 1 ? "s are" : " is"} waiting for a slot to open.` : ""}</p></div>`;
    }
    const hm = {}; let hmMax = 1;
    d.heat.forEach((h) => { hm[h.weekday + "-" + h.hour] = h.n; hmMax = Math.max(hmMax, h.n); });
    const heat = d.hours.length ? `<div class="heat" style="grid-template-columns:38px repeat(${d.hours.length},1fr)"><span></span>${d.hours.map((h) => `<span class="hd">${h % 12 || 12}${h < 12 ? "a" : "p"}</span>`).join("")}` +
      WD.map((w, wi) => `<span>${w}</span>` + d.hours.map((h) => { const n = hm[wi + "-" + h] || 0; return `<span class="cell" ${n ? `data-n="${n}" title="${w} ${h}:00 — ${n} bookings" style="background:rgba(31,111,100,${0.12 + 0.88 * (n / hmMax)})"` : ""}></span>`; }).join("")).join("") + `</div>` : `<p class="muted small">Busy hours appear once you have bookings.</p>`;
    const maxStaff = Math.max(1, ...d.staff.map((s) => s.load));

    box.innerHTML = `<div class="head"><div><h1>Insights</h1><p class="sub">Last ${d.days} days. Use it to plan staff and hours instead of guessing.</p></div><span class="spacer"></span>
      <div class="seg">${[14, 30, 90].map((n) => `<button type="button" data-range="${n}" class="${n === S.insightDays ? "on" : ""}">${n} days</button>`).join("")}</div></div>
      ${d.has_sample ? `<div class="sample-bar"><b>Sample data is included.</b> These numbers mix in generated bookings so you can explore the screen. <span class="spacer"></span><button class="btn sm ghost" id="clearSample" type="button">Remove sample data</button></div>`
        : thin ? `<div class="sample-bar"><b>Not much history yet.</b> Load two weeks of clearly-labelled sample bookings to see how this screen works. <span class="spacer"></span><button class="btn sm amber" id="loadSample" type="button">Load sample data</button></div>` : ""}
      ${call}
      <div class="kpis">
        <div class="kpi accent"><div class="n">${t.completed}</div><div class="l">Customers served</div></div>
        <div class="kpi"><div class="n">${d.utilization}%</div><div class="l">Open seats filled</div><div class="meter"><i style="width:${d.utilization}%"></i></div></div>
        <div class="kpi ${d.no_show_rate >= 8 ? "warn" : ""}"><div class="n">${d.no_show_rate}%</div><div class="l">No-show rate</div></div>
        <div class="kpi"><div class="n">${d.repeat_rate}%</div><div class="l">Came back again</div></div>
        <div class="kpi"><div class="n">${t.bookings ? Math.round((100 * t.walkin) / t.bookings) : 0}%</div><div class="l">Walk-ins vs booked</div></div>
        <div class="kpi"><div class="n">${d.rating ? d.rating.avg : "–"}</div><div class="l">${d.rating ? `Rating · ${d.rating.count} review${d.rating.count > 1 ? "s" : ""}` : "No ratings yet"}</div></div>
        ${t.revenue ? `<div class="kpi"><div class="n">${rupees(t.revenue)}</div><div class="l">From served bookings</div></div>` : ""}
      </div>
      <div class="panel"><h2>Bookings per day</h2><div class="bars">${d.by_day.map((x, i) => {
        const total = x.served + x.no_show + x.cancelled + x.upcoming, dt = parseDay(x.date);
        const seg = (k) => (x[k] ? `<i class="${k}" style="height:${(170 * x[k]) / maxDay}px"></i>` : "");
        const showLbl = d.days <= 14 || i % Math.ceil(d.days / 12) === 0;
        return `<div class="col" data-tip="${dt.getDate()} ${MON[dt.getMonth()]}: ${x.served} served, ${x.no_show} no-show, ${x.cancelled} cancelled${x.upcoming ? `, ${x.upcoming} upcoming` : ""}"><div class="stack" style="${total ? "" : "height:2px"}">${seg("served")}${seg("upcoming")}${seg("no_show")}${seg("cancelled")}</div><div class="lbl">${showLbl ? dt.getDate() + (d.days <= 14 ? " " + DOW[dt.getDay()][0] : "") : "&nbsp;"}</div></div>`;
      }).join("")}</div>
      <div class="legend"><span><i style="background:var(--teal)"></i>Served</span><span><i style="background:#9ccabf"></i>Upcoming</span><span><i style="background:var(--amber)"></i>No-show</span><span><i style="background:#d7dde0"></i>Cancelled</span></div></div>
      <div class="two">
        <div class="panel"><h2>When customers come</h2>${heat}<p class="small muted" style="margin-top:10px">Darker means more bookings in that hour.</p></div>
        <div class="panel"><h2>Workload by person</h2>${d.staff.map((s) => `<div class="load-row"><span>${esc(s.name)}</span><b>${s.load}</b><div class="bar"><i style="width:${(100 * s.load) / maxStaff}%"></i></div></div>`).join("")}<p class="small muted">Even bars mean nobody is overloaded.</p></div>
      </div>`;
  }
  $("#view-insights").addEventListener("click", async (e) => {
    const r = e.target.closest("[data-range]"); if (r) { S.insightDays = +r.dataset.range; return loadInsights(); }
    if (e.target.id === "loadSample") { e.target.disabled = true; await api("/api/pro/sample-data", { method: "POST" }); toast("Sample bookings loaded — they're labelled as sample"); loadInsights(); }
    if (e.target.id === "clearSample") { await api("/api/pro/sample-data", { method: "DELETE" }); toast("Sample data removed"); loadInsights(); }
  });

  // ------------------------------------------------------------ profile
  async function loadProfile() {
    const box = $("#view-profile");
    const p = S.profile = await api("/api/pro/profile");
    setShell(p);
    box.innerHTML = `<div class="head"><div><h1>Business profile</h1><p class="sub">This is what customers see before they book.</p></div></div>
    <div class="two">
      <div class="panel"><h2>Details</h2><form id="profForm">
        <div class="field"><label for="pName">Business name</label><input class="input" id="pName" value="${esc(p.name)}" required></div>
        <div class="field"><label for="pCat">Type of business</label><select class="input" id="pCat">${Object.entries(CATS).map(([k, l]) => `<option value="${k}" ${k === p.category ? "selected" : ""}>${CAT_ICON[k]} ${esc(l)}</option>`).join("")}</select></div>
        <div class="field"><label for="pAbout">About (one or two lines)</label><textarea class="input" id="pAbout" rows="2" maxlength="500">${esc(p.about)}</textarea></div>
        <div class="field"><label for="pAddr">Address</label><input class="input" id="pAddr" value="${esc(p.address)}"></div>
        <div class="row"><div class="field"><label for="pCity">City</label><input class="input" id="pCity" value="${esc(p.city)}"></div><div class="field"><label for="pPin">PIN code</label><input class="input" id="pPin" inputmode="numeric" value="${esc(p.pincode)}"></div></div>
        <div class="field"><label for="pPhone">Phone customers can call</label><input class="input" id="pPhone" inputmode="tel" value="${esc(p.phone)}"></div>
        <label class="switch" style="margin:4px 0 18px"><input type="checkbox" id="pAuto" ${p.auto_approve ? "checked" : ""}> Confirm bookings instantly (turn off to approve each one)</label>
        <button class="btn" type="submit">Save profile</button>
      </form></div>
      <div>
        <div class="panel"><h2>Where customers find you ${p.lat != null ? `<span class="badge teal">On the map</span>` : `<span class="badge amber">Not set</span>`}</h2>
          <p class="small muted">Customers who turn on location see the nearest businesses first. Drag the pin to your door.</p>
          <div id="proMap"></div>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn sm amber" id="pLocate" type="button">Use my current location</button><button class="btn sm ghost" id="pFromAddr" type="button">Find from address</button><button class="btn sm" id="pSaveLoc" type="button" hidden>Save this spot</button></div>
        </div>
        <div class="panel"><h2>Claim your map listing ${p.osm_id ? `<span class="badge teal">Claimed</span>` : ""}</h2>
          <p class="small muted" id="claimHint">${p.osm_id ? `Your listing is linked.${p.demand ? ` ${p.demand} customer${p.demand > 1 ? "s" : ""} asked for online booking here before you joined — they've been told you're live.` : ""}` : "If your business is already on OpenStreetMap, link it so customers who asked for it are told you're bookable."}</p>
          <div id="claimList"></div>
          ${p.osm_id ? "" : `<button class="btn sm soft" id="findListing" type="button" ${p.lat == null ? "disabled" : ""}>Find my listing nearby</button>`}
        </div>
        <div class="panel"><h2>Account</h2><p class="small muted" style="margin-bottom:10px">Plan: <b>${esc(p.plan)}</b></p><button class="btn sm ghost" id="pAlerts" type="button">Alerts</button> <button class="btn sm danger" id="pSignOut" type="button">Sign out</button></div>
      </div>
    </div>`;
    const start = p.lat != null ? [p.lat, p.lng] : [22.9, 79.0];
    if (S.pmap) S.pmap.remove();
    S.pmap = L.map("proMap", { zoomControl: true }).setView(start, p.lat != null ? 16 : 4);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' }).addTo(S.pmap);
    S.pmarker = null;
    if (p.lat != null) placePin(p.lat, p.lng, false);
    S.pmap.on("click", (ev) => placePin(ev.latlng.lat, ev.latlng.lng, true));
  }
  function placePin(lat, lng, dirty) {
    if (!S.pmarker) {
      S.pmarker = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: "", html: '<div class="pin live"><span>⚑</span></div>', iconSize: [30, 30], iconAnchor: [15, 30] }) }).addTo(S.pmap);
      S.pmarker.on("dragend", () => { $("#pSaveLoc").hidden = false; });
    } else S.pmarker.setLatLng([lat, lng]);
    if (dirty) $("#pSaveLoc").hidden = false;
  }
  function profileBody(extra = {}) {
    return { name: $("#pName").value, category: $("#pCat").value, about: $("#pAbout").value, address: $("#pAddr").value, city: $("#pCity").value, pincode: $("#pPin").value, phone: $("#pPhone").value, auto_approve: $("#pAuto").checked, ...extra };
  }
  $("#view-profile").addEventListener("submit", async (e) => {
    if (e.target.id !== "profForm") return;
    e.preventDefault();
    try { await api("/api/pro/profile", { body: profileBody() }); toast("Profile saved"); loadProfile(); } catch (err) { toast(err.message, true); }
  });
  $("#view-profile").addEventListener("click", async (e) => {
    const id = e.target.id;
    if (id === "pSignOut") return signOut();
    if (id === "pAlerts") return SL.openAlerts();
    if (id === "pLocate") {
      e.target.disabled = true; e.target.textContent = "Finding you…";
      try {
        const pos = await SL.locate();
        S.pmap.setView([pos.lat, pos.lng], 17); placePin(pos.lat, pos.lng, true);
        const r = await SL.reverseGeocode(pos.lat, pos.lng);
        if (!$("#pCity").value) $("#pCity").value = r.city;
        if (!$("#pPin").value) $("#pPin").value = r.pincode;
        if (!$("#pAddr").value) $("#pAddr").value = r.address;
      } catch (err) { toast(err.message, true); }
      e.target.disabled = false; e.target.textContent = "Use my current location";
    }
    if (id === "pFromAddr") {
      const text = [$("#pAddr").value, $("#pCity").value, $("#pPin").value].filter(Boolean).join(", ");
      if (!text) return toast("Fill in your address or PIN code first.", true);
      try { const g = await SL.geocode(text); S.pmap.setView([g.lat, g.lng], 16); placePin(g.lat, g.lng, true); toast("Found it — drag the pin to your exact door, then save."); }
      catch (err) { toast(err.message, true); }
    }
    if (id === "pSaveLoc") {
      const ll = S.pmarker.getLatLng();
      try { await api("/api/pro/profile", { body: profileBody({ lat: ll.lat, lng: ll.lng }) }); toast("You're on the map. Customers nearby can find you now."); loadProfile(); }
      catch (err) { toast(err.message, true); }
    }
    if (id === "findListing") {
      const list = $("#claimList");
      list.innerHTML = `<div class="skeleton" style="height:54px"></div>`;
      try {
        const places = (await SL.nearbyPlaces(S.profile.lat, S.profile.lng, 600)).slice(0, 12);
        if (!places.length) { list.innerHTML = `<p class="small muted">No mapped businesses within 600 m of your pin. That's fine — you're still bookable.</p>`; return; }
        const dm = await api("/api/pro/demand", { body: { osm_ids: places.map((x) => x.osm_id) } });
        S.claimPlaces = places;
        list.innerHTML = places.filter((x) => !dm.claimed.includes(x.osm_id)).map((x) => `<div class="claim"><div class="grow"><b>${esc(x.name)}</b><span class="small muted">${esc(CATS[x.category])} · ${SL.km(x.distance_km)} from your pin${dm.demand[x.osm_id] ? ` · <b style="display:inline;color:var(--amber-deep)">${dm.demand[x.osm_id]} asked to book</b>` : ""}</span></div><button class="btn sm" data-claim="${esc(x.osm_id)}" type="button">This is us</button></div>`).join("");
      } catch (err) { list.innerHTML = `<p class="small muted">Map data didn't load. Try again in a moment.</p>`; }
    }
    const c = e.target.closest("[data-claim]");
    if (c) {
      const x = S.claimPlaces.find((q) => q.osm_id === c.dataset.claim);
      try {
        const r = await api("/api/pro/claim", { body: { osm_id: x.osm_id, lat: x.lat, lng: x.lng, address: x.address } });
        toast(r.customers_notified ? `Linked. ${r.customers_notified} waiting customer${r.customers_notified > 1 ? "s were" : " was"} told you're live.` : "Listing linked.");
        loadProfile();
      } catch (err) { toast(err.message, true); }
    }
  });

  // ------------------------------------------------------------ start
  show("today");
  setInterval(() => { if (!document.hidden) api("/api/me").then((m) => SL.setBadge(m.unread)).catch(() => {}); }, 30000);
  api("/api/me").then((m) => SL.setBadge(m.unread)).catch(() => {});
})();
