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
"""

COLUMNS = ("ts", "requested", "model", "provider", "stream", "status", "fallback",
           "latency_ms", "ttft_ms", "prompt_tokens", "completion_tokens", "turns",
           "tool_calls", "tools", "error", "client", "source")


class Store:
    def __init__(self, path: str):
        self.path = path
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript(SCHEMA)
        self._last_purge = 0.0
        self.purge()

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
               model: str | None = None, status: str | None = None) -> list[dict]:
        where, args = ["1=1"], []
        if before_id:
            where.append("id < ?"); args.append(before_id)
        if model:
            where.append("model = ?"); args.append(model)
        if status:
            where.append("status = ?"); args.append(status)
        args.append(max(1, min(limit, 500)))
        return self._all(
            f"SELECT * FROM requests WHERE {' AND '.join(where)} ORDER BY id DESC LIMIT ?", args)

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
