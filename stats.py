"""
Request log, usage aggregates and admin auth — one SQLite file (STATS_DB).

Only metadata is stored: which model, how long, how many tokens, which tools,
and errors. Prompts and answers are never written to disk.
"""
import hashlib
import hmac
import os
import secrets
import sqlite3
import threading
import time

import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS requests (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    ts                REAL    NOT NULL,
    requested         TEXT,             -- model name the client sent
    model             TEXT,             -- alias that finally served it
    provider          TEXT,
    stream            INTEGER NOT NULL DEFAULT 0,
    status            TEXT    NOT NULL, -- ok | error | client_tool
    fallback          INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER,
    ttft_ms           INTEGER,          -- streaming: time to first token
    prompt_tokens     INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    turns             INTEGER NOT NULL DEFAULT 0,
    tool_calls        INTEGER NOT NULL DEFAULT 0,
    tools             TEXT,             -- comma separated server tools used
    error             TEXT,
    client            TEXT,             -- client IP
    source            TEXT NOT NULL DEFAULT 'api'   -- api | test
);
CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS idx_requests_model_ts ON requests(model, ts);

CREATE TABLE IF NOT EXISTS admin (
    id        INTEGER PRIMARY KEY CHECK (id = 1),
    username  TEXT NOT NULL,
    pw_hash   TEXT NOT NULL,
    salt      TEXT NOT NULL,
    created   REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires    REAL NOT NULL
);

-- Project API keys for the model API. Only a sha256 of the key is stored.
CREATE TABLE IF NOT EXISTS api_keys (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    name           TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    prefix         TEXT    NOT NULL,        -- shown in the panel, not usable
    key_hash       TEXT    NOT NULL UNIQUE,
    models         TEXT,                    -- JSON list of aliases; NULL = every model
    tools          INTEGER NOT NULL DEFAULT 1,   -- may use web_search / fetch_url
    daily_tokens   INTEGER,                 -- NULL = no limit (Tehran day)
    monthly_tokens INTEGER,                 -- NULL = no limit (last 30 Tehran days)
    expires_at     REAL,
    active         INTEGER NOT NULL DEFAULT 1,
    note           TEXT,
    created_at     REAL    NOT NULL,
    updated_at     REAL    NOT NULL,
    last_used_at   REAL,
    last_used_ip   TEXT
);
"""

COLUMNS = ("ts", "requested", "model", "provider", "stream", "status", "fallback",
           "latency_ms", "ttft_ms", "prompt_tokens", "completion_tokens", "turns",
           "tool_calls", "tools", "error", "client", "source", "key_id")

KEY_FIELDS = ("name", "models", "tools", "daily_tokens", "monthly_tokens",
              "expires_at", "active", "note")


class Store:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self._migrate()
        self._last_purge = 0.0
        self.purge()

    def _migrate(self) -> None:
        cols = {r["name"] for r in self.db.execute("PRAGMA table_info(requests)")}
        if "key_id" not in cols:   # pre-keys DB: older rows keep key_id NULL
            self.db.execute("ALTER TABLE requests ADD COLUMN key_id INTEGER")
        self.db.execute("CREATE INDEX IF NOT EXISTS idx_requests_key_ts ON requests(key_id, ts)")

    # ── writes ──────────────────────────────────────────────
    def log_request(self, rec: dict) -> None:
        row = [rec.get(c) for c in COLUMNS]
        with self.lock:
            self.db.execute(
                f"INSERT INTO requests ({','.join(COLUMNS)}) VALUES ({','.join('?' * len(COLUMNS))})",
                row)
        if time.time() - self._last_purge > 6 * 3600:
            self.purge()

    def purge(self) -> None:
        cutoff = time.time() - config.STATS_RETENTION_DAYS * 86400
        with self.lock:
            self.db.execute("DELETE FROM requests WHERE ts < ?", (cutoff,))
            self.db.execute("DELETE FROM sessions WHERE expires < ?", (time.time(),))
        self._last_purge = time.time()

    # ── reads ───────────────────────────────────────────────
    def _all(self, sql: str, args=()) -> list[dict]:
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, args).fetchall()]

    def summary(self, since: float) -> dict:
        row = self._all("""
            SELECT COUNT(*)                                   AS requests,
                   COALESCE(SUM(status = 'error'), 0)         AS errors,
                   COALESCE(SUM(fallback), 0)                 AS fallbacks,
                   COALESCE(SUM(tool_calls), 0)               AS tool_calls,
                   COALESCE(SUM(prompt_tokens), 0)            AS prompt_tokens,
                   COALESCE(SUM(completion_tokens), 0)        AS completion_tokens,
                   CAST(AVG(CASE WHEN status != 'error' THEN latency_ms END) AS INTEGER) AS avg_latency_ms
            FROM requests WHERE ts >= ? AND source = 'api'""", (since,))[0]
        return row

    def by_model(self, since: float) -> list[dict]:
        return self._all("""
            SELECT model,
                   COUNT(*)                                   AS requests,
                   SUM(status = 'error')                      AS errors,
                   SUM(fallback)                              AS fallbacks,
                   SUM(prompt_tokens)                         AS prompt_tokens,
                   SUM(completion_tokens)                     AS completion_tokens,
                   CAST(AVG(CASE WHEN status != 'error' THEN latency_ms END) AS INTEGER) AS avg_latency_ms,
                   MAX(ts)                                    AS last_ts
            FROM requests WHERE ts >= ? AND source = 'api'
            GROUP BY model ORDER BY requests DESC""", (since,))

    def series(self, bucket_seconds: int, since: float, tz_offset: int = 0) -> list[dict]:
        """Requests/tokens per bucket and model. tz_offset (seconds) shifts
        bucket edges so days start at local midnight."""
        return self._all("""
            SELECT CAST((ts + :off) / :b AS INTEGER) * :b - :off AS bucket,
                   model,
                   COUNT(*)                     AS requests,
                   SUM(status = 'error')        AS errors,
                   SUM(prompt_tokens)           AS prompt_tokens,
                   SUM(completion_tokens)       AS completion_tokens
            FROM requests WHERE ts >= :since AND source = 'api'
            GROUP BY bucket, model ORDER BY bucket""",
            {"b": bucket_seconds, "since": since, "off": tz_offset})

    def recent(self, limit: int = 50, before_id: int | None = None,
               model: str | None = None, status: str | None = None,
               key_id: int | None = None) -> list[dict]:
        where, args = ["1=1"], []
        if before_id:
            where.append("r.id < ?"); args.append(before_id)
        if model:
            where.append("r.model = ?"); args.append(model)
        if status:
            where.append("r.status = ?"); args.append(status)
        if key_id is not None:
            where.append("COALESCE(r.key_id, 0) = ?"); args.append(key_id)
        args.append(max(1, min(limit, 500)))
        return self._all(
            f"""SELECT r.*, k.name AS key_name FROM requests r
                LEFT JOIN api_keys k ON k.id = r.key_id
                WHERE {' AND '.join(where)} ORDER BY r.id DESC LIMIT ?""", args)

    # ── project API keys ────────────────────────────────────
    def create_key(self, fields: dict, prefix: str, key_hash: str) -> dict:
        now = time.time()
        f = {k: fields.get(k) for k in KEY_FIELDS}
        f["active"] = 1 if f["active"] is None else int(bool(f["active"]))
        f["tools"] = 1 if f["tools"] is None else int(bool(f["tools"]))
        with self.lock:
            cur = self.db.execute(
                f"""INSERT INTO api_keys ({','.join(KEY_FIELDS)}, prefix, key_hash, created_at, updated_at)
                    VALUES ({','.join('?' * len(KEY_FIELDS))}, ?, ?, ?, ?)""",
                (*f.values(), prefix, key_hash, now, now))
            new_id = cur.lastrowid
        return self.get_key(new_id)

    def get_key(self, key_id: int) -> dict | None:
        rows = self._all("SELECT * FROM api_keys WHERE id = ?", (key_id,))
        return rows[0] if rows else None

    def get_key_by_hash(self, key_hash: str) -> dict | None:
        rows = self._all("SELECT * FROM api_keys WHERE key_hash = ?", (key_hash,))
        return rows[0] if rows else None

    def list_keys(self) -> list[dict]:
        return self._all("SELECT * FROM api_keys ORDER BY name COLLATE NOCASE")

    def update_key(self, key_id: int, fields: dict) -> dict | None:
        sets = {k: v for k, v in fields.items() if k in KEY_FIELDS}
        if sets:
            for b in ("active", "tools"):
                if b in sets:
                    sets[b] = int(bool(sets[b]))
            with self.lock:
                self.db.execute(
                    f"UPDATE api_keys SET {', '.join(f'{k} = ?' for k in sets)}, updated_at = ? WHERE id = ?",
                    (*sets.values(), time.time(), key_id))
        return self.get_key(key_id)

    def replace_key_secret(self, key_id: int, prefix: str, key_hash: str) -> dict | None:
        with self.lock:
            self.db.execute("UPDATE api_keys SET prefix = ?, key_hash = ?, updated_at = ? WHERE id = ?",
                            (prefix, key_hash, time.time(), key_id))
        return self.get_key(key_id)

    def delete_key(self, key_id: int) -> bool:
        """Its requests keep their key_id, so usage history survives."""
        with self.lock:
            return self.db.execute("DELETE FROM api_keys WHERE id = ?", (key_id,)).rowcount == 1

    def touch_key(self, key_id: int, ip: str | None) -> None:
        with self.lock:
            self.db.execute("UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?",
                            (time.time(), ip, key_id))

    def key_tokens_since(self, key_id: int, since: float) -> int:
        rows = self._all("""SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t
                            FROM requests WHERE key_id = ? AND ts >= ?""", (key_id, since))
        return int(rows[0]["t"])

    def key_usage(self, day: float, week: float, month: float) -> dict[int, dict]:
        """{key_id (0 = no key): {today/week/month requests and tokens, last_ts}}."""
        rows = self._all("""
            SELECT COALESCE(key_id, 0) AS key_id,
                   SUM(ts >= :d)                                            AS today_requests,
                   SUM(CASE WHEN ts >= :d THEN prompt_tokens + completion_tokens ELSE 0 END) AS today_tokens,
                   SUM(ts >= :w)                                            AS week_requests,
                   SUM(CASE WHEN ts >= :w THEN prompt_tokens + completion_tokens ELSE 0 END) AS week_tokens,
                   COUNT(*)                                                 AS month_requests,
                   SUM(prompt_tokens + completion_tokens)                   AS month_tokens,
                   SUM(prompt_tokens)                                       AS month_prompt_tokens,
                   SUM(completion_tokens)                                   AS month_completion_tokens,
                   SUM(status = 'error')                                    AS month_errors,
                   MAX(ts)                                                  AS last_ts
            FROM requests WHERE ts >= :m AND source = 'api'
            GROUP BY COALESCE(key_id, 0)""", {"d": day, "w": week, "m": month})
        return {r["key_id"]: r for r in rows}

    def key_models(self, since: float) -> dict[int, list[dict]]:
        """{key_id: [{model, requests, tokens}]} over the window, busiest first."""
        out: dict[int, list[dict]] = {}
        for r in self._all("""
                SELECT COALESCE(key_id, 0) AS key_id, model, COUNT(*) AS requests,
                       SUM(prompt_tokens + completion_tokens) AS tokens
                FROM requests WHERE ts >= ? AND source = 'api'
                GROUP BY COALESCE(key_id, 0), model ORDER BY requests DESC""", (since,)):
            out.setdefault(r["key_id"], []).append(
                {"model": r["model"], "requests": r["requests"], "tokens": r["tokens"] or 0})
        return out

    # ── admin auth ──────────────────────────────────────────
    @staticmethod
    def _hash(password: str, salt: str) -> str:
        return hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt),
                              n=2 ** 14, r=8, p=1, dklen=32).hex()

    def admin(self) -> dict | None:
        rows = self._all("SELECT username, created FROM admin WHERE id = 1")
        return rows[0] if rows else None

    def create_admin(self, username: str, password: str) -> bool:
        salt = secrets.token_hex(16)
        with self.lock:
            cur = self.db.execute(
                "INSERT OR IGNORE INTO admin (id, username, pw_hash, salt, created) VALUES (1, ?, ?, ?, ?)",
                (username, self._hash(password, salt), salt, time.time()))
            return cur.rowcount == 1

    def check_password(self, username: str | None, password: str) -> bool:
        rows = self._all("SELECT username, pw_hash, salt FROM admin WHERE id = 1")
        if not rows:
            return False
        r = rows[0]
        ok = hmac.compare_digest(self._hash(password, r["salt"]), r["pw_hash"])
        return ok and (username is None or hmac.compare_digest(username, r["username"]))

    def set_password(self, password: str) -> None:
        salt = secrets.token_hex(16)
        with self.lock:
            self.db.execute("UPDATE admin SET pw_hash = ?, salt = ? WHERE id = 1",
                            (self._hash(password, salt), salt))
            self.db.execute("DELETE FROM sessions")

    def new_session(self, ttl: float) -> str:
        token = secrets.token_urlsafe(32)
        with self.lock:
            self.db.execute("INSERT INTO sessions VALUES (?, ?)",
                            (hashlib.sha256(token.encode()).hexdigest(), time.time() + ttl))
        return token

    def valid_session(self, token: str | None) -> bool:
        if not token:
            return False
        rows = self._all("SELECT expires FROM sessions WHERE token_hash = ?",
                         (hashlib.sha256(token.encode()).hexdigest(),))
        return bool(rows) and rows[0]["expires"] > time.time()

    def end_session(self, token: str | None) -> None:
        if token:
            with self.lock:
                self.db.execute("DELETE FROM sessions WHERE token_hash = ?",
                                (hashlib.sha256(token.encode()).hexdigest(),))


_store: Store | None = None


def store() -> Store:
    global _store
    if _store is None:
        os.makedirs(os.path.dirname(os.path.abspath(config.STATS_DB)), exist_ok=True)
        _store = Store(config.STATS_DB)
    return _store
