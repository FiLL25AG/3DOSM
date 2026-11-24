"""Trwały cache z limitem rozmiaru, LRU i ochroną aktywnej sceny (docs/02, docs/05)."""
import hashlib
import json
import sqlite3
import threading
import time
from pathlib import Path


class Cache:
    def __init__(self, directory, default_limit):
        self.dir = Path(directory)
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self.db = sqlite3.connect(self.dir / "index.sqlite", check_same_thread=False)
        self.db.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS entries(
              key TEXT PRIMARY KEY, file TEXT NOT NULL, size INTEGER NOT NULL,
              source TEXT NOT NULL, fetched_at REAL NOT NULL, last_used REAL NOT NULL,
              meta TEXT NOT NULL DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS protected(key TEXT PRIMARY KEY);
            CREATE TABLE IF NOT EXISTS settings(name TEXT PRIMARY KEY, value TEXT NOT NULL);
            """
        )
        self.db.execute("INSERT OR IGNORE INTO settings VALUES('limit_bytes', ?)", (str(default_limit),))
        self.db.commit()
        self._clock = 0.0

    def _now(self):
        # Ściśle rosnący znacznik: kolejność LRU nie zależy od rozdzielczości zegara.
        self._clock = max(self._clock + 1e-6, time.time())
        return self._clock

    @staticmethod
    def _file(key):
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        return Path(digest[:2]) / digest[2:]

    def path(self, key):
        with self._lock:
            row = self.db.execute("SELECT file FROM entries WHERE key=?", (key,)).fetchone()
            if not row:
                return None
            target = self.dir / row[0]
            if not target.exists():
                self.db.execute("DELETE FROM entries WHERE key=?", (key,))
                self.db.commit()
                return None
            self.db.execute("UPDATE entries SET last_used=? WHERE key=?", (self._now(), key))
            self.db.commit()
            return target

    def get(self, key):
        target = self.path(key)
        return target.read_bytes() if target else None

    def meta(self, key):
        with self._lock:
            row = self.db.execute("SELECT meta, fetched_at, size, source FROM entries WHERE key=?", (key,)).fetchone()
        if not row:
            return None
        return {**json.loads(row[0]), "fetchedAt": row[1], "size": row[2], "source": row[3]}

    def put(self, key, data, source, meta=None):
        relative = self._file(key)
        target = self.dir / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(f".{threading.get_ident()}.tmp")
        temporary.write_bytes(data)
        temporary.replace(target)
        now = self._now()
        with self._lock:
            self.db.execute(
                "INSERT OR REPLACE INTO entries VALUES(?,?,?,?,?,?,?)",
                (key, relative.as_posix(), len(data), source, now, now, json.dumps(meta or {}, ensure_ascii=False)),
            )
            self.db.commit()
            self.evict()
        return target

    def protect(self, keys):
        """Zastępuje zbiór wpisów aktywnej sceny; te wpisy nie podlegają usuwaniu."""
        with self._lock:
            self.db.execute("DELETE FROM protected")
            self.db.executemany("INSERT OR IGNORE INTO protected VALUES(?)", [(k,) for k in keys])
            self.db.commit()
            self.evict()

    def add_protected(self, keys):
        with self._lock:
            self.db.executemany("INSERT OR IGNORE INTO protected VALUES(?)", [(k,) for k in keys])
            self.db.commit()

    def protected_keys(self):
        with self._lock:
            return [r[0] for r in self.db.execute("SELECT key FROM protected")]

    def get_setting(self, name, default=None):
        with self._lock:
            row = self.db.execute("SELECT value FROM settings WHERE name=?", (name,)).fetchone()
        return row[0] if row else default

    def set_setting(self, name, value):
        with self._lock:
            self.db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)", (name, str(value)))
            self.db.commit()

    @property
    def limit(self):
        return int(self.get_setting("limit_bytes"))

    def set_limit(self, limit):
        if limit <= 0:
            raise ValueError("Limit cache musi być dodatni")
        with self._lock:
            self.set_setting("limit_bytes", int(limit))
            self.evict()

    def evict(self):
        """Usuwa najdawniej używane wpisy poza aktywną sceną. Zwraca liczbę usuniętych."""
        removed = 0
        with self._lock:
            total = self.db.execute("SELECT COALESCE(SUM(size),0) FROM entries").fetchone()[0]
            limit = self.limit
            if total <= limit:
                return 0
            rows = self.db.execute(
                "SELECT key,file,size FROM entries WHERE key NOT IN (SELECT key FROM protected) ORDER BY last_used"
            ).fetchall()
            for key, file, size in rows:
                if total <= limit:
                    break
                (self.dir / file).unlink(missing_ok=True)
                self.db.execute("DELETE FROM entries WHERE key=?", (key,))
                total -= size
                removed += 1
            self.db.commit()
        return removed

    def stats(self):
        with self._lock:
            total, count = self.db.execute("SELECT COALESCE(SUM(size),0), COUNT(*) FROM entries").fetchone()
            protected = self.db.execute(
                "SELECT COALESCE(SUM(size),0) FROM entries WHERE key IN (SELECT key FROM protected)"
            ).fetchone()[0]
        return {"usedBytes": total, "entries": count, "protectedBytes": protected, "limitBytes": self.limit,
                "overLimitBecauseProtected": total > self.limit}
