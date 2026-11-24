# Inwentaryzacja źródeł danych i scenariuszy testowych

**Stan przeglądu:** 18 listopada 2026  
**Status:** lista kandydatów i ról; nie jest jeszcze zamkniętym wyborem usług ani pakietów danych.

## Wstępny podział źródeł

| Źródło | Rola w prototypie | Potwierdzone informacje | Do potwierdzenia dla obszaru testowego |
|---|---|---|---|
| OpenStreetMap | Główna geometria i semantyka obiektów; lokalna sesja edycji | Dane OSM są dostępne na licencji ODbL i wymagają widocznego przypisania autorstwa oraz informacji o licencji. | Obiekty i relacje dla wszystkich punktów testowych; zasady źródła danych i cache; prawidłowy sposób linkowania do elementu. |
| GUGiK NMT | Bazowa powierzchnia gruntu | Geoportal opisuje model 1 m jako podstawowy, a także udostępnia siatkę 5 m; produkty są publikowane w różnych układach wysokościowych. | Dostępne arkusze, data opracowania, jakość, format i układ dla całego obszaru Warszawa–Zielonka–Marki. |
| GUGiK NMPT | Lokalna kontrola powierzchni i wysokości obiektów | Obejmuje powierzchnię terenu wraz z obiektami ponad gruntem; Geoportal podaje siatkę 0,5 m w miastach i 1 m poza nimi. | Pokrycie i data arkuszy w punktach testowych; format oraz sposób pobrania i lokalnego przygotowania. |
| GUGiK LiDAR/ALS | Lokalna weryfikacja i uszczegóławianie; analiza podpór, budynków i obiektów inżynierskich | Pliki LAS/LAZ mogą zawierać klasy punktów i intensywność. Opisana klasyfikacja rozróżnia m.in. grunt, roślinność, budynki/budowle i wodę. Dane występują w różnych układach wysokościowych i latach pozyskania. | Gęstość, rok, zasięg, klasyfikacja, format, rozmiar arkuszy i układ wysokościowy w każdym miejscu testowym. |
| GUGiK ortofotomapa | Opcjonalna warstwa porównawcza, domyślnie wyłączona | Geoportal udostępnia obrazy o różnej aktualności i rozdzielczości, również przez usługi mapowe i pobieranie. | Najnowszy dostępny obraz dla całego obszaru testowego, jego rozdzielczość, datę, licencję/atrybucję i technikę kafelkowania. |
| BDOT10k | Referencja hydrografii w prototypie | Dostępne są usługi przeglądania i pakiety danych, w tym GPKG/GeoParquet. | Klasy hydrografii, aktualność i dokładność w obszarze testowym; warunki wykorzystania przypisane do produktów. |
| MPHP10k — Wody Polskie | Referencja sieci hydrograficznej | Zbiór opisuje sieć hydrograficzną i podział hydrograficzny; dostępna jest usługa WMS. Metadane zbioru wskazują stan danych z 2 stycznia 2024 r. | Aktualność bieżącej usługi/zbioru, dokładność geometrii rzeki Długiej i pozostałych cieków, format wektorowy oraz warunki wykorzystania. |

## Uzgodniona kolejność użycia

1. **OSM** pozostaje główną edytowalną geometrią obiektów.
2. **NMT** dostarcza bazową powierzchnię gruntu.
3. **NMPT i LiDAR** służą do lokalnej weryfikacji lub uszczegóławiania, bez automatycznego nadpisywania obiektów OSM.
4. **BDOT10k i MPHP10k** są źródłami referencyjnymi hydrografii. Brakujące w OSM obiekty można pokazać osobno i oznaczyć „brak w OSM”.
5. **Ortofotomapa** pozostaje włączana na żądanie, z widoczną datą i rozdzielczością.

Metadane źródła, daty, rozdzielczości i układy odniesienia pozostają przy warstwie. Rozbieżności są raportowane, a nie rozstrzygane przez ciche zastępowanie jednego źródła drugim.

## Obszar i scenariusze testowe

Obszar ma być ciągły i obejmować Warszawę, Zielonkę oraz Marki. Najpierw badamy poziomy i kolizje przy Moście Siekierkowskim, rondzie Marsa, wiaduktach w kierunku ulicy Żołnierskiej oraz przejściach nadziemnych/podziemnych. Następnie badamy lokalne mosty i ścieżki przy rzece Długiej, wiadukty w rejonie Zielonki i Marek oraz grupowanie części i dachy budynków na przykładzie PKiN.

### Roboczy zasięg inwentaryzacji danych

Na potrzeby sprawdzenia pokrycia źródeł przyjmujemy tymczasową prostokątną obwiednię w WGS84: **długość geograficzna 20.96–21.20°E, szerokość geograficzna 52.19–52.36°N**. Obejmuje ona wszystkie uzgodnione miejsca oraz obszar między nimi. To obwiednia do wyszukiwania arkuszy, nie ostateczny zasięg renderowania ani granica pobierania danych; po potwierdzeniu punktów testowych należy zastąpić ją ciągłym poligonem/korytarzem z buforem, ograniczającym niepotrzebne dane.

Geoportal GUGiK udostępnia skorowidze arkuszy NMT przez WFS, a identyfikacja arkusza zawiera metadane i link pobrania. Wyszukiwarka danych wysokościowych pozwala filtrować NMT/NMPT/ALS m.in. według układu, formatu, roku, błędu wysokości i zasięgu mapy; dla ortofotomapy dostępne są filtry roku i rozmiaru piksela. Jednorazowy wycinek NMT pobierany narzędziem WCS ma limit 7 km², więc dla większego obszaru należy użyć skorowidza i pobrać odpowiednie arkusze lub zaplanować partiami. Dla NMT i ALS trzeba wybrać zgodny układ wysokościowy po sprawdzeniu dostępnych arkuszy; nie mieszać wysokości z różnych układów bez jawnej transformacji.

### Wstępny wynik skorowidzów GUGiK

Sprawdzenie wykonano 18 listopada 2026 r. na indeksach WFS dla lat 2018–2026, używając prostokątnego zapytania roboczego w układzie EPSG:2180 (X 630 000–655 000, Y 475 000–505 000), przybliżającego obwiednię WGS84 powyżej. Są to liczby rekordów skorowidza przecinających ten prostokąt, a nie liczba unikalnych arkuszy po deduplikacji ani potwierdzenie kompletnego pokrycia poligonu prototypu. Należy je ponowić dla dokładnie przeliczonego poligonu.

| Zbiór | Wynik dla obszaru roboczego | Wniosek do prototypu |
|---|---|---|
| NMT | Rekordy: 2019 — 300, 2020 — 192, 2021 — 208, 2022 — 128, 2023 — 192, 2024 — 98, 2025 — 151, 2026 — 2; 2018 — brak. Dostępne wpisy obejmują różne rozdzielczości, daty i źródła. W 2026 r. dwa arkusze N-34-86-B-c-3-1 i N-34-86-B-c-4-1 mają siatkę 1 m, datę 21.04.2026, źródło skaning laserowy i błąd średni wysokości 0,07 m. | NMT 2026 nie pokrywa całej obwiedni. Dla każdego miejsca trzeba wybrać aktualny arkusz i porównać go z alternatywami 1 m/5 m; nie ustalać jednego rocznika dla całego obszaru. |
| NMPT | Rekordy: 2019 — 93 (1 m), 2022 — 128 (0,5 m i 1 m), 2024 — 74 (0,5 m i 1 m), 2026 — 2 (0,5 m); brak wpisów dla 2020–2021, 2023 i 2025. Dwa wpisy z 2026 r. mają datę 21.04.2026 i układ wysokościowy PL-EVRF2007-NH. | Dla wybranych miejsc należy zestawić NMPT z NMT i LiDAR według przecięcia geometrii, daty oraz rozdzielczości. GUGiK nie udostępnia usługi przeglądania NMPT; wykorzystanie wymaga samodzielnego przetworzenia pobranych danych. |
| LiDAR/ALS | Rekordy: 2019 — 346 przy 4 pkt/m²; 2022 — co najmniej 500 (indeks ma kolejną stronę), przy 4 i 12 pkt/m²; 2024 — 398 przy 4 i 12 pkt/m²; 2026 — 16 przy 12 pkt/m², data 21.04.2026 i błąd średni wysokości 0,07 m. W indeksie EVRF2007 brak wpisów dla 2018, 2020–2021, 2023 i 2025. | LiDAR 2026 jest aktualnym kandydatem do kontroli konstrukcji i kolizji w części obszaru; trzeba sprawdzić geometrię zasięgu poszczególnych plików LAZ oraz klasyfikację przed oceną kompletności. |
| Ortofotomapa | Rekordy: 2022 — 15 (0,05 m); 2023 — 384 (0,25 m); 2024 — 122 (0,05–0,25 m); 2025 — 302 (0,25 m); 2026 — 2 (0,05 m, zdjęcia z 21.04.2026). Dwa arkusze 2026 wskazują pliki o wielkości około 863–864 MB każdy. | Ortofotomapa pozostaje opcjonalna i wyłączona domyślnie. Najnowsze dwa arkusze są bardzo duże, więc do prototypu należy pobrać/odczytać tylko zakres scenariuszy i zweryfikować zasady korzystania z usług przed ustawieniem cache. |

Wszystkie powyższe wysokościowe rekordy sprawdzono w skorowidzach układu **PL-EVRF2007-NH** (poziomo PL-1992). Jest to przyjęty roboczy układ wysokościowy pierwszego prototypu. Nadal trzeba potwierdzić jawne transformacje, kompletność pokrycia oraz zgodność wysokości pomiędzy NMT, NMPT, ALS i OSM. Nie pobierano plików rastrowych, ortofotomapy ani LAZ.

### Wstępny wynik sprawdzenia hydrografii

- GUGiK udostępnia klasy BDOT10k osobno w formatach GPKG i GeoParquet, a także pełną paczkę krajową. Dla referencji hydrograficznej należy w pierwszej kolejności sprawdzić klasy osi rzek/strumieni `OT_SWRS_L`, kanałów `OT_SWKN_L`, rowów `OT_SWRM_L` i wód powierzchniowych `OT_PTWP_A`. Zakres, daty i wersje danych dla Mazowsza trzeba sprawdzić w skorowidzu/indeksie dla dokładnego poligonu; samo istnienie klasy nie potwierdza jej kompletności w scenie.
- Oficjalny wykaz ISOK publikuje MPHP10k przez WMS i WFS. Odczyt WFS capabilities ujawnił typy m.in. `Watercourse`, `StandingWater`, `HydroNode`, `Crossing`, `RiverBasin` i `DrainageBasin`. Adres usługi wskazuje wariant 2019; metadane zbioru wymagają ponownej kontroli aktualności. Próba pobrania obiektów z WFS bez sesji zwróciła stronę logowania ISOK, więc bezpośredni dostęp wektorowy należy uznać za niepotwierdzony do czasu sprawdzenia autoryzacji i warunków usługi. WMS może służyć do porównania wizualnego, ale nie zastępuje geometrii wektorowej wymaganej przez interpreter.
- Dla pierwszego wycinka OSM już zawiera Wisłę jako `waterway=river` na kilku ways. BDOT10k i MPHP10k pozostają referencją do wykrywania rozbieżności; nie są automatycznym źródłem geometrii renderowanej zamiast OSM.

Wstępne identyfikatory pobrano z odczytowych zapytań do OSM API i Overpass. Są to kandydaci do scenariuszy, nie zamknięta lista fixtures: przed implementacją trzeba sprawdzić ich geometrię, sąsiedztwo, członkostwa relacji i aktualne tagi.

| Miejsce | Wstępne elementy OSM | Co sprawdzić |
|---|---|---|
| Most Siekierkowski | [way 4925779](https://www.openstreetmap.org/way/4925779), [way 187393999](https://www.openstreetmap.org/way/187393999), [way 187536206](https://www.openstreetmap.org/way/187536206), [way 28966008](https://www.openstreetmap.org/way/28966008), [way 358976459](https://www.openstreetmap.org/way/358976459), [way 827868860](https://www.openstreetmap.org/way/827868860); łącznice: [way 23645777](https://www.openstreetmap.org/way/23645777), [way 187536252](https://www.openstreetmap.org/way/187536252), [way 61239507](https://www.openstreetmap.org/way/61239507), [relation 7421590](https://www.openstreetmap.org/relation/7421590) | Odczyt OSM z 18.11.2026 potwierdził główne odcinki `highway=primary`, `bridge=yes`, `layer=1`; way 4925779 ma `bridge:structure=suspension` i `height=9.08`. Przebiegi pieszo-rowerowe obejmują m.in. [way 28966001](https://www.openstreetmap.org/way/28966001) (`highway=path`, `foot=designated`, `bicycle=designated`, most/warstwa 1, konstrukcja suspension, `height=9.08`), [way 949017207](https://www.openstreetmap.org/way/949017207) (path, foot i bicycle designated, most/warstwa 1) oraz [way 61242261](https://www.openstreetmap.org/way/61242261) (cycleway, most/warstwa 1, `foot=yes`). Wisłę reprezentują m.in. ways [5115900](https://www.openstreetmap.org/way/5115900), [61133473](https://www.openstreetmap.org/way/61133473) i [61133499](https://www.openstreetmap.org/way/61133499), wszystkie z `waterway=river`. Way 61133473 ma też `maxheight=9.08` i notatkę do sprawdzenia; nie traktować tego tagu jako potwierdzonej rzędnej lub prześwitu bez analizy semantycznej. W odczytanym fragmencie są ponadto obiekty sygnalizacji i lamp, np. [node 3690489987](https://www.openstreetmap.org/node/3690489987) (`highway=traffic_signals`) i [node 8735665137](https://www.openstreetmap.org/node/8735665137) (`highway=street_lamp`). Ich relację przestrzenną do jezdni oraz podpory mostu trzeba jeszcze potwierdzić. |
| Rondo Marsa i ulica Marsa | [way 13927233](https://www.openstreetmap.org/way/13927233), [way 43547294](https://www.openstreetmap.org/way/43547294), kandydaci na rondo: [way 302956384](https://www.openstreetmap.org/way/302956384), [way 424816081](https://www.openstreetmap.org/way/424816081)–[way 424816084](https://www.openstreetmap.org/way/424816084), [way 485417456](https://www.openstreetmap.org/way/485417456) | Kandydaci na rondo leżą w pobliżu punktu 52.2371, 21.1423; przed zamrożeniem zestawu trzeba potwierdzić geometrię i relacje do łącznic oraz przejść. Zachować wszystkie elementy skrzyżowania jako osobne obiekty OSM. |
| Wiadukty Żołnierskiej | [way 23502658](https://www.openstreetmap.org/way/23502658), [way 23502659](https://www.openstreetmap.org/way/23502659) | Odcinki z `bridge=viaduct`, `layer=1`; sprawdzić drogi i trasy przecinające się pod nimi oraz dalsze wiadukty na odcinku do Zielonki/Marki. |
| Zielonka i Marki: wiadukty lokalne | kandydaci: [way 25559261](https://www.openstreetmap.org/way/25559261), [way 372227359](https://www.openstreetmap.org/way/372227359) | Oba elementy są oznaczone jako `bridge=viaduct` i mają zbliżone położenie; trzeba sprawdzić, czy opisują odrębne obiekty, równoległe jezdnie czy nakładające się geometrie. Nie traktować jeszcze jako dwóch niezależnych fixture. |
| Rzeka Długa | [relation 7576985](https://www.openstreetmap.org/relation/7576985), [way 1421625274](https://www.openstreetmap.org/way/1421625274), [way 1421625275](https://www.openstreetmap.org/way/1421625275) | Relacja `type=waterway`; wymienione odcinki obejmują odcinek `waterway=river`, a jeden ma `tunnel=culvert` i `layer=-1`. Sprawdzić małe mosty, przepusty oraz ścieżki w sąsiedztwie. |
| Pałac Kultury i Nauki | [relation 1319250](https://www.openstreetmap.org/relation/1319250), [outer way 7305241](https://www.openstreetmap.org/way/7305241), [inner ways 89352674](https://www.openstreetmap.org/way/89352674) i [89352699](https://www.openstreetmap.org/way/89352699) | Bieżąca relacja PKiN ma `type=multipolygon` (nie `type=building`) i członków o rolach `outer`/`inner`. Relacja przechowuje tagi budynku (`height=18`, `building:levels=4`, `roof:shape=flat`); wewnętrzne ways mają notatki, że elementy należą do jednego budynku wg. MultiLevel Building Shapes. To podejrzany zestaw parametrów dla kompleksu i dobry przypadek do diagnostyki, ale nie należy uznawać tych wartości za prawdziwą wysokość PKiN. Zachować role i relację, sprawdzić ich dokładne znaczenie przestrzenne. |

**Rozróżnienie dla PKiN:** obsługa relacji `type=building` (role `outline`/`part`) jest wymaganiem ogólnym. PKiN jest dodatkowym, odrębnym testem relacji `type=multipolygon` z rolami `outer`/`inner`. Należy zachować role i tagi, nie wyprowadzać `building:part` z samych notatek lub ról.

### OSM w pierwszym wycinku: aktualny przegląd rdzenia węzła

Odczyt OSM API wykonany 18.11.2026 dla małego rdzenia sceny (bbox 21.085–21.110°E, 52.210–52.220°N) zwrócił 2347 ways (obiektów liniowych). To pomocniczy podobszar, nie pełny wycinek o uzgodnionym zasięgu.

- Relacja [7421590 — Trasa Siekierkowska](https://www.openstreetmap.org/relation/7421590) ma `type=route`, `route=road` i 49 członków typu way. Nadaje się do sprawdzenia zachowania relacji i wielu segmentów, ale nie grupuje automatycznie geometrii mostu.
- Obok dróg OSM opisuje sam obiekt mostu: [way 362216407](https://www.openstreetmap.org/way/362216407) ma `man_made=bridge`, `bridge:structure=cable-stayed`, `layer=1` i nazwę Most Siekierkowski. Dodatkowe obiekty konstrukcyjne w rdzeniu obejmują [way 368042477](https://www.openstreetmap.org/way/368042477), [way 368042478](https://www.openstreetmap.org/way/368042478), [way 368042480](https://www.openstreetmap.org/way/368042480) oraz [way 831783225](https://www.openstreetmap.org/way/831783225) i dalsze elementy; należy zachować je oddzielnie od jezdni.
- Dwa elementy oznaczone `man_made=pier` to [way 61242858](https://www.openstreetmap.org/way/61242858) i [way 445681021](https://www.openstreetmap.org/way/445681021). Są kandydatami do sprawdzenia podpór/kolizji; przed nadaniem semantyki „podpora mostu” trzeba obejrzeć ich pełną geometrię i sąsiedztwo.
- Przykłady oznakowanych tras pieszo-rowerowych na moście: [way 28966001](https://www.openstreetmap.org/way/28966001), [way 949017207](https://www.openstreetmap.org/way/949017207) i [way 61242261](https://www.openstreetmap.org/way/61242261). Sąsiedztwo dróg podniesionych i łącznic pozwala testować różne `layer`/`bridge` bez zakładania, że każde przecięcie 2D jest kolizją.
- W rdzeniu są odcinki Wisły (`waterway=river`), m.in. ways [5115900](https://www.openstreetmap.org/way/5115900), [61133473](https://www.openstreetmap.org/way/61133473) i [61133499](https://www.openstreetmap.org/way/61133499). Występują też węzły `highway=traffic_signals` i `highway=street_lamp`; przykłady do weryfikacji przestrzennej: [node 3690489987](https://www.openstreetmap.org/node/3690489987) i [node 8735665137](https://www.openstreetmap.org/node/8735665137).

**Wynik:** pierwsza scena ma materiał do sprawdzenia dróg, trasy pieszo-rowerowej, Wisły, obiektu mostu, elementów `pier`, lamp i sygnalizacji. To nie jest jeszcze potwierdzenie konkretnych kolizji ani zamknięty zestaw testowy. Następne sprawdzenie musi objąć pełny poligon, wysokości/poziomy i rzeczywiste przecięcia; obiekty niepewne mają pozostać podejrzeniami.

## Rejestr sprawdzeń do wykonania

- Wyprowadzić dokładny poligon pierwszego wycinka z geometrii OSM: cały węzeł Siekierkowski, dojazdy i ścieżki do uproszczenia sieci oraz ok. 1 km Wisły w obu kierunkach.
- Powiązać potwierdzone obiekty testowe z konkretnymi arkuszami NMT/NMPT/LiDAR i ortofotomapy; sprawdzić zasięgi w dokładnym poligonie, daty, rozdzielczości, gęstości, format i układy.
- Porównać zasięg i daty NMT/NMPT/LiDAR/ortofotomapy; przygotować plan przejść między źródłami bez szczelin.
- Sprawdzić hydrografię BDOT10k i MPHP10k dla rzeki Długiej, Wisły i wskazanych przepraw; ustalić, które produkty dostarczają geometrii, a które jedynie kartografii lub podziału hydrograficznego.
- Dokończyć geometrię punktów przy rondzie Marsa, węzłach w Markach/Zielonce i małych przeprawach nad Długą; powiązać właściwe odcinki OSM z punktami testowymi.
- Zweryfikować elementy OSM kandydujące dla Mostu Siekierkowskiego, w tym relacje grupujące, podpory, sygnalizację i lampy, oraz zinwentaryzować drogi, tunele, `layer` i pieszo-rowerowe przebiegi. Następnie zweryfikować pozostałe lokalizacje, relacje budynków `type=building` i części/dachy PKiN.
- Zweryfikować licencje, atrybucję, limity usług i dopuszczalny sposób cache’owania każdej warstwy przed implementacją.
- Uruchomić późniejsze pomiary przy 5120 × 1440 na AMD Ryzen 5 7600, 32 GB RAM DDR5 i AMD Radeon RX 6750 XT.

## Źródła

- [GUGiK — Numeryczny Model Terenu](https://www.geoportal.gov.pl/pl/dane/numeryczny-model-terenu-nmt/)
- [GUGiK — Numeryczny Model Pokrycia Terenu](https://www.geoportal.gov.pl/pl/dane/numeryczny-model-pokrycia-terenu-nmpt/)
- [GUGiK — dane pomiarowe LiDAR](https://www.geoportal.gov.pl/pl/dane/dane-pomiarowe-lidar-lidar/)
- [GUGiK — pomoc do wyszukiwania NMT/NMPT/ALS i ortofotomapy](https://mapy.geoportal.gov.pl/imapnext/pomoc/aplikacja/geoportal/4_narzedzia_paska_menu_glownego.html)
- [GUGiK — WFS skorowidzów NMT, PL-EVRF2007-NH](https://mapy.geoportal.gov.pl/wss/service/PZGIK/NumerycznyModelTerenuEVRF2007/WFS/Skorowidze)
- [GUGiK — WFS skorowidzów NMPT, PL-EVRF2007-NH](https://mapy.geoportal.gov.pl/wss/service/PZGIK/NumerycznyModelPokryciaTerenuEVRF2007/WFS/Skorowidze)
- [GUGiK — WFS skorowidzów LiDAR, PL-EVRF2007-NH](https://mapy.geoportal.gov.pl/wss/service/PZGIK/DanePomiaroweLidarEVRF2007/WFS/Skorowidze)
- [GUGiK — WFS skorowidzów ortofotomapy](https://mapy.geoportal.gov.pl/wss/service/PZGIK/ORTO/WFS/Skorowidze)
- [GUGiK — ortofotomapa](https://www.geoportal.gov.pl/pl/dane/ortofotomapa-orto/)
- [GUGiK — BDOT10k](https://www.geoportal.gov.pl/pl/dane/baza-danych-obiektow-topograficznych-bdot10k/)
- [GUGiK — pobieranie klas BDOT10k w GPKG i GeoParquet](https://www.geoportal.gov.pl/aktualnosci/nowy-sposob-udostepniania-danych-bdot10k-w-geoportalu/)
- [GUGiK — katalog klas hydrografii BDOT10k (OT_SWRS_L i inne)](https://www.gugik.gov.pl/__data/assets/pdf_file/0009/208836/zalacznik_5_zasady_wprowadzania_obiektow_do_BDOO.pdf)
- [Wody Polskie — MPHP10k, metadane zbioru](https://dane.gov.pl/pl/dataset/2167%2Cmapa-podzialu-hydrograficznego)
- [ISOK/Wody Polskie — lista usług INSPIRE, MPHP10k WMS/WFS](https://www.isok.gov.pl/inspire.html)
- [OpenStreetMap — copyright i licencja](https://www.openstreetmap.org/copyright)
