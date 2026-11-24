"""Schedulink — live local appointments.

Customers find nearby professionals and book a time; businesses run their day:
queue, schedule, team, and demand insights.
"""
import hashlib
import math
import os
import random
import re
import secrets
from datetime import datetime, timedelta
from functools import wraps
from zoneinfo import ZoneInfo

from flask import Flask, jsonify, redirect, render_template, request, session
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.security import check_password_hash, generate_password_hash

import db

# Static files live in public/static: Flask serves them at /static locally,
# and Vercel serves the public/ folder straight from its CDN at the same URLs.
app = Flask(__name__, static_folder="public/static", static_url_path="/static")
ON_VERCEL = bool(os.environ.get("VERCEL"))
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)


def _secret_key():
    """Use SECRET_KEY when set. Otherwise keep one in a local file so every
    worker process signs sessions with the same key."""
    key = os.environ.get("SECRET_KEY")
    if key:
        return key
    if db.DATABASE_URL:
        # Hosts with a read-only disk (Vercel): derive a stable key from the
        # database URL, which is itself a secret shared by every instance.
        return hashlib.sha256(("schedulink-session:" + db.DATABASE_URL).encode()).hexdigest()
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".secret_key")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as f:
            f.write(secrets.token_hex(32))
    except FileExistsError:
        pass
    except OSError:
        return secrets.token_hex(32)
    with open(path) as f:
        return f.read().strip()


app.secret_key = _secret_key()
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "1" if ON_VERCEL else "0") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    JSON_SORT_KEYS=False,
)

APP_TZ = ZoneInfo(os.environ.get("APP_TZ", "Asia/Kolkata"))
ADMIN_SECRET = os.environ.get("ADMIN_SECRET")

# key -> label. The customer page maps OpenStreetMap tags onto the same keys.
CATEGORIES = {
    "doctor": "Doctors & clinics",
    "dentist": "Dentists",
    "salon": "Salons & barbers",
    "spa": "Spa & massage",
    "vet": "Vets",
    "fitness": "Gyms & fitness",
    "lab": "Labs & physio",
    "legal": "Lawyers",
    "finance": "CAs & tax",
    "repair": "Vehicle repair",
    "other": "Other services",
}

# Starter services so a new business is bookable immediately. Prices start at 0
# ("price on visit") — the owner sets real prices.
STARTER_SERVICES = {
    "doctor": [("Consultation", 15), ("Follow-up visit", 10)],
    "dentist": [("Dental check-up", 20), ("Cleaning", 30)],
    "salon": [("Haircut", 30), ("Hair colour", 60), ("Beard trim", 15)],
    "spa": [("Massage", 60), ("Facial", 45)],
    "vet": [("Pet check-up", 20), ("Vaccination", 15)],
    "fitness": [("Trial session", 60), ("Personal training", 60)],
    "lab": [("Sample collection", 10), ("Physio session", 45)],
    "legal": [("Legal consultation", 30)],
    "finance": [("Tax consultation", 30)],
    "repair": [("Service check", 30), ("General service", 90)],
    "other": [("Appointment", 30)],
}

ACTIVE = ("pending", "confirmed", "checked_in", "in_service")
STATUS_LABEL = {
    "pending": "Waiting for approval",
    "confirmed": "Confirmed",
    "checked_in": "Checked in",
    "in_service": "In service",
    "completed": "Completed",
    "cancelled": "Cancelled",
    "rejected": "Declined",
    "no_show": "No-show",
}

db.init_db()


# ---------------------------------------------------------------- helpers

def now():
    fake = os.environ.get("FAKE_NOW")  # tests only, e.g. "2026-01-05 10:40"
    if fake:
        return datetime.strptime(fake, "%Y-%m-%d %H:%M").replace(tzinfo=APP_TZ)
    return datetime.now(APP_TZ)


def stamp():
    return now().strftime("%Y-%m-%d %H:%M:%S")


def today():
    return now().strftime("%Y-%m-%d")


def hhmm_now():
    return now().strftime("%H:%M")


def err(message, code=400):
    return jsonify({"error": message}), code


def body():
    return request.get_json(silent=True) or {}


def valid_date(s):
    try:
        return datetime.strptime(s or "", "%Y-%m-%d").strftime("%Y-%m-%d")
    except ValueError:
        return None


def valid_time(s):
    try:
        return datetime.strptime(s or "", "%H:%M").strftime("%H:%M")
    except ValueError:
        return None


def to_min(t):
    h, m = t.split(":")
    return int(h) * 60 + int(m)


def from_min(m):
    m = max(0, min(int(m), 23 * 60 + 59))
    return f"{m // 60:02d}:{m % 60:02d}"


def clean_phone(p):
    digits = re.sub(r"\D", "", p or "")
    return digits[-10:] if len(digits) >= 10 else ""


def to_float(v):
    try:
        f = float(v)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None


def to_int(v, default=0, lo=None, hi=None):
    try:
        n = int(v)
    except (TypeError, ValueError):
        n = default
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def km_between(lat1, lng1, lat2, lng2):
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def current_account():
    uid = session.get("uid")
    if not uid:
        return None
    return db.query("SELECT id, role, name, phone, email, access_type FROM accounts WHERE id=?", (uid,), one=True)


def login_required(role=None):
    def deco(fn):
        @wraps(fn)
        def wrapper(*a, **kw):
            acc = current_account()
            if not acc:
                return err("Sign in to continue.", 401)
            if role and acc["role"] != role:
                return err("This action needs a %s account." % role, 403)
            request.account = acc
            return fn(*a, **kw)
        return wrapper
    return deco


def my_business():
    return db.query("SELECT * FROM businesses WHERE owner_id=? ORDER BY id LIMIT 1", (request.account["id"],), one=True)


def notify(account_id, title, text, booking_id=None):
    if not account_id:
        return
    db.execute(
        "INSERT INTO notifications (account_id, title, body, booking_id, created_at) VALUES (?,?,?,?,?)",
        (account_id, title, text, booking_id, stamp()),
    )


def pretty_when(d, t):
    dt = datetime.strptime(f"{d} {t}", "%Y-%m-%d %H:%M")
    return dt.strftime("%a %d %b, %I:%M %p").replace(" 0", " ")


def slot_state(s):
    if s["blocked"]:
        return "blocked"
    if s["booked"] >= s["capacity"]:
        return "full"
    if s["booked"] >= s["capacity"] * 0.7:
        return "filling"
    return "open"


def public_business(b):
    return {
        "id": b["id"], "name": b["name"], "owner_name": b["owner_name"], "category": b["category"],
        "category_label": CATEGORIES.get(b["category"], "Other services"),
        "about": b["about"] or "", "address": b["address"] or "", "city": b["city"] or "",
        "pincode": b["pincode"] or "", "phone": b["phone"] or "", "lat": b["lat"], "lng": b["lng"],
        "osm_id": b["osm_id"], "auto_approve": bool(b["auto_approve"]), "slot_minutes": b["slot_minutes"],
    }


def assign_staff(business_id, d, t):
    """Pick the least-loaded active staff member for this day, avoiding anyone
    already booked at the same time. This is what keeps workload balanced."""
    staff = db.query("SELECT id FROM staff WHERE business_id=? AND active=1 ORDER BY id", (business_id,))
    if not staff:
        return None
    marks = ",".join("?" * len(ACTIVE))
    rows = db.query(
        f"SELECT staff_id, time FROM bookings WHERE business_id=? AND date=? AND staff_id IS NOT NULL "
        f"AND status IN ({marks})", (business_id, d, *ACTIVE))
    load = {s["id"]: 0 for s in staff}
    busy = set()
    for r in rows:
        if r["staff_id"] in load:
            load[r["staff_id"]] += 1
            if r["time"] == t:
                busy.add(r["staff_id"])
    free = [s for s in load if s not in busy] or list(load)
    return min(free, key=lambda s: (load[s], s))


def release_seat(business_id, d, t):
    db.execute("UPDATE slots SET booked = booked - 1 WHERE business_id=? AND date=? AND time=? AND booked > 0",
               (business_id, d, t))


def tell_waitlist(business, d):
    if d < today():
        return
    rows = db.query("SELECT customer_id FROM waitlist WHERE business_id=? AND date=?", (business["id"], d))
    for r in rows:
        notify(r["customer_id"], "A slot opened up",
               f"{business['name']} has a free slot on {datetime.strptime(d, '%Y-%m-%d').strftime('%a %d %b')}. Book it before it goes.")
    if rows:
        db.execute("DELETE FROM waitlist WHERE business_id=? AND date=?", (business["id"], d))


def queue_info(b, staff_count):
    """Live position for a customer's booking today."""
    if b["date"] != today() or b["status"] not in ("confirmed", "checked_in"):
        return None
    rows = db.query(
        "SELECT id, time, status, duration_min FROM bookings WHERE business_id=? AND date=? "
        "AND status IN ('confirmed','checked_in','in_service')", (b["business_id"], b["date"]))
    ahead = [r for r in rows if r["id"] != b["id"] and (r["time"], r["id"]) < (b["time"], b["id"])]
    serving = sum(1 for r in rows if r["status"] == "in_service")
    staff_count = max(1, staff_count)
    work_min = sum(r["duration_min"] or 15 for r in ahead)
    now_min = to_min(hhmm_now())
    eta_min = max(to_min(b["time"]), now_min + math.ceil(work_min / staff_count))
    return {
        "ahead": len(ahead),
        "now_serving": serving,
        "eta": from_min(eta_min),
        "delay_min": max(0, eta_min - to_min(b["time"])),
        "minutes_away": max(0, eta_min - now_min),
    }


def booking_json(b, business=None, with_queue=False, staff_count=1):
    out = {
        "id": b["id"], "business_id": b["business_id"], "customer_name": b["customer_name"],
        "customer_phone": b["customer_phone"] or "", "service_name": b["service_name"] or "Appointment",
        "price": b["price"], "duration_min": b["duration_min"], "staff_id": b["staff_id"],
        "date": b["date"], "time": b["time"], "status": b["status"],
        "status_label": STATUS_LABEL.get(b["status"], b["status"]), "source": b["source"],
        "note": b["note"] or "", "is_sample": bool(b["is_sample"]), "token": f"S{b['id']:04d}",
        "when": pretty_when(b["date"], b["time"]),
    }
    if business:
        out["business"] = public_business(business)
    if with_queue:
        out["queue"] = queue_info(b, staff_count)
    return out


# ---------------------------------------------------------------- pages

@app.route("/")
def home():
    return render_template("index.html", categories=CATEGORIES)


@app.route("/customer")
def customer_page():
    return render_template("customer.html", categories=CATEGORIES)


@app.route("/professional")
def professional_page():
    acc = current_account()
    if not acc or acc["role"] != "professional":
        return redirect("/?signin=professional")
    return render_template("professional.html", categories=CATEGORIES)


@app.route("/admin")
def admin_page():
    return render_template("admin.html")


@app.route("/healthz")
def healthz():
    db.query("SELECT 1 AS ok")
    return jsonify({"ok": True, "database": "postgresql" if db.IS_PG else "sqlite"})


# ---------------------------------------------------------------- auth

@app.route("/api/auth/register", methods=["POST"])
def register():
    d = body()
    role = d.get("role")
    name = (d.get("name") or "").strip()
    password = d.get("password") or ""
    if role not in ("customer", "professional"):
        return err("Choose customer or professional.")
    if len(name) < 2:
        return err("Enter your name.")
    if len(password) < 6:
        return err("Use a password of at least 6 characters.")
    phone = clean_phone(d.get("phone"))
    email = (d.get("email") or "").strip().lower()
    if role == "customer":
        if not phone:
            return err("Enter a 10-digit mobile number.")
        login = phone
    else:
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
            return err("Enter a valid email address.")
        if not (d.get("business_name") or "").strip():
            return err("Enter your business name.")
        login = email
    try:
        uid = db.insert(
            "INSERT INTO accounts (role, name, login, phone, email, password_hash, created_at) VALUES (?,?,?,?,?,?,?)",
            (role, name, login, phone or None, email or None, generate_password_hash(password), stamp()))
    except db.IntegrityError:
        return err("An account with this %s already exists. Sign in instead." %
                   ("mobile number" if role == "customer" else "email"), 409)
    if role == "professional":
        category = d.get("category") if d.get("category") in CATEGORIES else "other"
        bid = db.insert(
            "INSERT INTO businesses (owner_id, owner_name, name, category, address, city, pincode, phone, lat, lng, osm_id, created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (uid, name, d["business_name"].strip(), category, (d.get("address") or "").strip(),
             (d.get("city") or "").strip(), (d.get("pincode") or "").strip(), phone or None,
             to_float(d.get("lat")), to_float(d.get("lng")), d.get("osm_id") or None, stamp()))
        db.insert("INSERT INTO staff (business_id, name, role) VALUES (?,?,?)", (bid, name, "Owner"))
        db.executemany("INSERT INTO services (business_id, name, duration_min, price) VALUES (?,?,?,0)",
                       [(bid, n, m) for n, m in STARTER_SERVICES[category]])
        if d.get("osm_id"):
            _welcome_leads(bid, d["osm_id"], d["business_name"].strip())
    session.permanent = True
    session["uid"] = uid
    return jsonify({"account": {"id": uid, "role": role, "name": name}})


@app.route("/api/auth/login", methods=["POST"])
def login():
    d = body()
    role = d.get("role")
    raw = (d.get("login") or "").strip()
    login_id = raw.lower() if "@" in raw else clean_phone(raw)
    acc = db.query("SELECT * FROM accounts WHERE role=? AND login=?", (role, login_id), one=True)
    if not acc or not check_password_hash(acc["password_hash"], d.get("password") or ""):
        return err("Those details don't match an account. Check them and try again.", 401)
    session.permanent = True
    session["uid"] = acc["id"]
    return jsonify({"account": {"id": acc["id"], "role": acc["role"], "name": acc["name"]}})


@app.route("/api/auth/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/me")
def me():
    acc = current_account()
    if not acc:
        return jsonify({"account": None})
    unread = db.query("SELECT COUNT(*) AS n FROM notifications WHERE account_id=? AND is_read=0", (acc["id"],), one=True)
    return jsonify({"account": acc, "unread": unread["n"]})


# ---------------------------------------------------------------- discovery

def _open_slots_by_business(ids):
    """Next free slot and seats left today for each business, in one query."""
    if not ids:
        return {}
    t, n = today(), hhmm_now()
    horizon = (now() + timedelta(days=7)).strftime("%Y-%m-%d")
    marks = ",".join("?" * len(ids))
    rows = db.query(
        f"SELECT business_id, date, time, capacity, booked FROM slots WHERE business_id IN ({marks}) "
        f"AND blocked=0 AND booked < capacity AND date >= ? AND date <= ? ORDER BY date, time",
        (*ids, t, horizon))
    out = {}
    for r in rows:
        if r["date"] == t and r["time"] <= n:
            continue
        o = out.setdefault(r["business_id"], {"next": None, "seats_today": 0})
        if o["next"] is None:
            o["next"] = {"date": r["date"], "time": r["time"]}
        if r["date"] == t:
            o["seats_today"] += r["capacity"] - r["booked"]
    return out


def _ratings(ids):
    if not ids:
        return {}
    marks = ",".join("?" * len(ids))
    rows = db.query(f"SELECT business_id, COUNT(*) AS n, AVG(rating) AS avg FROM reviews WHERE business_id IN ({marks}) "
                    f"GROUP BY business_id", ids)
    return {r["business_id"]: {"count": r["n"], "avg": round(float(r["avg"]), 1)} for r in rows}


@app.route("/api/businesses")
def list_businesses():
    lat, lng = to_float(request.args.get("lat")), to_float(request.args.get("lng"))
    radius = to_float(request.args.get("radius")) or 25.0
    rows = db.query("SELECT * FROM businesses ORDER BY id")
    items = []
    for b in rows:
        dist = None
        if lat is not None and lng is not None and b["lat"] is not None and b["lng"] is not None:
            dist = km_between(lat, lng, b["lat"], b["lng"])
            if dist > radius:
                continue
        item = public_business(b)
        item["distance_km"] = round(dist, 2) if dist is not None else None
        items.append(item)
    ids = [i["id"] for i in items]
    slots, ratings = _open_slots_by_business(ids), _ratings(ids)
    for i in items:
        s = slots.get(i["id"], {})
        i["next_slot"] = s.get("next")
        i["seats_today"] = s.get("seats_today", 0)
        i["rating"] = ratings.get(i["id"])
    items.sort(key=lambda i: (i["distance_km"] is None, i["distance_km"] or 0, i["name"]))
    return jsonify({"businesses": items, "today": today()})


@app.route("/api/businesses/<int:bid>")
def business_detail(bid):
    b = db.query("SELECT * FROM businesses WHERE id=?", (bid,), one=True)
    if not b:
        return err("This business is no longer listed.", 404)
    out = public_business(b)
    out["services"] = db.query(
        "SELECT id, name, duration_min, price FROM services WHERE business_id=? AND active=1 ORDER BY id", (bid,))
    out["staff"] = db.query("SELECT id, name, role FROM staff WHERE business_id=? AND active=1 ORDER BY id", (bid,))
    out["rating"] = _ratings([bid]).get(bid)
    out["reviews"] = db.query(
        "SELECT customer_name, rating, comment, created_at FROM reviews WHERE business_id=? ORDER BY id DESC LIMIT 5", (bid,))
    days = db.query(
        "SELECT date, SUM(capacity - booked) AS free FROM slots WHERE business_id=? AND blocked=0 AND booked < capacity "
        "AND date >= ? GROUP BY date ORDER BY date LIMIT 14", (bid, today()))
    out["open_days"] = {r["date"]: int(r["free"]) for r in days}
    out["today"] = today()
    return jsonify(out)


@app.route("/api/businesses/<int:bid>/slots")
def business_slots(bid):
    d = valid_date(request.args.get("date")) or today()
    rows = db.query("SELECT id, time, capacity, booked, blocked FROM slots WHERE business_id=? AND date=? ORDER BY time",
                    (bid, d))
    cutoff = hhmm_now() if d == today() else ""
    out = []
    for s in rows:
        if s["blocked"] or d < today() or s["time"] <= cutoff:
            continue
        out.append({"time": s["time"], "left": max(0, s["capacity"] - s["booked"]), "state": slot_state(s)})
    return jsonify({"date": d, "slots": out})


# ---------------------------------------------------------------- customer bookings

def _take_seat(bid, d, t):
    return db.execute(
        "UPDATE slots SET booked = booked + 1 WHERE business_id=? AND date=? AND time=? AND blocked=0 AND booked < capacity",
        (bid, d, t)) == 1


@app.route("/api/bookings", methods=["POST"])
@login_required("customer")
def create_booking():
    d = body()
    acc = request.account
    bid = to_int(d.get("business_id"))
    day, t = valid_date(d.get("date")), valid_time(d.get("time"))
    b = db.query("SELECT * FROM businesses WHERE id=?", (bid,), one=True)
    if not b or not day or not t:
        return err("Pick a business, a day and a time.")
    if day < today() or (day == today() and t <= hhmm_now()):
        return err("That time has passed. Pick a later slot.")
    marks = ",".join("?" * len(ACTIVE))
    dup = db.query(
        f"SELECT id FROM bookings WHERE customer_id=? AND business_id=? AND date=? AND time=? AND status IN ({marks})",
        (acc["id"], bid, day, t, *ACTIVE), one=True)
    if dup:
        return err("You already have this slot booked.")
    svc = None
    if d.get("service_id"):
        svc = db.query("SELECT * FROM services WHERE id=? AND business_id=? AND active=1", (to_int(d["service_id"]), bid), one=True)
    if not _take_seat(bid, day, t):
        return err("That slot just filled up. Pick another time.", 409)
    status = "confirmed" if b["auto_approve"] else "pending"
    new_id = db.insert(
        "INSERT INTO bookings (business_id, customer_id, customer_name, customer_phone, service_id, service_name, price, "
        "duration_min, staff_id, date, time, status, source, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (bid, acc["id"], acc["name"], acc["phone"], svc["id"] if svc else None, svc["name"] if svc else "Appointment",
         svc["price"] if svc else 0, svc["duration_min"] if svc else b["slot_minutes"], assign_staff(bid, day, t),
         day, t, status, "online", (d.get("note") or "").strip()[:300], stamp()))
    when = pretty_when(day, t)
    notify(b["owner_id"], "New booking" if status == "confirmed" else "New booking request",
           f"{acc['name']} booked {svc['name'] if svc else 'an appointment'} for {when}.", new_id)
    notify(acc["id"], "Booking confirmed" if status == "confirmed" else "Request sent",
           f"{b['name']} — {when}." + ("" if status == "confirmed" else " You'll be told as soon as they confirm."), new_id)
    db.execute("DELETE FROM waitlist WHERE business_id=? AND customer_id=? AND date=?", (bid, acc["id"], day))
    row = db.query("SELECT * FROM bookings WHERE id=?", (new_id,), one=True)
    return jsonify({"booking": booking_json(row, b)})


@app.route("/api/my/bookings")
@login_required("customer")
def my_bookings():
    rows = db.query("SELECT * FROM bookings WHERE customer_id=? ORDER BY date DESC, time DESC LIMIT 100",
                    (request.account["id"],))
    biz_ids = sorted({r["business_id"] for r in rows})
    biz, staff_count, reviewed = {}, {}, set()
    if biz_ids:
        marks = ",".join("?" * len(biz_ids))
        biz = {b["id"]: b for b in db.query(f"SELECT * FROM businesses WHERE id IN ({marks})", biz_ids)}
        staff_count = {r["business_id"]: r["n"] for r in db.query(
            f"SELECT business_id, COUNT(*) AS n FROM staff WHERE active=1 AND business_id IN ({marks}) GROUP BY business_id", biz_ids)}
        reviewed = {r["booking_id"] for r in db.query("SELECT booking_id FROM reviews WHERE customer_id=?", (request.account["id"],))}
    out = []
    for r in rows:
        j = booking_json(r, biz.get(r["business_id"]), with_queue=True, staff_count=staff_count.get(r["business_id"], 1))
        j["reviewed"] = r["id"] in reviewed
        out.append(j)
    return jsonify({"bookings": out, "today": today(), "now": hhmm_now()})


def _own_booking(booking_id):
    return db.query("SELECT * FROM bookings WHERE id=? AND customer_id=?", (booking_id, request.account["id"]), one=True)


@app.route("/api/bookings/<int:booking_id>/cancel", methods=["POST"])
@login_required("customer")
def cancel_booking(booking_id):
    b = _own_booking(booking_id)
    if not b or b["status"] not in ("pending", "confirmed"):
        return err("This booking can't be cancelled any more.")
    db.execute("UPDATE bookings SET status='cancelled' WHERE id=?", (booking_id,))
    release_seat(b["business_id"], b["date"], b["time"])
    biz = db.query("SELECT * FROM businesses WHERE id=?", (b["business_id"],), one=True)
    notify(biz["owner_id"], "Booking cancelled", f"{b['customer_name']} cancelled {pretty_when(b['date'], b['time'])}. The seat is free again.", booking_id)
    tell_waitlist(biz, b["date"])
    return jsonify({"ok": True})


@app.route("/api/bookings/<int:booking_id>/reschedule", methods=["POST"])
@login_required("customer")
def reschedule_booking(booking_id):
    d = body()
    b = _own_booking(booking_id)
    day, t = valid_date(d.get("date")), valid_time(d.get("time"))
    if not b or b["status"] not in ("pending", "confirmed"):
        return err("This booking can't be moved any more.")
    if not day or not t or day < today() or (day == today() and t <= hhmm_now()):
        return err("Pick a time that's still ahead.")
    if (day, t) == (b["date"], b["time"]):
        return err("That's the time you already have.")
    if not _take_seat(b["business_id"], day, t):
        return err("That slot just filled up. Pick another time.", 409)
    release_seat(b["business_id"], b["date"], b["time"])
    biz = db.query("SELECT * FROM businesses WHERE id=?", (b["business_id"],), one=True)
    status = "confirmed" if biz["auto_approve"] else "pending"
    db.execute("UPDATE bookings SET date=?, time=?, status=?, staff_id=? WHERE id=?",
               (day, t, status, assign_staff(b["business_id"], day, t), booking_id))
    notify(biz["owner_id"], "Booking moved",
           f"{b['customer_name']} moved from {pretty_when(b['date'], b['time'])} to {pretty_when(day, t)}.", booking_id)
    tell_waitlist(biz, b["date"])
    row = db.query("SELECT * FROM bookings WHERE id=?", (booking_id,), one=True)
    return jsonify({"booking": booking_json(row, biz)})


@app.route("/api/bookings/<int:booking_id>/review", methods=["POST"])
@login_required("customer")
def review_booking(booking_id):
    d = body()
    b = _own_booking(booking_id)
    rating = to_int(d.get("rating"))
    if not b or b["status"] != "completed":
        return err("You can rate a visit once it's completed.")
    if rating < 1 or rating > 5:
        return err("Pick 1 to 5 stars.")
    try:
        db.insert("INSERT INTO reviews (business_id, booking_id, customer_id, customer_name, rating, comment, created_at) "
                  "VALUES (?,?,?,?,?,?,?)",
                  (b["business_id"], booking_id, request.account["id"], request.account["name"].split(" ")[0],
                   rating, (d.get("comment") or "").strip()[:400], stamp()))
    except db.IntegrityError:
        return err("You've already rated this visit.")
    return jsonify({"ok": True})


@app.route("/api/waitlist", methods=["POST"])
@login_required("customer")
def join_waitlist():
    d = body()
    day = valid_date(d.get("date"))
    bid = to_int(d.get("business_id"))
    if not day or not db.query("SELECT id FROM businesses WHERE id=?", (bid,), one=True):
        return err("Pick a business and a day.")
    try:
        db.insert("INSERT INTO waitlist (business_id, customer_id, date, created_at) VALUES (?,?,?,?)",
                  (bid, request.account["id"], day, stamp()))
    except db.IntegrityError:
        pass
    return jsonify({"ok": True})


@app.route("/api/leads", methods=["POST"])
@login_required("customer")
def add_lead():
    """A customer asks for a place that isn't on Schedulink yet. This is the
    demand signal a business sees when it claims its listing."""
    d = body()
    osm_id = (d.get("osm_id") or "").strip()[:60]
    if not osm_id:
        return err("Missing place.")
    try:
        db.insert("INSERT INTO leads (osm_id, place_name, category, lat, lng, customer_id, created_at) VALUES (?,?,?,?,?,?,?)",
                  (osm_id, (d.get("name") or "")[:120], d.get("category") if d.get("category") in CATEGORIES else "other",
                   to_float(d.get("lat")), to_float(d.get("lng")), request.account["id"], stamp()))
    except db.IntegrityError:
        pass
    n = db.query("SELECT COUNT(*) AS n FROM leads WHERE osm_id=?", (osm_id,), one=True)["n"]
    return jsonify({"ok": True, "requests": n})


@app.route("/api/leads/mine")
@login_required("customer")
def my_leads():
    rows = db.query("SELECT osm_id FROM leads WHERE customer_id=?", (request.account["id"],))
    return jsonify({"osm_ids": [r["osm_id"] for r in rows]})


@app.route("/api/notifications")
@login_required()
def notifications():
    rows = db.query("SELECT id, title, body, booking_id, is_read, created_at FROM notifications WHERE account_id=? "
                    "ORDER BY id DESC LIMIT 40", (request.account["id"],))
    return jsonify({"notifications": rows, "unread": sum(1 for r in rows if not r["is_read"])})


@app.route("/api/notifications/read", methods=["POST"])
@login_required()
def notifications_read():
    db.execute("UPDATE notifications SET is_read=1 WHERE account_id=?", (request.account["id"],))
    return jsonify({"ok": True})


# ---------------------------------------------------------------- professional

def _welcome_leads(business_id, osm_id, business_name):
    rows = db.query("SELECT customer_id FROM leads WHERE osm_id=?", (osm_id,))
    for r in rows:
        notify(r["customer_id"], "Now bookable", f"{business_name} joined Schedulink. You can book a slot now.")
    return len(rows)


def _staff_list(bid):
    return db.query("SELECT id, name, role, active FROM staff WHERE business_id=? ORDER BY active DESC, id", (bid,))


@app.route("/api/pro/overview")
@login_required("professional")
def pro_overview():
    biz = my_business()
    d = valid_date(request.args.get("date")) or today()
    rows = db.query("SELECT * FROM bookings WHERE business_id=? AND date=? ORDER BY time, id", (biz["id"], d))
    slots = db.query("SELECT id, time, capacity, booked, blocked FROM slots WHERE business_id=? AND date=? ORDER BY time",
                     (biz["id"], d))
    staff = _staff_list(biz["id"])
    count = lambda *st: sum(1 for r in rows if r["status"] in st)
    cap = sum(s["capacity"] for s in slots if not s["blocked"])
    used = sum(min(s["booked"], s["capacity"]) for s in slots if not s["blocked"])
    load = {}
    for r in rows:
        if r["staff_id"] and r["status"] in ACTIVE + ("completed",):
            load[r["staff_id"]] = load.get(r["staff_id"], 0) + 1
    pending_all = db.query(
        "SELECT * FROM bookings WHERE business_id=? AND status='pending' AND date >= ? ORDER BY date, time", (biz["id"], today()))
    upcoming = db.query(
        "SELECT date, COUNT(*) AS n FROM bookings WHERE business_id=? AND date > ? AND status IN ('pending','confirmed') "
        "GROUP BY date ORDER BY date LIMIT 7", (biz["id"], today()))
    return jsonify({
        "business": public_business(biz), "date": d, "today": today(), "now": hhmm_now(),
        "bookings": [booking_json(r) for r in rows],
        "pending": [booking_json(r) for r in pending_all],
        "slots": [{**s, "state": slot_state(s)} for s in slots],
        "staff": [{**s, "load": load.get(s["id"], 0)} for s in staff],
        "services": db.query("SELECT id, name, duration_min, price FROM services WHERE business_id=? AND active=1 ORDER BY id", (biz["id"],)),
        "upcoming": upcoming,
        "kpis": {
            "booked": count(*ACTIVE, "completed", "no_show"),
            "waiting": count("checked_in"), "in_service": count("in_service"), "done": count("completed"),
            "pending": count("pending"), "no_show": count("no_show"),
            "seats_left": max(0, cap - used), "capacity": cap,
            "utilization": round(100 * used / cap) if cap else 0,
            "revenue": sum(r["price"] for r in rows if r["status"] == "completed"),
        },
        "setup": {
            "location": biz["lat"] is not None,
            "schedule": bool(db.query("SELECT id FROM slots WHERE business_id=? AND date >= ? LIMIT 1", (biz["id"], today()), one=True)),
            "prices": bool(db.query("SELECT id FROM services WHERE business_id=? AND active=1 AND price > 0 LIMIT 1", (biz["id"],), one=True)),
        },
    })


TRANSITIONS = {
    "confirm": (("pending",), "confirmed"),
    "reject": (("pending",), "rejected"),
    "check_in": (("confirmed",), "checked_in"),
    "start": (("confirmed", "checked_in"), "in_service"),
    "complete": (("in_service", "checked_in", "confirmed"), "completed"),
    "no_show": (("confirmed", "pending"), "no_show"),
    "cancel": (("pending", "confirmed", "checked_in"), "cancelled"),
    "undo": (("checked_in", "in_service", "no_show", "completed"), "confirmed"),
}


@app.route("/api/pro/bookings/<int:booking_id>/action", methods=["POST"])
@login_required("professional")
def pro_booking_action(booking_id):
    biz = my_business()
    action = body().get("action")
    b = db.query("SELECT * FROM bookings WHERE id=? AND business_id=?", (booking_id, biz["id"]), one=True)
    if not b or action not in TRANSITIONS:
        return err("Booking not found.", 404)
    allowed, new_status = TRANSITIONS[action]
    if b["status"] not in allowed:
        return err("This booking is already %s." % STATUS_LABEL.get(b["status"], b["status"]).lower())
    extra, args = "", []
    if action == "check_in":
        extra, args = ", checked_in_at=?", [stamp()]
    elif action == "start":
        extra, args = ", started_at=?", [stamp()]
    elif action == "complete":
        extra, args = ", completed_at=?", [stamp()]
    db.execute(f"UPDATE bookings SET status=?{extra} WHERE id=?", (new_status, *args, booking_id))
    when = pretty_when(b["date"], b["time"])
    if action in ("reject", "cancel"):
        release_seat(biz["id"], b["date"], b["time"])
        notify(b["customer_id"], "Booking declined" if action == "reject" else "Booking cancelled",
               f"{biz['name']} couldn't take your {when} slot. Pick another time that suits you.", booking_id)
        tell_waitlist(biz, b["date"])
    elif action == "confirm":
        notify(b["customer_id"], "Booking confirmed", f"{biz['name']} confirmed {when}.", booking_id)
    elif action == "start":
        notify(b["customer_id"], "It's your turn", f"{biz['name']} is ready for you now.", booking_id)
    elif action == "complete":
        notify(b["customer_id"], "Visit complete", f"Thanks for visiting {biz['name']}. Rate your visit to help others.", booking_id)
    elif action == "no_show":
        notify(b["customer_id"], "Missed appointment", f"You were marked as a no-show for {when} at {biz['name']}.", booking_id)
    return jsonify({"ok": True, "status": new_status})


@app.route("/api/pro/walkin", methods=["POST"])
@login_required("professional")
def pro_walkin():
    """Add someone who just walked in. They take a seat in the current slot so
    online customers see true availability."""
    biz = my_business()
    d = body()
    name = (d.get("name") or "").strip() or "Walk-in"
    step = biz["slot_minutes"] or 30
    t = valid_time(d.get("time")) or from_min(to_min(hhmm_now()) // step * step)
    day = today()
    svc = None
    if d.get("service_id"):
        svc = db.query("SELECT * FROM services WHERE id=? AND business_id=?", (to_int(d["service_id"]), biz["id"]), one=True)
    staff_n = db.query("SELECT COUNT(*) AS n FROM staff WHERE business_id=? AND active=1", (biz["id"],), one=True)["n"]
    db.execute("INSERT INTO slots (business_id, date, time, capacity) VALUES (?,?,?,?) ON CONFLICT (business_id, date, time) DO NOTHING",
               (biz["id"], day, t, max(1, staff_n)))
    db.execute("UPDATE slots SET booked = booked + 1 WHERE business_id=? AND date=? AND time=?", (biz["id"], day, t))
    new_id = db.insert(
        "INSERT INTO bookings (business_id, customer_name, customer_phone, service_id, service_name, price, duration_min, "
        "staff_id, date, time, status, source, created_at, checked_in_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (biz["id"], name[:80], clean_phone(d.get("phone")) or None, svc["id"] if svc else None,
         svc["name"] if svc else "Walk-in", svc["price"] if svc else 0, svc["duration_min"] if svc else step,
         assign_staff(biz["id"], day, t), day, t, "checked_in", "walkin", stamp(), stamp()))
    return jsonify({"ok": True, "id": new_id})


@app.route("/api/pro/slots")
@login_required("professional")
def pro_slots():
    biz = my_business()
    start = valid_date(request.args.get("from")) or today()
    end = (datetime.strptime(start, "%Y-%m-%d") + timedelta(days=6)).strftime("%Y-%m-%d")
    rows = db.query("SELECT id, date, time, capacity, booked, blocked FROM slots WHERE business_id=? AND date >= ? AND date <= ? "
                    "ORDER BY date, time", (biz["id"], start, end))
    return jsonify({"from": start, "to": end, "today": today(), "now": hhmm_now(),
                    "slots": [{**s, "state": slot_state(s)} for s in rows]})


@app.route("/api/pro/slots/generate", methods=["POST"])
@login_required("professional")
def pro_generate_slots():
    biz = my_business()
    d = body()
    start_day = valid_date(d.get("from")) or today()
    days = to_int(d.get("days"), 7, 1, 60)
    weekdays = {to_int(w, -1) for w in (d.get("weekdays") or [0, 1, 2, 3, 4, 5])}
    opens, closes = valid_time(d.get("start")), valid_time(d.get("end"))
    if not opens or not closes or to_min(closes) <= to_min(opens):
        return err("Closing time has to be after opening time.")
    step = to_int(d.get("slot_minutes"), 30, 5, 240)
    capacity = to_int(d.get("capacity"), 1, 1, 50)
    b1, b2 = valid_time(d.get("break_start")), valid_time(d.get("break_end"))
    first = max(datetime.strptime(start_day, "%Y-%m-%d").date(), now().date())
    rows = []
    for i in range(days):
        day = first + timedelta(days=i)
        if day.weekday() not in weekdays:
            continue
        m = to_min(opens)
        while m + step <= to_min(closes):
            in_break = b1 and b2 and to_min(b1) <= m < to_min(b2)
            if not in_break:
                rows.append((biz["id"], day.strftime("%Y-%m-%d"), from_min(m), capacity))
            m += step
    before = db.query("SELECT COUNT(*) AS n FROM slots WHERE business_id=?", (biz["id"],), one=True)["n"]
    db.executemany("INSERT INTO slots (business_id, date, time, capacity) VALUES (?,?,?,?) "
                   "ON CONFLICT (business_id, date, time) DO NOTHING", rows)
    after = db.query("SELECT COUNT(*) AS n FROM slots WHERE business_id=?", (biz["id"],), one=True)["n"]
    db.execute("UPDATE businesses SET slot_minutes=? WHERE id=?", (step, biz["id"]))
    return jsonify({"added": after - before, "skipped": len(rows) - (after - before)})


@app.route("/api/pro/slots/<int:slot_id>", methods=["POST", "DELETE"])
@login_required("professional")
def pro_slot(slot_id):
    biz = my_business()
    s = db.query("SELECT * FROM slots WHERE id=? AND business_id=?", (slot_id, biz["id"]), one=True)
    if not s:
        return err("Slot not found.", 404)
    if request.method == "DELETE":
        if s["booked"] > 0:
            return err("This slot has bookings. Block it instead so nobody else can book.")
        db.execute("DELETE FROM slots WHERE id=?", (slot_id,))
        return jsonify({"ok": True})
    d = body()
    capacity = to_int(d.get("capacity", s["capacity"]), s["capacity"], 1, 50)
    blocked = 1 if d.get("blocked", bool(s["blocked"])) else 0
    db.execute("UPDATE slots SET capacity=?, blocked=? WHERE id=?", (capacity, blocked, slot_id))
    return jsonify({"ok": True})


@app.route("/api/pro/slots/clear-day", methods=["POST"])
@login_required("professional")
def pro_clear_day():
    biz = my_business()
    day = valid_date(body().get("date"))
    if not day:
        return err("Pick a day.")
    removed = db.execute("DELETE FROM slots WHERE business_id=? AND date=? AND booked=0", (biz["id"], day))
    blocked = db.execute("UPDATE slots SET blocked=1 WHERE business_id=? AND date=? AND booked>0", (biz["id"], day))
    return jsonify({"removed": removed, "blocked": blocked})


@app.route("/api/pro/staff", methods=["GET", "POST"])
@login_required("professional")
def pro_staff():
    biz = my_business()
    if request.method == "POST":
        d = body()
        name = (d.get("name") or "").strip()
        if not name:
            return err("Enter a name.")
        if d.get("id"):
            db.execute("UPDATE staff SET name=?, role=?, active=? WHERE id=? AND business_id=?",
                       (name[:80], (d.get("role") or "").strip()[:60], 1 if d.get("active", True) else 0, to_int(d["id"]), biz["id"]))
        else:
            db.insert("INSERT INTO staff (business_id, name, role) VALUES (?,?,?)",
                      (biz["id"], name[:80], (d.get("role") or "").strip()[:60]))
    return jsonify({"staff": _staff_list(biz["id"])})


@app.route("/api/pro/services", methods=["GET", "POST"])
@login_required("professional")
def pro_services():
    biz = my_business()
    if request.method == "POST":
        d = body()
        name = (d.get("name") or "").strip()
        if not name:
            return err("Enter a service name.")
        vals = (name[:80], to_int(d.get("duration_min"), 30, 5, 480), to_int(d.get("price"), 0, 0, 10_000_000))
        if d.get("id"):
            db.execute("UPDATE services SET name=?, duration_min=?, price=?, active=? WHERE id=? AND business_id=?",
                       (*vals, 1 if d.get("active", True) else 0, to_int(d["id"]), biz["id"]))
        else:
            db.insert("INSERT INTO services (business_id, name, duration_min, price) VALUES (?,?,?,?)", (biz["id"], *vals))
    rows = db.query("SELECT id, name, duration_min, price, active FROM services WHERE business_id=? AND active=1 ORDER BY id", (biz["id"],))
    return jsonify({"services": rows})


@app.route("/api/pro/profile", methods=["GET", "POST"])
@login_required("professional")
def pro_profile():
    biz = my_business()
    if request.method == "POST":
        d = body()
        name = (d.get("name") or "").strip()
        if not name:
            return err("Enter your business name.")
        category = d.get("category") if d.get("category") in CATEGORIES else biz["category"]
        lat, lng = to_float(d.get("lat")), to_float(d.get("lng"))
        db.execute(
            "UPDATE businesses SET name=?, category=?, about=?, address=?, city=?, pincode=?, phone=?, lat=?, lng=?, auto_approve=? WHERE id=?",
            (name[:120], category, (d.get("about") or "").strip()[:500], (d.get("address") or "").strip()[:200],
             (d.get("city") or "").strip()[:80], (d.get("pincode") or "").strip()[:10], clean_phone(d.get("phone")) or None,
             lat if lat is not None else biz["lat"], lng if lng is not None else biz["lng"],
             1 if d.get("auto_approve", True) else 0, biz["id"]))
        biz = my_business()
    out = public_business(biz)
    out["demand"] = db.query("SELECT COUNT(*) AS n FROM leads WHERE osm_id=?", (biz["osm_id"] or "",), one=True)["n"]
    out["plan"] = biz["access_type"]
    return jsonify(out)


@app.route("/api/pro/demand", methods=["POST"])
@login_required("professional")
def pro_demand():
    """How many customers asked for each of these map listings."""
    ids = [str(i)[:60] for i in (body().get("osm_ids") or [])][:200]
    if not ids:
        return jsonify({"demand": {}, "claimed": []})
    marks = ",".join("?" * len(ids))
    rows = db.query(f"SELECT osm_id, COUNT(*) AS n FROM leads WHERE osm_id IN ({marks}) GROUP BY osm_id", ids)
    claimed = db.query(f"SELECT osm_id FROM businesses WHERE osm_id IN ({marks})", ids)
    return jsonify({"demand": {r["osm_id"]: r["n"] for r in rows}, "claimed": [r["osm_id"] for r in claimed]})


@app.route("/api/pro/claim", methods=["POST"])
@login_required("professional")
def pro_claim():
    biz = my_business()
    d = body()
    osm_id = (d.get("osm_id") or "").strip()[:60]
    lat, lng = to_float(d.get("lat")), to_float(d.get("lng"))
    if not osm_id or lat is None or lng is None:
        return err("Pick your business from the list.")
    taken = db.query("SELECT id FROM businesses WHERE osm_id=? AND id<>?", (osm_id, biz["id"]), one=True)
    if taken:
        return err("Another account has already claimed this listing.", 409)
    db.execute("UPDATE businesses SET osm_id=?, lat=?, lng=?, address=COALESCE(NULLIF(?, ''), address) WHERE id=?",
               (osm_id, lat, lng, (d.get("address") or "").strip()[:200], biz["id"]))
    told = _welcome_leads(biz["id"], osm_id, biz["name"])
    return jsonify({"ok": True, "customers_notified": told})


@app.route("/api/pro/insights")
@login_required("professional")
def pro_insights():
    biz = my_business()
    days = to_int(request.args.get("days"), 14, 7, 90)
    end = now().date()
    start = end - timedelta(days=days - 1)
    s, e = start.strftime("%Y-%m-%d"), end.strftime("%Y-%m-%d")
    rows = db.query("SELECT date, time, status, staff_id, price, source, customer_id, customer_phone, customer_name, is_sample "
                    "FROM bookings WHERE business_id=? AND date >= ? AND date <= ?", (biz["id"], s, e))
    by_day = {(start + timedelta(days=i)).strftime("%Y-%m-%d"): {"served": 0, "no_show": 0, "cancelled": 0, "upcoming": 0}
              for i in range(days)}
    hours, staff_load, visits = {}, {}, {}
    totals = {"bookings": 0, "completed": 0, "no_show": 0, "cancelled": 0, "walkin": 0, "revenue": 0}
    for r in rows:
        if r["status"] == "rejected":
            continue
        totals["bookings"] += 1
        bucket = by_day[r["date"]]
        if r["status"] == "completed":
            bucket["served"] += 1
            totals["completed"] += 1
            totals["revenue"] += r["price"] or 0
            who = r["customer_id"] or r["customer_phone"] or (r["customer_name"] if r["is_sample"] else None)
            if who:
                visits[who] = visits.get(who, 0) + 1
        elif r["status"] == "no_show":
            bucket["no_show"] += 1
            totals["no_show"] += 1
        elif r["status"] == "cancelled":
            bucket["cancelled"] += 1
            totals["cancelled"] += 1
        else:
            bucket["upcoming"] += 1
        if r["source"] == "walkin":
            totals["walkin"] += 1
        if r["status"] != "cancelled":
            h = int(r["time"][:2])
            wd = datetime.strptime(r["date"], "%Y-%m-%d").weekday()
            hours[(wd, h)] = hours.get((wd, h), 0) + 1
            if r["staff_id"]:
                staff_load[r["staff_id"]] = staff_load.get(r["staff_id"], 0) + 1
    cap = db.query("SELECT COALESCE(SUM(capacity),0) AS cap, COALESCE(SUM(CASE WHEN booked > capacity THEN capacity ELSE booked END),0) AS used "
                   "FROM slots WHERE business_id=? AND blocked=0 AND date >= ? AND date <= ?", (biz["id"], s, e), one=True)
    rating = _ratings([biz["id"]]).get(biz["id"])
    waitlist = db.query("SELECT COUNT(*) AS n FROM waitlist WHERE business_id=? AND date >= ?", (biz["id"], e), one=True)["n"]
    finished = totals["completed"] + totals["no_show"]
    hour_list = sorted({h for (_, h) in hours}) or []
    peak = max(hours.items(), key=lambda kv: kv[1])[0] if hours else None
    return jsonify({
        "days": days, "from": s, "to": e,
        "by_day": [{"date": d, **v} for d, v in by_day.items()],
        "heat": [{"weekday": wd, "hour": h, "n": n} for (wd, h), n in sorted(hours.items())],
        "hours": list(range(min(hour_list), max(hour_list) + 1)) if hour_list else [],
        "peak": {"weekday": peak[0], "hour": peak[1]} if peak else None,
        "staff": [{"id": st["id"], "name": st["name"], "load": staff_load.get(st["id"], 0)} for st in _staff_list(biz["id"]) if st["active"]],
        "totals": totals,
        "no_show_rate": round(100 * totals["no_show"] / finished) if finished else 0,
        "utilization": round(100 * cap["used"] / cap["cap"]) if cap["cap"] else 0,
        "repeat_rate": round(100 * sum(1 for v in visits.values() if v > 1) / len(visits)) if visits else 0,
        "rating": rating, "waitlist": waitlist,
        "has_sample": any(r["is_sample"] for r in rows),
    })


SAMPLE_NAMES = [f"{n} {s}." for n in ['Aarav', 'Diya', 'Kabir', 'Meera', 'Rohan', 'Ananya', 'Vivaan', 'Isha', 'Arjun', 'Sara', 'Kunal', 'Nisha', 'Dev', 'Pooja', 'Rahul', 'Tanvi', 'Aditi', 'Yash', 'Sneha', 'Manav', 'Ritu', 'Karan', 'Neha', 'Sahil'] for s in "KMS"]


@app.route("/api/pro/sample-data", methods=["POST", "DELETE"])
@login_required("professional")
def pro_sample_data():
    """Fill the last two weeks with clearly-labelled sample bookings so the
    Insights screen can be explored before real history exists."""
    biz = my_business()
    db.execute("DELETE FROM bookings WHERE business_id=? AND is_sample=1", (biz["id"],))
    db.execute("DELETE FROM slots WHERE business_id=? AND is_sample=1", (biz["id"],))
    if request.method == "DELETE":
        return jsonify({"ok": True})
    staff = [s["id"] for s in _staff_list(biz["id"]) if s["active"]] or [None]
    services = db.query("SELECT * FROM services WHERE business_id=? AND active=1", (biz["id"],)) or \
        [{"id": None, "name": "Appointment", "price": 0, "duration_min": 30}]
    rng = random.Random(biz["id"])
    step = biz["slot_minutes"] or 30
    times = [from_min(m) for m in range(10 * 60, 19 * 60, step)]
    weight = [1.0 + 1.6 * math.exp(-((to_min(t) - 11.5 * 60) / 70) ** 2) + 2.0 * math.exp(-((to_min(t) - 17.5 * 60) / 60) ** 2) for t in times]
    slot_rows, booking_rows = [], []
    for back in range(14, 0, -1):
        day = now().date() - timedelta(days=back)
        if day.weekday() == 6:
            continue
        ds = day.strftime("%Y-%m-%d")
        n = int(len(times) * len(staff) * rng.uniform(0.35, 0.6) * (1.25 if day.weekday() == 5 else 1.0))
        picks = rng.choices(times, weights=weight, k=n)
        per_slot, first_staff = {}, {}
        for t in picks:
            if per_slot.get(t, 0) >= len(staff):
                continue
            per_slot[t] = per_slot.get(t, 0) + 1
            roll = rng.random()
            status = "completed" if roll < 0.82 else ("no_show" if roll < 0.91 else "cancelled")
            svc = rng.choice(services)
            booking_rows.append((biz["id"], rng.choice(SAMPLE_NAMES), None, svc["id"], svc["name"], svc["price"], svc["duration_min"],
                                 staff[(per_slot[t] - 1 + first_staff.setdefault(t, rng.randrange(len(staff)))) % len(staff)], ds, t, status,
                                 "walkin" if rng.random() < 0.25 else "online", 1, f"{ds} 09:00:00"))
        for t in times:
            slot_rows.append((biz["id"], ds, t, len(staff), min(per_slot.get(t, 0), len(staff))))
    db.executemany("INSERT INTO slots (business_id, date, time, capacity, booked, is_sample) VALUES (?,?,?,?,?,1) "
                   "ON CONFLICT (business_id, date, time) DO NOTHING", slot_rows)
    db.executemany(
        "INSERT INTO bookings (business_id, customer_name, customer_phone, service_id, service_name, price, duration_min, "
        "staff_id, date, time, status, source, is_sample, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", booking_rows)
    return jsonify({"ok": True, "added": len(booking_rows)})


# ---------------------------------------------------------------- admin (plan tiers)
# Same JSON shapes as the original app, so the existing admin screen keeps working.

def _admin_ok(d):
    return bool(ADMIN_SECRET) and secrets.compare_digest(str(d.get("admin_secret") or ""), ADMIN_SECRET)


@app.route("/admin/professionals", methods=["POST"])
def admin_list_professionals():
    if not _admin_ok(body()):
        return err("Unauthorized", 401)
    rows = db.query("SELECT owner_name, category, name, city, pincode, access_type FROM businesses ORDER BY owner_name")
    return jsonify([{"name": r["owner_name"], "business_type": CATEGORIES.get(r["category"], r["category"]),
                     "establishment": r["name"], "city": r["city"], "pincode": r["pincode"], "access_type": r["access_type"]}
                    for r in rows])


@app.route("/admin/set_access_type", methods=["POST"])
def admin_set_access_type():
    d = body()
    if not _admin_ok(d):
        return err("Unauthorized", 401)
    if d.get("access_type") not in ("free", "paid", "premium"):
        return err("access_type must be one of: free, paid, premium")
    if not db.execute("UPDATE businesses SET access_type=? WHERE owner_name=?", (d["access_type"], d.get("name"))):
        return err("Professional not found", 404)
    return jsonify({"name": d.get("name"), "access_type": d["access_type"]})


@app.route("/admin/customers", methods=["POST"])
def admin_list_customers():
    if not _admin_ok(body()):
        return err("Unauthorized", 401)
    rows = db.query("SELECT name, phone, access_type FROM accounts WHERE role='customer' ORDER BY name")
    return jsonify(rows)


@app.route("/admin/set_customer_access_type", methods=["POST"])
def admin_set_customer_access_type():
    d = body()
    if not _admin_ok(d):
        return err("Unauthorized", 401)
    if d.get("access_type") not in ("free", "paid", "premium"):
        return err("access_type must be one of: free, paid, premium")
    if not db.execute("UPDATE accounts SET access_type=? WHERE phone=? AND role='customer'", (d["access_type"], d.get("phone"))):
        return err("Customer not found", 404)
    return jsonify({"phone": d.get("phone"), "access_type": d["access_type"]})


@app.errorhandler(404)
def not_found(_):
    if request.path.startswith("/api/"):
        return err("Not found.", 404)
    return redirect("/")


if __name__ == "__main__":
    # No auto-reloader: it exits immediately on some Windows setups.
    app.run(debug=os.environ.get("FLASK_DEBUG") == "1", use_reloader=False, port=int(os.environ.get("PORT", "5000")))
