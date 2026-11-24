"""Serwer HTTP prototypu (tylko 127.0.0.1): pliki aplikacji i API danych."""
import argparse
import gzip
import json
import mimetypes
import sys
import threading
import traceback
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import jsonschema

from .adapters.osm import new_store, parse_osm
from .cache import Cache
from .config import ROOT, load_sources
from .http_client import Fetcher
from .pipeline import SceneBuilder
from .terrain import MAX_LEVEL, ROOT_SIZE, ROOT_SOUTH, ROOT_WEST, TILE_CELLS, Terrain
from .tiles import TileStore, merge_tiles

WEB = ROOT / "web"
PROFILE = ROOT / "profiles" / "pl" / "profile.json"
SCHEMA = ROOT / "profiles" / "schema" / "country-profile.v1.schema.json"
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("application/json", ".json")


def load_profile():
    """Profil trafia do klienta wyłącznie po przejściu walidacji schematem."""
    profile = json.loads(PROFILE.read_text(encoding="utf-8"))
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    jsonschema.Draft202012Validator.check_schema(schema)
    jsonschema.validate(profile, schema, cls=jsonschema.Draft202012Validator)
    ids = [rule["id"] for rule in profile["rules"]]
    if len(ids) != len(set(ids)):
        raise ValueError("Identyfikatory reguł profilu muszą być unikalne")
    return profile


class State:
    def __init__(self, directory=None):
        self.config = load_sources()
        cache_dir = directory or ROOT / self.config["cache"]["directory"]
        self.cache = Cache(cache_dir, self.config["cache"]["defaultLimitBytes"])
        self.fetcher = Fetcher(self.config["client"])
        self.lock = threading.Lock()
        self.terrain = None
        self.snapshot = None
        self.status = {"state": "idle", "message": "", "error": None, "refreshing": False}
        self.tiles = None

    def activate(self, snapshot):
        path = self.cache.path(f"scene/{snapshot}/terrain")
        terrain = Terrain.from_file(path)
        terrain.build_levels()
        manifest = json.loads(self.cache.get(f"scene/{snapshot}/manifest"))
        with self.lock:
            self.terrain, self.snapshot, self.manifest = terrain, snapshot, manifest
            if self.tiles is None:
                # Kafle danych używają początku układu aktywnej sceny, więc współrzędne lokalne są wspólne.
                self.tiles = TileStore(self.config, self.cache, self.fetcher, lambda: (self.manifest["origin"]["east"], self.manifest["origin"]["north"]))
        self.cache.set_setting("active_snapshot", snapshot)
        self.cache.protect(json.loads(self.cache.get_setting(f"keys:{snapshot}")))

    def _set(self, **values):
        with self.lock:
            self.status.update(values)

    def start_build(self, refresh=False):
        with self.lock:
            if self.status["state"] == "building":
                return False
            self.status.update(state="building", message="Start", error=None, refreshing=refresh)
        threading.Thread(target=self._build, daemon=True).start()
        return True

    def _build(self):
        snapshot = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        try:
            def progress(message):
                print(message, flush=True)
                self._set(message=message)

            builder = SceneBuilder(self.config, self.cache, self.fetcher, progress)
            # Dane budowanej migawki chronione są dopiero po aktywacji; aktywna scena pozostaje nietknięta.
            builder.build(snapshot)
            self._set(message="Piramida terenu")
            self.activate(snapshot)
            self._set(state="ready", message="Gotowe", refreshing=False)
        except Exception as error:  # noqa: BLE001 - błąd ma trafić do interfejsu, a aktywna scena zostaje
            traceback.print_exc()
            self._set(state="ready" if self.snapshot else "error", message="", error=str(error), refreshing=False)

    def locate(self, kind, osm_id):
        """Położenie dowolnego elementu OSM do nawigacji; odczyt bez wpływu na scenę."""
        if kind not in ("node", "way", "relation") or not osm_id.isdigit():
            raise ValueError("Niepoprawny identyfikator OSM")
        suffix = "" if kind == "node" else "/full"
        key = f"osm/locate/{kind}/{osm_id}"
        data = self.cache.get(key)
        if data is None:
            data = self.fetcher.get(f"{self.config['osm']['apiBase']}/{kind}/{osm_id}{suffix}")
            self.cache.put(key, data, self.config["osm"]["id"])
        store = new_store()
        parse_osm(data, store)
        if not store["node"]:
            raise ValueError("Element nie ma geometrii")
        lons = [n["lon"] for n in store["node"].values()]
        lats = [n["lat"] for n in store["node"].values()]
        return {"type": kind, "id": int(osm_id), "lon": sum(lons) / len(lons), "lat": sum(lats) / len(lats)}

    def start(self):
        snapshot = self.cache.get_setting("active_snapshot")
        if snapshot and self.cache.path(f"scene/{snapshot}/manifest"):
            self.activate(snapshot)
            self._set(state="ready", message="Gotowe")
        else:
            self.start_build()


class Handler(BaseHTTPRequestHandler):
    state = None
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _send(self, code, body=b"", content_type="application/json; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, value, code=200):
        self._send(code, json.dumps(value, ensure_ascii=False).encode("utf-8"))

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        try:
            if path.startswith("/api/"):
                self._api(path)
            else:
                self._static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as error:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": str(error)}, 500)

    do_HEAD = do_GET

    def _api(self, path):
        state = self.state
        parts = path.strip("/").split("/")
        if path == "/api/status":
            with state.lock:
                status = dict(state.status, snapshot=state.snapshot)
            return self._json({**status, "cache": state.cache.stats()})
        if path == "/api/profile":
            try:
                return self._json(load_profile())
            except (jsonschema.ValidationError, ValueError) as error:
                return self._json({"error": f"Profil niezgodny ze schematem: {error}"}, 422)
        if path == "/api/locations":
            return self._json(state.config["scene"]["testLocations"])
        if len(parts) == 4 and parts[:2] == ["api", "locate"]:
            return self._json(state.locate(parts[2], parts[3]))
        if state.snapshot is None:
            return self._json({"error": "Scena nie jest gotowa"}, 503)
        snapshot = state.snapshot
        if path == "/api/scene/manifest":
            manifest = json.loads(state.cache.get(f"scene/{snapshot}/manifest"))
            # Piramida terenu ma stałą siatkę w układzie PL-1992; klient dostaje róg korzenia w układzie lokalnym.
            origin = manifest["origin"]
            manifest["tiles"] = {"rootSize": ROOT_SIZE, "cells": TILE_CELLS, "maxLevel": MAX_LEVEL,
                                 "rootWest": ROOT_WEST - origin["east"], "rootSouth": ROOT_SOUTH - origin["north"]}
            manifest["dataTiles"] = {"cellDegrees": state.config["osm"]["cellDegrees"]}
            return self._json(manifest)
        query = dict(part.split("=", 1) for part in self.path.split("?", 1)[1].split("&") if "=" in part) if "?" in self.path else {}
        origin = (state.manifest["origin"]["east"], state.manifest["origin"]["north"])
        if path == "/api/tiles/near":
            # Kafle 3×3 wokół punktu (współrzędne lokalne); brakujące trafiają do kolejki budowy.
            east, north = origin[0] + float(query["x"]), origin[1] + float(query["y"])
            keys = state.tiles.keys_near(east, north, int(query.get("r", 1)))
            infos = [state.tiles.request(key) for key in keys]
            for info in infos:
                if info["ready"]:
                    state.tiles.terrain((info["i"], info["j"]))
            return self._json({"tiles": infos})
        if len(parts) == 5 and parts[:2] == ["api", "tiles"] and parts[4] == "features":
            data = state.tiles.features((int(parts[2]), int(parts[3])))
            if data is None:
                return self._json({"error": "Kafel nie jest gotowy"}, 404)
            if "gzip" in self.headers.get("Accept-Encoding", ""):
                return self._send(200, data, extra={"Content-Encoding": "gzip"})
            return self._send(200, gzip.decompress(data))
        if len(parts) == 4 and parts[:2] == ["api", "scene"] and parts[2] == "features" and parts[3] in ("core", "detail"):
            data = state.cache.get(f"scene/{snapshot}/{parts[3]}")
            if "gzip" in self.headers.get("Accept-Encoding", ""):
                return self._send(200, data, extra={"Content-Encoding": "gzip"})
            return self._send(200, gzip.decompress(data))
        if len(parts) == 5 and parts[:2] == ["api", "terrain"]:
            origin = (state.manifest["origin"]["east"], state.manifest["origin"]["north"])
            z, x, y = int(parts[2]), int(parts[3]), int(parts[4])
            size = ROOT_SIZE / 2 ** z
            west, south = ROOT_WEST + x * size, ROOT_SOUTH + y * size
            # Teren kafli danych (w pamięci) ma pierwszeństwo; mozaika pierwszej sceny uzupełnia brakujące miejsca.
            sources = [t for t in list(state.tiles.terrains.values()) if _overlaps(t.extent(), (west, south, west + size, south + size))]
            parts_ = [t.tile(z, x, y) for t in sources] + [state.terrain.tile(z, x, y)]
            tile = merge_tiles(parts_)
            return self._send(204) if tile is None else self._send(200, tile, "application/octet-stream")
        self._json({"error": "Nie znaleziono"}, 404)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}") if length else {}
        try:
            if self.path == "/api/cache/limit":
                self.state.cache.set_limit(int(body["bytes"]))
                return self._json(self.state.cache.stats())
            if self.path == "/api/refresh":
                return self._json({"started": self.state.start_build(refresh=True)}, 202)
            if self.path == "/api/tiles/refresh":
                # Ręczne odświeżenie wskazanych kafli: OSM pobierany ponownie, poprzednia wersja działa do czasu gotowości nowej.
                keys = [(int(i), int(j)) for i, j in body["tiles"]][:25]
                return self._json({"tiles": [self.state.tiles.request(key, refresh=True) for key in keys]}, 202)
            self._json({"error": "Nie znaleziono"}, 404)
        except (KeyError, ValueError) as error:
            self._json({"error": str(error)}, 400)

    def _static(self, path):
        relative = "index.html" if path == "/" else path.lstrip("/")
        target = (WEB / relative).resolve()
        if not target.is_relative_to(WEB.resolve()) or not target.is_file():
            return self._send(404, b"Nie znaleziono", "text/plain; charset=utf-8")
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self._send(200, target.read_bytes(), content_type)


def _overlaps(a, b):
    return a[0] <= b[2] and b[0] <= a[2] and a[1] <= b[3] and b[1] <= a[3]


def main():
    # Konsola Windows bywa w cp1252; polskie komunikaty nie mogą przerywać pracy serwera.
    sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    parser = argparse.ArgumentParser(description="Prototyp 3D OSM")
    parser.add_argument("--port", type=int, default=8473)
    args = parser.parse_args()
    state = State()
    load_profile()
    state.start()
    Handler.state = state
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"3D OSM: http://127.0.0.1:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()


__all__ = ["Path", "State", "Handler", "load_profile"]
