# Schedulink

**Customers know when to come. Businesses know how to plan.**

Schedulink is a scheduling platform for local service businesses (clinics, salons, vets, gyms, repair shops…).
Customers turn on location, see who is free nearby, and book a real open slot. Businesses run their whole
day — queue, walk-ins, schedule, team workload and demand insights — from one screen.

## The three pages

| Page | URL | What it does |
| --- | --- | --- |
| Landing | `/` | The pitch, plus business sign-in / sign-up |
| Customer | `/customer` | Live location → nearby places on a map → book → track your turn |
| Professional | `/professional` | Today's queue, schedule, team & services, insights, business profile |

`/admin` (plan tiers, from the original app) still works when `ADMIN_SECRET` is set.

### Customer side
- **Use my location** (or type an area / PIN code) — results sorted by distance, shown on a map.
- **Real nearby data**: places come live from OpenStreetMap (Overpass API). Businesses that have joined
  Schedulink show real open slots; the rest are listed with call / directions and **Ask for online booking**,
  which records demand for that business.
- Booking drawer: service, 10-day strip, slots with seats left, optional note. Full slots can't be booked.
- **Live token** in *My bookings*: how many are ahead of you, expected time, and whether the day is running late.
- Change time, cancel, add to calendar (.ics), directions, book again, rate a completed visit.
- **Alert me if a slot opens** on a full day; alerts for every booking event.

### Professional side
- **Today**: KPIs, live queue (confirm → check in → start → done, no-show, undo), **add walk-in**,
  team workload, shareable booking link.
- **Schedule**: set working days/hours/break/slot length once and open slots for 7–30 days; tap any slot to
  change capacity, block or remove it; close a whole day.
- **Team & services**: staff on/off duty, services with duration and price. New bookings are assigned to
  the team member with the lightest day.
- **Insights**: customers served, seats filled, no-show rate, repeat rate, walk-in share, bookings per day,
  busy-hour heatmap, workload per person, and a plain-language recommendation.
  *Load sample data* fills two weeks of clearly labelled sample bookings (removable in one click).
- **Business profile**: details, map pin (use current location / find from address / drag), **claim your
  OpenStreetMap listing** — customers who asked for you are alerted that you're bookable.

## Run locally

```bash
pip install -r requirements.txt
python app.py            # http://localhost:5000
```

No setup needed: without `DATABASE_URL` it stores data in a local SQLite file (`schedulink.db`).
Browsers only share location on `https://` or `localhost`.

## Deploy on Vercel

1. vercel.com/new → import this repo → **Deploy** (Flask is detected automatically; no settings to change).
2. In the project: **Storage → Create Database → Neon** (free) and connect it to the project.
   That sets `DATABASE_URL` / `POSTGRES_URL` for you.
3. **Deployments → ⋯ → Redeploy** so the app picks up the database.

A database is required on Vercel: its disk is read-only, so without one the app falls back to a temporary
file and loses data between requests. `SECRET_KEY` is optional there (a stable key is derived from the
database URL) and secure cookies are on by default.

## Deploy on Render

1. Push this repo to GitHub.
2. Render dashboard → **New → Blueprint** → pick the repo → **Apply**.
   `render.yaml` creates the web service and a PostgreSQL database and wires `DATABASE_URL`, `SECRET_KEY`
   and `ADMIN_SECRET` for you.

Manual alternative: **New → Web Service**, build `pip install -r requirements.txt`,
start `gunicorn app:app --workers 2 --threads 4 --bind 0.0.0.0:$PORT`, then add the environment variables below.

| Variable | Needed | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Recommended | PostgreSQL URL (Render, Neon, Supabase…). Without it the app uses SQLite on the instance's disk, which free hosts wipe on every restart. |
| `SECRET_KEY` | Yes in production | Signs login sessions. Any long random string. |
| `COOKIE_SECURE` | `1` in production | Send the session cookie over HTTPS only. |
| `ADMIN_SECRET` | Optional | Enables `/admin`. |
| `APP_TZ` | Optional | Defaults to `Asia/Kolkata`. |

## A 3-minute demo script

1. Open `/` → **List my business free** → create a business account.
2. **Business profile** → *Use my current location* → *Save this spot* → *Find my listing nearby* (optional claim).
3. **Team & services** → add a second team member, set a price.
4. **Schedule** → *Open these slots*.
5. In another browser (or phone): `/customer` → **Use my location** → your business is at the top under
   *Book now on Schedulink*, with real surrounding places below → book a slot.
6. Back on **Today**: the booking is in the queue. Add a walk-in, tap *Start* — the customer's token
   updates to "1 ahead of you".
7. **Insights** → *Load sample data* to show the planning view (say that it's sample data).

## Project layout

```
app.py              Flask routes and API
db.py               Small PostgreSQL / SQLite layer and schema
templates/          index, customer, professional, admin
public/static/      CSS, page scripts, bundled Leaflet and fonts (no build step)
legacy/             The original prototype files, kept for reference
```

## Notes

- Map tiles and place data: © OpenStreetMap contributors. Public Overpass/Nominatim servers are fine for a
  demo and low traffic; at scale, host your own or use a paid provider.
- Passwords are hashed (Werkzeug); every booking API checks the signed-in account.
- This version uses its own tables (`accounts`, `businesses`, `slots`, `bookings`…), so it never touches
  the original app's tables even if pointed at the same database.
