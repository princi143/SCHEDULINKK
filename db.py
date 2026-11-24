"""Small database layer that runs on PostgreSQL (production) or SQLite (zero-config).

Set DATABASE_URL to a postgres:// URL to use PostgreSQL. With no DATABASE_URL the
app stores data in a local SQLite file, so it runs anywhere with no setup.

All SQL in the app is written with `?` placeholders and plain, portable SQL.
"""
import os
import sqlite3
import threading
from contextlib import contextmanager

# DATABASE_URL is the standard name; POSTGRES_URL is what Vercel's database
# integrations (Neon, Supabase) set automatically.
DATABASE_URL = (os.environ.get("DATABASE_URL") or os.environ.get("POSTGRES_URL") or "").strip()
if DATABASE_URL.startswith("postgres://"):
    DATABASE_URL = "postgresql://" + DATABASE_URL[len("postgres://"):]

IS_PG = DATABASE_URL.startswith("postgresql://")
_default_dir = "/tmp" if os.environ.get("VERCEL") else os.path.dirname(os.path.abspath(__file__))
SQLITE_PATH = os.environ.get("SQLITE_PATH", os.path.join(_default_dir, "schedulink.db"))

_pool = None
_local = threading.local()

if IS_PG:
    import psycopg2
    import psycopg2.extras
    import psycopg2.pool

    _pool = psycopg2.pool.ThreadedConnectionPool(1, int(os.environ.get("DB_POOL_MAX", "5")), dsn=DATABASE_URL)
    IntegrityError = psycopg2.IntegrityError
else:
    IntegrityError = sqlite3.IntegrityError


def _sqlite_conn():
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(SQLITE_PATH, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def _pg_conn():
    """A pooled connection that is known to be alive. Serverless hosts freeze
    idle instances, so a pooled connection may have been closed by the server."""
    for _ in range(3):
        conn = _pool.getconn()
        try:
            with conn.cursor() as cur:
                cur.execute("SELECT 1")
            conn.rollback()
            return conn
        except (psycopg2.OperationalError, psycopg2.InterfaceError):
            _pool.putconn(conn, close=True)
    return _pool.getconn()


@contextmanager
def _cursor():
    if IS_PG:
        conn = _pg_conn()
        try:
            cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
            yield cur
            conn.commit()
        except Exception:
            try:
                conn.rollback()
            except Exception:
                pass
            raise
        finally:
            _pool.putconn(conn, close=bool(conn.closed))
    else:
        conn = _sqlite_conn()
        cur = conn.cursor()
        try:
            yield cur
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            cur.close()


def _sql(q):
    return q.replace("?", "%s") if IS_PG else q


def query(q, args=(), one=False):
    """Run a SELECT (or anything with RETURNING). Returns a list of dicts, or one dict/None."""
    with _cursor() as cur:
        cur.execute(_sql(q), tuple(args))
        rows = [dict(r) for r in cur.fetchall()] if cur.description else []
    if one:
        return rows[0] if rows else None
    return rows


def execute(q, args=()):
    """Run INSERT/UPDATE/DELETE. Returns the number of affected rows."""
    with _cursor() as cur:
        cur.execute(_sql(q), tuple(args))
        return cur.rowcount


def insert(q, args=()):
    """Run an INSERT and return the new row id."""
    row = query(q.rstrip().rstrip(";") + " RETURNING id", args, one=True)
    return row["id"] if row else None


def executemany(q, rows):
    if not rows:
        return
    with _cursor() as cur:
        cur.executemany(_sql(q), [tuple(r) for r in rows])


SCHEMA = [
    """CREATE TABLE IF NOT EXISTS accounts (
        id {PK},
        role TEXT NOT NULL,
        name TEXT NOT NULL,
        login TEXT NOT NULL,
        phone TEXT,
        email TEXT,
        password_hash TEXT NOT NULL,
        access_type TEXT NOT NULL DEFAULT 'free',
        created_at TEXT NOT NULL,
        UNIQUE (role, login)
    )""",
    """CREATE TABLE IF NOT EXISTS businesses (
        id {PK},
        owner_id INTEGER NOT NULL,
        owner_name TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'other',
        about TEXT,
        address TEXT,
        city TEXT,
        pincode TEXT,
        phone TEXT,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        osm_id TEXT,
        auto_approve INTEGER NOT NULL DEFAULT 1,
        slot_minutes INTEGER NOT NULL DEFAULT 30,
        access_type TEXT NOT NULL DEFAULT 'free',
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS staff (
        id {PK},
        business_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        role TEXT,
        active INTEGER NOT NULL DEFAULT 1
    )""",
    """CREATE TABLE IF NOT EXISTS services (
        id {PK},
        business_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        duration_min INTEGER NOT NULL DEFAULT 30,
        price INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
    )""",
    """CREATE TABLE IF NOT EXISTS slots (
        id {PK},
        business_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        capacity INTEGER NOT NULL DEFAULT 1,
        booked INTEGER NOT NULL DEFAULT 0,
        blocked INTEGER NOT NULL DEFAULT 0,
        is_sample INTEGER NOT NULL DEFAULT 0,
        UNIQUE (business_id, date, time)
    )""",
    """CREATE TABLE IF NOT EXISTS bookings (
        id {PK},
        business_id INTEGER NOT NULL,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        customer_phone TEXT,
        service_id INTEGER,
        service_name TEXT,
        price INTEGER NOT NULL DEFAULT 0,
        duration_min INTEGER NOT NULL DEFAULT 30,
        staff_id INTEGER,
        date TEXT NOT NULL,
        time TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'online',
        note TEXT,
        is_sample INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        checked_in_at TEXT,
        started_at TEXT,
        completed_at TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS idx_bookings_biz_date ON bookings (business_id, date)",
    "CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings (customer_id)",
    """CREATE TABLE IF NOT EXISTS notifications (
        id {PK},
        account_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        booking_id INTEGER,
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications (account_id, is_read)",
    """CREATE TABLE IF NOT EXISTS reviews (
        id {PK},
        business_id INTEGER NOT NULL,
        booking_id INTEGER NOT NULL UNIQUE,
        customer_id INTEGER NOT NULL,
        customer_name TEXT,
        rating INTEGER NOT NULL,
        comment TEXT,
        created_at TEXT NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS leads (
        id {PK},
        osm_id TEXT NOT NULL,
        place_name TEXT,
        category TEXT,
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        customer_id INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (osm_id, customer_id)
    )""",
    """CREATE TABLE IF NOT EXISTS waitlist (
        id {PK},
        business_id INTEGER NOT NULL,
        customer_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (business_id, customer_id, date)
    )""",
]


def init_db():
    pk = "SERIAL PRIMARY KEY" if IS_PG else "INTEGER PRIMARY KEY AUTOINCREMENT"
    with _cursor() as cur:
        for stmt in SCHEMA:
            cur.execute(stmt.replace("{PK}", pk))
