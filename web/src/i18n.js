// Teksty interfejsu w jednym miejscu, aby można było dodać kolejne języki.
const pl = {
  search: "Nazwa, „52.21, 21.09” lub way 123", go: "Szukaj", places: "Miejsca testowe…", north: "Północ", top: "Z góry",
  lockNorth: "Blokada północy", layers: "Warstwy i ustawienia", layersTitle: "Warstwy", allRouteLines: "Wszystkie linie przebiegu", referenceTitle: "Warstwy niedostępne",
  viewTitle: "Widok", terrain: "Relief i paleta wysokości", detail: "Szczegółowość i zasięg", exaggeration: "Wyolbrzymienie pionowe",
  dataTitle: "Dane i cache", refresh: "Odśwież źródła", perf: "Pomiar wydajności", cacheLimit: "Limit cache (GB)", save: "Zapisz",
  inspector: "Inspektor i diagnostyka", noSelection: "Kliknij obiekt na mapie albo wynik diagnostyki.",
  tags: "Tagi", key: "Klucz", source: "Źródło", current: "Bieżąca", addKey: "nowy klucz", addValue: "wartość", add: "Dodaj",
  undo: "Cofnij", redo: "Przywróć", restoreObject: "Przywróć obiekt", localOnly: "Zmiany są lokalne dla tej sesji i nie trafiają do OSM.",
  interpretation: "Interpretacja", rules: "Reguły profilu", levels: "Poziom i wymiary", uncertain: "Niepewności", suggestions: "Tagi do rozważenia",
  relations: "Relacje", provenance: "Pochodzenie danych", issues: "Problemy obiektu", diagnostics: "Diagnostyka", markers: "Znaczniki na mapie",
  physical: "Kolizje fizyczne", context: "Anomalie kontekstowe", missing: "Brakujące tagi/wysokości", uncertainCat: "Inne niepewności",
  stay: "Zostań przy bieżących danych", discard: "Odrzuć zmiany i odśwież",
  refreshTitle: "Masz lokalne zmiany tagów", refreshBody: (n) => `Zmienione obiekty: ${n}. Odświeżenie źródeł wczyta nowe dane i usunie te zmiany.`,
};
export const t = (key, ...args) => { const value = pl[key] ?? key; return typeof value === "function" ? value(...args) : value; };
