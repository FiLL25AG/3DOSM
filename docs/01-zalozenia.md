# Założenia i decyzje projektu

**Status:** wersja robocza 0.1  
**Cel:** zebrać ustalony kierunek przed projektowaniem technicznym i implementacją.

## Cel

Zbudować własny silnik map 3D do eksploracji, analizy i symulacji przestrzeni. System ma łączyć widok całej Ziemi z dokładnym widokiem lokalnym, używając danych OSM, wysokości terenu oraz — tam, gdzie będą dostępne i przydatne — danych LiDAR.

## Ustalone założenia

| Obszar | Ustalenie |
|---|---|
| Zasięg docelowy | Globalny, rozszerzany przez wymienne profile krajowe |
| Pierwszy pełny profil | Polska |
| Pierwszy obszar prototypu | Warszawa i okolice |
| Silnik 3D | Własny, oparty na Three.js |
| Widok Ziemi | Hybrydowy: globus oraz lokalny widok terenu z płynnym przejściem |
| Dane w widoku globusa | Uproszczona prezentacja Ziemi; szczegółowe OSM i teren tylko w obszarze prototypu |
| Dane wysokościowe | DEM/NMT i, zależnie od dostępności, NMPT oraz LiDAR |
| LiDAR | Wykorzystywany tam, gdzie dane są dostępne i mają uzasadnioną jakość/zastosowanie |
| Łączność | Aplikacja online z cache’em; tryb offline poza pierwszym zakresem |
| Wygląd | Hybrydowy: naturalny, czytelny i technicznie precyzyjny |
| Język interfejsu | Polski w pierwszym prototypie; możliwość dodania języków później |
| Urządzenia | Desktop jako priorytet; pozostałe urządzenia w ograniczonym zakresie |
| Tryb realizacji | Prototyp techniczny przed szerszą implementacją |

## Zasady projektowe

1. **Wspólny silnik, lokalna wiedza.** Wspólne mechanizmy geograficzne i renderujące nie mogą zakładać, że wszystkie kraje mają te same źródła danych, konwencje tagowania lub symbole.
2. **Dane źródłowe pozostają wierne.** Oryginalne tagi, geometria, relacje i identyfikatory OSM są zachowywane. Interpretacja nie nadpisuje danych wejściowych.
3. **Interpretacja i wygląd to osobne kroki.** Profil kraju interpretuje dane według jawnych reguł; styl kartograficzny decyduje, jak je pokazać.
4. **Nieznane przypadki są jawne.** Nieznane lub niejednoznaczne tagi nie są po cichu zgadywane. Mogą otrzymać neutralny wygląd i zostać odnotowane do dalszej analizy.
5. **Źródła danych są konfigurowalne.** Dostawcy i adresy usług nie są na stałe zaszywane w ogólnym silniku.
6. **Najpierw sprawdzamy ryzyka.** Prototyp ma zweryfikować trudne elementy — georeferencję, teren, geometrię i wydajność — zanim zakres urośnie.

## Poza pierwszym zakresem

- pełne dane OSM i wysokościowe dla całego świata oraz pełna obsługa wszystkich państw;
- działanie offline;
- zatwierdzony wybór formatów kafelków, dostawców danych i algorytmów;
- pełny edytor zapisujący/publikujący zmiany bezpośrednio do OSM oraz publikowanie własnych konfiguracji; lokalna sesyjna edycja tagów z podglądem na żywo jest częścią prototypu.

Te elementy mogą wrócić po prototypie i uzupełnieniu decyzji wymienionych w [planie i otwartych decyzjach](05-plan-i-otwarte-decyzje.md).
