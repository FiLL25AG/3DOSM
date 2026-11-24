// WGS84 → EPSG:2180 po stronie klienta, używane wyłącznie do wyszukiwania po współrzędnych.
// Odwzorowanie Gaussa-Krügera (GRS80, λ0=19°, k=0,9993); zgodność z PROJ sprawdza test.
const A = 6378137, F = 1 / 298.257222101, K0 = 0.9993, LON0 = (19 * Math.PI) / 180, FE = 500000, FN = -5300000;
const N = F / (2 - F);
const RECT = (A / (1 + N)) * (1 + (N ** 2) / 4 + (N ** 4) / 64);
const ALPHA = [N / 2 - (2 * N ** 2) / 3 + (5 * N ** 3) / 16, (13 * N ** 2) / 48 - (3 * N ** 3) / 5, (61 * N ** 3) / 240];

export function wgs84ToPl1992(lon, lat) {
  const phi = (lat * Math.PI) / 180, lambda = (lon * Math.PI) / 180 - LON0;
  const e = Math.sqrt(F * (2 - F));
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - e * Math.atanh(e * Math.sin(phi)));
  const xi = Math.atan2(t, Math.cos(lambda));
  const eta = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t));
  let x = xi, y = eta;
  ALPHA.forEach((a, index) => {
    const j = 2 * (index + 1);
    x += a * Math.sin(j * xi) * Math.cosh(j * eta);
    y += a * Math.cos(j * xi) * Math.sinh(j * eta);
  });
  return [FE + K0 * RECT * y, FN + K0 * RECT * x];
}
