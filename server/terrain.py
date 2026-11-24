"""Mozaika NMT, piramida poziomów szczegółowości i kafelki wysokości."""
import io

import numpy as np

TILE_CELLS = 128
# Piramida ma stałą siatkę w układzie NMT (EPSG:2180, PL-1992), niezależną od miejsca startu: korzeń o boku 2^20 m
# (ok. 1049 km) zaczyna się w punkcie (0, 0) układu i obejmuje cały zasięg układu w Polsce. Poziom 13 ma kafle 128 m
# i komórki 1 m, jak wcześniej poziom 9 przy korzeniu 65 536 m.
ROOT_SIZE = 1048576
ROOT_WEST, ROOT_SOUTH = 0.0, 0.0
MAX_LEVEL = 13
OK, INTERPOLATED, MISSING = 0, 1, 2
MAX_FILL_DISTANCE = 3  # komórki 1 m; większe luki pozostają jawnym brakiem danych


def _neighbour_mean(height):
    stack = np.full((4,) + height.shape, np.nan, dtype=np.float32)
    stack[0, 1:, :] = height[:-1, :]
    stack[1, :-1, :] = height[1:, :]
    stack[2, :, 1:] = height[:, :-1]
    stack[3, :, :-1] = height[:, 1:]
    valid = np.isfinite(stack)
    count = valid.sum(axis=0)
    total = np.where(valid, stack, 0).sum(axis=0)
    return np.divide(total, count, out=np.full(height.shape, np.nan, dtype=np.float32), where=count > 0)


class Terrain:
    def __init__(self, height, flags, source, west, south):
        self.height, self.flags, self.source = height, flags, source
        self.west, self.south = west, south
        self.levels = None

    @classmethod
    def mosaic(cls, extent, grids):
        """Składa arkusze według kolejności (pierwszy ma pierwszeństwo) i porównuje ich zakładki."""
        west, south, east, north = extent
        height = np.full((north - south + 1, east - west + 1), np.nan, dtype=np.float32)
        source = np.full(height.shape, 255, dtype=np.uint8)
        differences = []
        for index, (grid, grid_west, grid_south) in enumerate(grids):
            x0, y0 = max(west, grid_west), max(south, grid_south)
            x1 = min(east, grid_west + grid.shape[1] - 1)
            y1 = min(north, grid_south + grid.shape[0] - 1)
            if x1 < x0 or y1 < y0:
                continue
            target = height[y0 - south:y1 - south + 1, x0 - west:x1 - west + 1]
            incoming = grid[y0 - grid_south:y1 - grid_south + 1, x0 - grid_west:x1 - grid_west + 1]
            both = np.isfinite(target) & np.isfinite(incoming)
            if both.any():
                differences.append((target[both] - incoming[both]))
            take = ~np.isfinite(target) & np.isfinite(incoming)
            target[take] = incoming[take]
            source[y0 - south:y1 - south + 1, x0 - west:x1 - west + 1][take] = index
        flags = np.where(np.isfinite(height), OK, MISSING).astype(np.uint8)
        for _ in range(MAX_FILL_DISTANCE):
            mean = _neighbour_mean(height)
            fill = ~np.isfinite(height) & np.isfinite(mean)
            if not fill.any():
                break
            height[fill] = mean[fill]
            flags[fill] = INTERPOLATED
        joined = np.concatenate(differences) if differences else np.zeros(0)
        seams = {"overlapCells": int(joined.size)}
        if joined.size:
            absolute = np.abs(joined)
            seams.update(medianAbsMeters=round(float(np.median(absolute)), 3),
                         p99AbsMeters=round(float(np.percentile(absolute, 99)), 3),
                         maxAbsMeters=round(float(absolute.max()), 3))
        return cls(height, flags, source, west, south), seams

    def extent(self):
        rows, columns = self.height.shape
        return self.west, self.south, self.west + columns - 1, self.south + rows - 1

    def to_bytes(self):
        buffer = io.BytesIO()
        np.savez(buffer, height=self.height, flags=self.flags, source=self.source,
                 origin=np.array([self.west, self.south]))
        return buffer.getvalue()

    @classmethod
    def from_file(cls, path):
        with np.load(path) as data:
            return cls(data["height"], data["flags"], data["source"], int(data["origin"][0]), int(data["origin"][1]))

    def sample(self, east, north):
        """Interpolacja dwuliniowa; poza danymi zwraca NaN."""
        x = np.asarray(east, dtype=float) - self.west
        y = np.asarray(north, dtype=float) - self.south
        rows, columns = self.height.shape
        x0 = np.floor(x).astype(int)
        y0 = np.floor(y).astype(int)
        inside = (x0 >= 0) & (y0 >= 0) & (x0 < columns - 1) & (y0 < rows - 1)
        result = np.full(x.shape, np.nan, dtype=float)
        i, j, u, v = x0[inside], y0[inside], x[inside] - x0[inside], y[inside] - y0[inside]
        h = self.height
        result[inside] = (h[j, i] * (1 - u) * (1 - v) + h[j, i + 1] * u * (1 - v)
                          + h[j + 1, i] * (1 - u) * v + h[j + 1, i + 1] * u * v)
        return result

    def source_at(self, east, north):
        col, row = int(round(east - self.west)), int(round(north - self.south))
        if 0 <= row < self.source.shape[0] and 0 <= col < self.source.shape[1]:
            value = int(self.source[row, col])
            return None if value == 255 else value
        return None

    def coverage(self, inside_mask_fn, stride=4):
        rows, columns = self.height.shape
        ys, xs = np.mgrid[0:rows:stride, 0:columns:stride]
        mask = inside_mask_fn(xs + self.west, ys + self.south)
        flags = self.flags[ys[mask], xs[mask]]
        total = int(flags.size)
        return {"sampledCellsInPolygon": total, "stride": stride,
                "measuredPercent": round(100 * float((flags == OK).sum()) / total, 4),
                "interpolatedPercent": round(100 * float((flags == INTERPOLATED).sum()) / total, 4),
                "missingPercent": round(100 * float((flags == MISSING).sum()) / total, 4)}

    def build_levels(self):
        """Piramida: każdy poziom to średnia 2×2 poprzedniego, z pominięciem braków."""
        height, flags = self.height, self.flags
        self.levels = [(height, flags)]
        for _ in range(MAX_LEVEL):
            rows, columns = height.shape[0] // 2, height.shape[1] // 2
            if rows < 2 or columns < 2:
                break
            blocks = height[:rows * 2, :columns * 2].reshape(rows, 2, columns, 2)
            valid = np.isfinite(blocks)
            count = valid.sum(axis=(1, 3))
            total = np.where(valid, blocks, 0).sum(axis=(1, 3))
            height = np.divide(total, count, out=np.full((rows, columns), np.nan, dtype=np.float32), where=count > 0)
            flag_blocks = flags[:rows * 2, :columns * 2].reshape(rows, 2, columns, 2)
            flags = flag_blocks.max(axis=(1, 3)).astype(np.uint8)
            flags[count > 0] = np.minimum(flags[count > 0], INTERPOLATED)
            self.levels.append((height.astype(np.float32), flags))

    def tile(self, z, x, y, root=(ROOT_WEST, ROOT_SOUTH)):
        """Kafel (TILE_CELLS+1)² próbek: float32 wysokości + uint8 flagi; None, gdy pusty. root: lewy dolny róg korzenia."""
        if not 0 <= z <= MAX_LEVEL or not (0 <= x < 2 ** z and 0 <= y < 2 ** z):
            raise ValueError("Niepoprawny kafel")
        size = ROOT_SIZE / 2 ** z
        step = size / TILE_CELLS
        level = min(int(round(np.log2(step))), len(self.levels) - 1)
        height, flags = self.levels[level]
        cell = 2 ** level
        west = root[0] + x * size
        south = root[1] + y * size
        axis = np.arange(TILE_CELLS + 1)
        # Środek komórki poziomu leży w (i + 0,5)·cell − 0,5 m od początku siatki 1 m.
        u = (west + axis * step - self.west + 0.5) / cell - 0.5
        v = (south + axis * step - self.south + 0.5) / cell - 0.5
        grid_v, grid_u = np.meshgrid(v, u, indexing="ij")
        rows, columns = height.shape
        i0, j0 = np.floor(grid_u).astype(int), np.floor(grid_v).astype(int)
        fu, fv = grid_u - i0, grid_v - j0
        nearest_i, nearest_j = np.rint(grid_u).astype(int), np.rint(grid_v).astype(int)
        inside = (nearest_i >= 0) & (nearest_j >= 0) & (nearest_i < columns) & (nearest_j < rows)
        total = np.zeros(grid_u.shape)
        weight = np.zeros(grid_u.shape)
        for di, dj, w in ((0, 0, (1 - fu) * (1 - fv)), (1, 0, fu * (1 - fv)), (0, 1, (1 - fu) * fv), (1, 1, fu * fv)):
            sample = height[np.clip(j0 + dj, 0, rows - 1), np.clip(i0 + di, 0, columns - 1)]
            valid = np.isfinite(sample)
            total += np.where(valid, sample * w, 0)
            weight += np.where(valid, w, 0)
        result = np.full(grid_u.shape, np.nan, dtype=np.float32)
        state = np.full(grid_u.shape, MISSING, dtype=np.uint8)
        usable = inside & (weight > 1e-9)
        result[usable] = (total[usable] / weight[usable]).astype(np.float32)
        state[inside] = flags[nearest_j[inside], nearest_i[inside]]
        if not np.isfinite(result).any():
            return None
        return result.tobytes() + state.tobytes()
