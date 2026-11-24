"""Adapter NMT GUGiK: wybór arkuszy ze skorowidza WFS i odczyt ARC/INFO ASCII GRID.

Przyjmowane są wyłącznie arkusze, których metadane deklarują wymagany układ wysokościowy,
układ poziomy, format i rozdzielczość. Nic nie jest przeliczane ani dopasowywane po cichu.
"""
import re

import numpy as np
from shapely.geometry import Polygon, box


def parse_index(xml_text):
    sheets = []
    for chunk in re.findall(r"<gugik:SkorowidzNMT\d+ .*?</gugik:SkorowidzNMT\d+>", xml_text, flags=re.S):
        def field(name):
            match = re.search(rf"<gugik:{name}[^>]*>\s*([^<]*)", chunk)
            return match[1].strip() if match else ""

        coordinates = re.search(r"<gml:posList[^>]*>([^<]+)", chunk)[1].split()
        # Skorowidz w EPSG:2180 podaje pary (północ, wschód).
        ring = [(float(coordinates[i + 1]), float(coordinates[i])) for i in range(0, len(coordinates), 2)]
        date = re.search(r"akt_data.*?timePosition>([^<]+)", chunk, flags=re.S)[1]
        sheets.append({"sheet": field("godlo"), "date": date, "format": field("format"),
                       "resolution": field("char_przestrz"), "verticalDatum": field("uklad_h"),
                       "horizontalCrs": field("uklad_xy"), "url": field("url_do_pobrania"),
                       "verticalErrorMeters": field("blad_sr_wys"), "horizontalErrorMeters": field("blad_sr_syt"),
                       "method": field("zrodlo_danych"), "footprint": Polygon(ring).buffer(0)})
    return sheets


def select_sheets(sheets, cfg, extent):
    """Najnowsze zgodne arkusze aż do pokrycia zasięgu; zwraca wybór i niepokrytą powierzchnię."""
    usable = [s for s in sheets if s["verticalDatum"] == cfg["requiredVerticalDatum"]
              and s["horizontalCrs"] == cfg["requiredHorizontalCrs"] and s["format"] == cfg["requiredFormat"]
              and s["resolution"] == cfg["requiredResolution"]]
    usable.sort(key=lambda s: (s["date"], s["sheet"]), reverse=True)
    remaining, chosen = box(*extent), []
    for sheet in usable:
        if sheet["footprint"].intersection(remaining).area > 1000:
            chosen.append(sheet)
            remaining = remaining.difference(sheet["footprint"])
    return chosen, remaining.area


def parse_ascii_grid(data):
    head = {}
    position = 0
    for _ in range(6):
        end = data.index(b"\n", position)
        key, value = data[position:end].split()
        head[key.decode().lower()] = float(value)
        position = end + 1
    if "xllcenter" not in head or head["cellsize"] != 1.0:
        raise ValueError(f"Nieobsługiwany nagłówek ASCII GRID: {head}")
    columns, rows = int(head["ncols"]), int(head["nrows"])
    values = np.array(data[position:].split(), dtype=np.float32)
    if values.size != columns * rows:
        raise ValueError("Liczba komórek ASCII GRID nie zgadza się z nagłówkiem")
    grid = values.reshape(rows, columns)[::-1].copy()  # wiersz 0 = południe
    grid[grid == head["nodata_value"]] = np.nan
    return grid, int(round(head["xllcenter"])), int(round(head["yllcenter"]))


class NmtAdapter:
    def __init__(self, cfg, cache, fetcher):
        self.cfg, self.cache, self.fetcher = cfg, cache, fetcher

    def find_sheets(self, snapshot, extent, keys):
        west, south, east, north = extent
        sheets = []
        for year in self.cfg["years"]:
            url = (f"{self.cfg['indexUrl']}?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature"
                   f"&TYPENAMES=gugik:SkorowidzNMT{year}&COUNT=1000&SRSNAME=EPSG:2180"
                   f"&BBOX={south},{west},{north},{east},urn:ogc:def:crs:EPSG::2180")
            key = f"nmt/{snapshot}/index/{year}/{west:.0f},{south:.0f},{east:.0f},{north:.0f}"
            keys.append(key)
            data = self.cache.get(key)
            if data is None:
                data = self.fetcher.get(url)
                self.cache.put(key, data, self.cfg["id"], {"url": url})
            sheets += parse_index(data.decode("utf-8"))
        return select_sheets(sheets, self.cfg, extent)

    def load(self, sheet, keys):
        key = f"nmt/sheet/{sheet['url'].rsplit('/', 1)[-1]}"
        keys.append(key)
        data = self.cache.get(key)
        if data is None:
            data = self.fetcher.get(sheet["url"])
            self.cache.put(key, data, self.cfg["id"], {"url": sheet["url"], "date": sheet["date"]})
        return parse_ascii_grid(data)
