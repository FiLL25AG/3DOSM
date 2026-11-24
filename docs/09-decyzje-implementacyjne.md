# Decyzje implementacyjne i stan pierwszego wycinka

**Stan na:** 18 listopada 2026. Dokument zapisuje szczegóły dobrane podczas implementacji (`08-lista-startowa-claude-code.md`, „Granice samodzielnych decyzji”). Nie zmienia zakresu ani uzgodnień z dokumentów `01`–`08`.

## Uruchomienie

```powershell
.\run.ps1
```

Aplikacja działa pod `http://127.0.0.1:8473`. Pierwszy start tworzy `.venv` oraz pobiera dane do `data/cache` (ok. 0,5 GB). Testy: `.venv\Scripts\python -m unittest discover -s tests -t .` oraz strona `/tests.html`.

## Decyzje

| Obszar | Wybór | Uzasadnienie |
|---|---|---|
| Stack | Serwer Python (biblioteka standardowa, NumPy, pyproj, Shapely, jsonschema) i moduły ES bez kroku budowania | Repozytorium nie miało stacku, a na komputerze nie ma Node.js. Three.js 0.187.0 jest dołączony w `web/vendor` po kontroli sumy SHA-512. |
| Transformacja poziomu | pyproj: EPSG:4326 → EPSG:2180, operacja „Inverse of ETRF2000-PL to WGS 84 (1) + Poland CS92”, deklarowana dokładność 1 m | Jawna i zapisana w manifeście sceny. Klient ma własne odwzorowanie tylko do wyszukiwania; test porównuje je z PROJ. |
| Teren | Arkusze NMT 1 m ARC/INFO ASCII ze skorowidza WFS EVRF2007 | Usługa WCS GRID1 publikuje pokrycie `PL-KRON86-NH`, więc nie została użyta. Adapter odrzuca arkusze o innym układzie, formacie lub rozdzielczości. |
| Kafelki terenu | Drzewo czwórkowe 8192 m, poziomy 0–6, 129 × 129 próbek, średnia z pominięciem braków | Rodzic pozostaje widoczny do gotowości wszystkich dzieci. |
| Luki NMT | Do 3 m interpolacja z oznaczeniem, większe pozostają brakiem danych | Realizuje zasadę z `04-prototyp.md`. W obecnym poligonie luk nie ma. |
| Poligon | Spójna sieć z mostem, tunelem, `layer≠0` lub `*_link` od obrysu mostu (limit 3,5 km), pierwszy zwykły odcinek jako dojazd, Wisła ±1000 m wzdłuż osi, bufor 200 m | To robocza, jawna definicja „uproszczenia sieci”. Parametry są w `config/sources.json`. |
| Cache | SQLite + pliki, limit 10 GB, LRU, ochrona kluczy aktywnej migawki | Odświeżenie buduje nową migawkę obok aktywnej i przełącza dopiero po sukcesie. |
| Pobieranie | Timeout 60 s na operację, 3 próby, 240 s na adres, postęp w konsoli | Długie pobranie jest widoczne i nie blokuje bez końca. |
| Interpretacja | W przeglądarce, z profilu JSON walidowanego na serwerze | Edycja tagu nie wymaga połączenia z serwerem. |
| Obszary i cienie | Malowane do tekstury na terenie | Dokładnie leżą na terenie, bez migotania. Miękkie cienie budynków i pomostów są liczone tylko po zmianie danych, więc nie obciążają klatki. |
| Poziomy sieci | Jedna wysokość na węzeł OSM; NMT z ograniczeniem spadku; pomost między przyczółkami z prześwitem 5,5 m nad przecinanymi trasami i 1 m nad ciekami | Wyłącznie prezentacja, oznaczona jako przybliżona. Sam `layer` ustala kolejność w przecięciu i nie podnosi obiektu. |
| Oprawa wizualna | Własne shadery: jedno miękkie światło, światło otoczenia, lekka mgła i niebo; paleta w profilu | Styl inspirowany estetyką Streets GL, bez jego kodu i zasobów oraz bez postprocessingu. |
| Kolizje | Status „potwierdzona” wymaga poziomów `reliable` obu obiektów | Żadne obecne źródło nie daje takich poziomów, więc scena nie zawiera potwierdzonych kolizji. |
| Globus | Kontury lądów `world-atlas` 2.0.2 (110 m, licencja ISC) | Uproszczony widok Ziemi bez szczegółowych danych świata. |
| Nawierzchnie i linie | Materiał z `surface`, linia przebiegu i oznakowanie jako osobne warstwy; wartości krajowe w sekcji `surfaces` profilu | Wygląd, przebieg i geometria zmieniają się niezależnie, a silnik nie zawiera założeń o Polsce. Szczegóły w sekcji „Nawierzchnie, linie przebiegu i oznakowanie”. |

## Zweryfikowane dane

- OSM API, 18.11.2026: poligon 3,903 km², 83 odcinki węzła, 44 dojazdy, 2000 m osi Wisły; w scenie 6506 obiektów.
- NMT: 9 arkuszy z 27.04.2025, skaning laserowy, błąd wysokości 0,05 m, `PL-EVRF2007-NH`, PL-1992. Pokrycie poligonu: 100% pomiar, 0% interpolacja, 0% brak.
- Arkusze nie zachodzą na siebie w zasięgu sceny, więc zgodności wysokości na stykach nie dało się sprawdzić porównaniem zakładek.
- Układ wysokościowy pochodzi z metadanych skorowidza. Pliki ASCII go nie deklarują.
- Warunki NMT: strona produktu w Geoportalu podaje, że dane są bezpłatne i „możliwe do dowolnego wykorzystania”.
- `man_made=pier` w scenie to pomosty, a nie podpory mostu. Kandydaci z `06-inwentaryzacja-zrodel.md` (ways 61242858 i 445681021) mają taką klasę.
- Dane zawierają sprzeczność: odcinki mostu mają `bridge:structure=suspension`, a obrys mostu `cable-stayed`. Aplikacja ją raportuje i nie rozstrzyga.

## Kafle danych: doczytywanie i odświeżanie

**Decyzja (Q&A 2026-11-21).** Dane OSM i NMT są doczytywane kaflami w oknie 3×3 wokół celu kamery; odległe kafle są zwalniane z pamięci (`04-prototyp.md`, strumieniowanie). Kafel to komórka OSM 0,025° × 0,02° (ok. 1,7 × 2,2 km) w globalnej siatce stopni (`server/tiles.py`). Serwer buduje kafel w tle, jeden naraz (OSM API ma limit zapytań): OSM dla komórki, uzupełnienie wielokątów przecinających kafel, NMT z arkuszy dla zasięgu kafla z marginesem 300 m, obiekty w formacie migawki sceny. Wynik trafia do cache (`tile/i/j/wersja/features`, `.../terrain`) i jest chroniony przed usuwaniem. Najpierw budowany jest kafel pod kamerą, potem boczne, na końcu narożne; kafel, o który klient przestał pytać (kamera odjechała), wypada z kolejki po 20 s. Pierwsza scena przy moście pozostaje źródłem początku układu współrzędnych i metadanych; obiekty pochodzą wyłącznie z kafli.

Teren ma wspólną piramidę dla wszystkich wczytanych kafli: korzeń 65 536 m wokół początku układu (cała Warszawa), poziomy 0–9, najdokładniejszy z komórką 1 m jak wcześniej. Kafel wysokości łączy mozaiki kafli danych w pamięci (pierwsza z danymi w punkcie ma pierwszeństwo) i mozaikę pierwszej sceny. W kliencie `TileManager` (`web/src/tiles.js`) co 1,5 s pyta serwer o okno, wczytuje gotowe kafle i nowsze wersje, a zwalnia te spoza okna. Obiekt z kilku kafli (way na granicy) występuje w modelu raz; jego brakujące wysokości uzupełnia kopia z sąsiedniego kafla, a usuwany jest dopiero, gdy nie zawiera go żaden wczytany kafel. Zmiany sesyjne dotyczą identyfikatorów i obowiązują także dla obiektów wczytanych ponownie. Nakładka obszarów, maska materiału, dopasowanie terenu i maska tuneli obejmują bieżący zasięg wczytanych kafli.

**Odśwież źródła** odświeża kafle widoczne na ekranie (punkty siatki ekranu rzutowane na teren; kafel przy krawędzi może zostać odświeżony nadmiarowo). Serwer pobiera dla nich OSM ponownie, w nowej przestrzeni kluczy cache, i zapisuje nową wersję kafla; do czasu jej gotowości działa poprzednia. Przy zmianach sesyjnych aplikacja pyta jak wcześniej; odrzucenie zmian przywraca tagi źródłowe bez przeładowania.

**Pomiary (panel przeglądarki, nie sprzęt docelowy):** okno 3×3 przy moście to 9 kafli i 65 183 obiekty (wycinek mostu miał 6 612). Budowa nowego kafla trwa ok. 30–60 s, głównie pobieranie OSM i arkuszy NMT. Pierwsze wczytanie okna z cache: 12,6 s (wcześniej 37,5 s; indeks przestrzenny skrócony z 16,1 s do 1,3 s przez liczenie nakładania tylko dla budynków, a trasy w obrysie tylko dla konstrukcji i powierzchni dróg; wysokości pod bariery pobierane tylko dla nowych miejsc; jedna przebudowa widoku zamiast dwóch). Zmiana okna przy przesunięciu o kafel zatrzymywała widok na 5–7 s, bo model i widok były przeliczane w całości; po przeliczaniu przyrostowym (niżej) najdłuższa blokada to ok. 2 s. Edycja tagu przy 38 636 obiektach przeliczała się ok. 1 s (przy samym wycinku 0,1–0,2 s). Klatka: 2,3 ms przy 1,4 mln trójkątów w panelu 1688 × 1264.

**Ograniczenia:** model po zmianie kafli jest nadal przeliczany w całości (ok. 2 s przy 53 tys. obiektów, ok. 4 s przy 98 tys. w gęstej zabudowie). W oknie 3×3 przy moście jest 399 odcinków wycięć tuneli, a shader przyjmuje 96: trafiają tam odcinki najbliższe celu kamery (w praktyce do ok. 1,7 km), odnawiane po przesunięciu celu o 150 m; maska tuneli w teksturze obejmuje wszystkie. Dalsze tunele nie mają wycięcia terenu, co z odległości jest niewidoczne. Starsze wersje odświeżonych kafli pozostają w cache jako chronione.

### Przeliczanie przyrostowe po zmianie kafli

**Decyzja (Q&A 2026-11-21).** Po doczytaniu, zwolnieniu albo zastąpieniu kafla widok nie jest przebudowywany w całości. Model pozostaje liczony w całości (poziomy wynikają z grafu całej sieci), ale po przeliczeniu porównuje odcisk danych, z których widok rysuje każdy obiekt: poziom oraz plany nawierzchni, przejścia, bariery, tunelu i schodów (`SceneModel._updatePrints`, skrót FNV-1a tekstu JSON). Przebudowywane są tylko:

- kawałki z obiektami nowymi, usuniętymi albo ze zmienionym odciskiem oraz ich sąsiadami we wspólnych węzłach, jak przy edycji;
- kawałki z obiektami, których prostokąt przecina zmieniony obszar: obrys wczytanego, zwolnionego albo zastąpionego kafla z zapasem 50 m (zasięg kafla z serwera ma margines terenu 300 m, który jest odejmowany do 50 m). Tam zmienia się otoczenie: węzły, pokrycie nawierzchni, budynki;
- pas nowej siatki dopasowania terenu, którego nie było w poprzedniej (zasięg okna nie ma prostych krawędzi, bo kafle w PL-1992 nie są prostokątami).

Kawałki są przebudowywane porcjami po ok. 25 ms między klatkami: najpierw puste (obiekty usunięte znikają od razu), potem od najbliższych celu kamery; w karcie w tle kolejna porcja startuje po 100 ms. Obiekt usunięty, którego siatka czeka jeszcze na przebudowę, nie jest wybierany kliknięciem.

Dopasowanie terenu do tras ma stałą siatkę: bok teksela 3 m zakotwiczony w wielokrotnościach boku (wcześniej 2048 tekseli na cały zasięg, czyli ok. 3,2 m przy oknie 3×3). Przy zmianie zasięgu część wspólna jest kopiowana o całkowitą liczbę tekseli, a stemplowane są tylko zmienione obszary w blokach 32 × 32 tekseli: zmienione kafle, otoczenie obiektów ze zmienionym odciskiem i usuniętych tras (40 m). Trasa jest stemplowana odcinkami (odległość od odcinka i wysokość w rzucie na niego) zamiast punktami co 1,5 m, a środek teksela leży w jego środku tak jak przy odczycie w shaderze (wcześniej stempel był przesunięty o pół teksela). Po edycji dopasowanie liczone jest tylko wokół zmienionych tras. Maska tuneli ma tę samą siatkę.

Optymalizacje bez zmiany wyniku (sprawdzone porównaniem z poprzednią wersją obiekt po obiekcie): linie krawędziowe (wyszukiwanie binarne odcinka osi, siatka luźnych końców zamiast przeglądu par, kandydaci komórki liczeni raz, próbki narożników tylko w potrzebnych komórkach), indeks przestrzenny (klucze liczbowe komórek, znacznik odwiedzin zamiast zbioru), poziomy (propagacja obwiedni od konstrukcji kończy się poniżej najniższego i powyżej najwyższego punktu sieci, bo dalej wynik min/max i tak równa się wysokości gruntu), tunele (test prostokąta budynku), podpory (klucze liczbowe). Po edycji odciski są porównywane w promieniu 300 m od edytowanych obiektów i tras ze zmienionym poziomem (przy ponad 200 takich obiektach w całości), więc przebudowę dostaje też sąsiad, któremu zmienił się plan.

**Sprawdzenie:** po przesunięciu okna na wschód, z powrotem na zachód i na północ widok przyrostowy porównano z pełną przebudową (`Engine.rebuildAll`): 0 różnych tekseli dopasowania i 0 różnych kawałków (207–215 kawałków, skrót pozycji wszystkich siatek). Na 201 punktach osi tras na gruncie bufor wyboru nie pokazał terenu nad jezdnią ani razu. Testy logiki 91/91 (nowe: odciski przy doczytaniu, dopasowanie regionu i przesunięcia równe pełnemu, przebudowa tylko kawałków w zmienionym obszarze), serwera 19/19.

**Pomiary (panel przeglądarki, nie sprzęt docelowy), przesunięcie o kafel przy moście, +15 246 / −26 547 obiektów:**

| Etap | Przed | Po |
|---|---:|---:|
| Model (indeks, poziomy, plany, odciski) | ok. 4,3 s | 1,8–2,3 s |
| Dopasowanie terenu | 1,3 s | 0,14–0,16 s |
| Kawałki widoku | 3,0 s, jedna blokada | 1,3–1,8 s w porcjach po 25 ms |
| Najdłuższe zadanie blokujące | 5–7 s | ok. 2,0 s (model), dalej 0,36 s i krótsze |

Pobieranie wysokości pod bariery dla nowych miejsc (1,5–1,8 s) jest asynchroniczne i nie zatrzymuje obrazu. Pełne pierwsze wczytanie okna 3×3: model 2,8–3,0 s, dopasowanie terenu 0,3 s (wcześniej 1,3 s). Etapy modelu przy 53 tys. obiektów: indeks 966 → ok. 550 ms, poziomy 819 → 543 ms, nawierzchnie 1069 → ok. 600 ms, tunele 140 → 35 ms, podpory 141 → 94 ms. Edycja tagu w gęstej zabudowie (98 tys. obiektów) trwa ok. 2 s, bo plany nawierzchni, bariery, tunele i podpory są przeliczane w całości; dopasowanie terenu po edycji nie blokuje już przez 1,3 s.

### Płynność przy przelocie i doczytywaniu (2026-11-22)

**Problem.** Przy szybkim przelocie nisko nad terenem obraz zatrzymywał się na 3–4 s, za każdym razem gdy cel kamery przekroczył granicę kafla danych. Pomiar klatek z rozbiciem czasu wykazał, że nie odpowiada za to rysowanie ani budowa kafli terenu (łącznie 50 ms w wolnych klatkach), tylko jedno zadanie 3,75 s: przeliczenie modelu (2,4 s w jednym bloku) i widoku po doczytaniu kafla.

**Decyzja.**
- **Przeliczanie po zatrzymaniu kamery.** Dane gotowych kafli są pobierane od razu, w tle (`TileManager._fetch`). Przeliczenie modelu i widoku rusza dopiero wtedy, gdy kamera stoi od 400 ms (`Engine.calm`; ruch to zmiana celu, odległości lub kierunku w klatce). Teren NMT doczytuje się jak dotąd, niezależnie od tego.
- **Etapy modelu.** Przeliczenie modelu jest etapowe (`SceneModel.addFeaturesStaged`): interpretacja porcjami, indeks przestrzenny sekcjami, poziomy fazami, plany nawierzchni przejściami (linie krawędziowe porcjami), schody i bariery, tunele, podpory, diagnostyka, odciski porcjami. Między etapami jest przerwa na klatkę. Funkcje etapowe są generatorami, a dotychczasowe wywołania (edycja, testy) przechodzą wszystkie etapy naraz, więc logika i wynik są te same.
- **Etapy widoku.** Widok również jest etapowy: zmiana zasięgu, wspólne indeksy rysowania (węzły, pokrycie nawierzchni, priorytety, budynki) liczone osobno przed kawałkami, profile ścian, dopasowanie terenu porcjami, przydział kawałków i przebudowa kawałków po ok. 25 ms.
- **Blokada w trakcie.** W czasie przeliczania model jest niespójny, więc edycja czeka (komunikat), a inspektor odświeża się po zakończeniu.
- **Płyty mostów.** Wysokość płyty liczy się tylko z tras, których prostokąt sięga do 30 m od obrysu (te same próbki co wcześniej). Lista płyt przy punkcie najpierw odrzuca je po prostokącie obrysu. Profile ścian skróciły się z 515 do ok. 55 ms.

**Pomiary (panel przeglądarki, okno 3×3, 65–80 tys. obiektów).** Przelot 4,5 km nad kilkoma kaflami na wysokości ok. 150 m, w 12 s:

| Miara | Przed | Po |
|---|---:|---:|
| Najdłuższe zadanie w czasie przelotu | 3753 ms | 74 ms (w jednym z przelotów 340 ms*) |
| Mediana / 99. percentyl klatki | 24 / 158 ms | 6–12 / 24–36 ms (przy pełnej płynności panelu) |
| Najdłuższy etap przeliczenia po zatrzymaniu | 2400 ms (model w całości) | model 150–265 ms, widok 100–450 ms** |

\* Pojedyncze przycięcia 130–340 ms w ruchu występują także bez przeliczeń. Sterta JS ma ok. 1,0–1,1 GB, więc najpewniej to odśmiecanie pamięci.
\*\* Najdłuższy jest pojedynczy kawałek z płytą dużego mostu (sama płyta Mostu Siekierkowskiego ok. 160 ms); kawałek jest najmniejszą jednostką przebudowy.

Wynik etapowy jest identyczny z pełnym: przebudowa pełna po etapowej nie zmienia żadnego kawałka ani teksela dopasowania, a synchroniczne przeliczenie modelu na tych samych danych nie zmienia żadnego odcisku planu.

**Ograniczenia:**
- Dopóki kamera jest w ruchu, nowe kafle danych nie pojawiają się; po zatrzymaniu przeliczenie trwa kilka sekund, rozłożonych na klatki.
- Odśmiecanie przy ok. 1 GB sterty daje pojedyncze przycięcia. Zmniejszenie pamięci (np. tablice typowane dla punktów, ślad reguł interpretacji liczony na żądanie) jest osobnym krokiem.
- Nie mierzone na Ryzen 5 7600 / RX 6750 XT przy 5120×1440.

### Pamięć (2026-11-22)

**Problem.** Sterta JS miała ok. 1,0–1,1 GB przy 65–80 tys. obiektów, a w ruchu pojawiały się pojedyncze przycięcia 130–340 ms (odśmiecanie). Policzone składniki:
- **kopie danych wierzchołków obiektów:** 311 MB (4,36 mln wierzchołków, 5008 siatek), w pamięci JS także po wysłaniu na GPU;
- **kopie siatek kafli terenu:** 225 MB (420 kafli);
- **siatki wysokości pod bariery:** 98 MB (1480 siatek, przybywały przy każdym przesunięciu okna);
- **dopasowanie terenu i indeks ścian:** 63 MB;
- **pozostałe:** model, plany i indeks przestrzenny.

**Decyzja.**
- **Zwalnianie kopii po wysłaniu na GPU.** Dane wierzchołków obiektów i kafli terenu są zwalniane w pamięci JS zaraz po wysłaniu na GPU (`releaseArray`, mechanizm `onUpload` Three.js). Obwiednia siatki jest liczona wcześniej, a kontrole budują geometrię od nowa. Wysokości kafli terenu (wysokość pod kamerą) zostają.
- **Wysyłanie w tle.** Nowe siatki, także te poza kadrem i poza zasięgiem szczegółowości, są wysyłane na GPU w tle, do 4 ms na klatkę (`Engine._primeMeshes`): każda jest raz rysowana do ukrytego celu 1×1 piksel. Dzięki temu kopie są zwalniane od razu, a pierwsze narysowanie siatki w czasie lotu nie wysyła danych ani nie kompiluje shadera w tej samej klatce.
- **Siatki wysokości pod bariery** poza bieżącym zasięgiem danych są zwalniane przy zmianie okna.
- **Utrata kontekstu WebGL.** Po jej odzyskaniu teren i widok są budowane od nowa, bo kopii danych w JS już nie ma.

**Wynik.**
- Po wczytaniu okna i wysłaniu siatek zostaje 0 MB kopii geometrii obiektów i terenu (wcześniej 536 MB).
- Sterta po odśmieceniu ma ok. 470–660 MB przy 65 tys. obiektów (wcześniej ok. 1000 MB). Pomiar w przeglądarce bez wymuszenia pełnego odśmiecania jest przybliżony.
- Przeloty w obrębie wczytanych kafli: żadna klatka powyżej 100 ms (najdłuższa 73–97 ms), zadania blokujące do 71 ms. Wcześniej zdarzały się przycięcia 130–340 ms.
- Obraz i wybór obiektu kliknięciem bez zmian (sprawdzone na budynkach i drogach).

**Ograniczenia.** Narzędzia kontrolne w konsoli nie mogą już czytać danych wierzchołków z gotowych siatek, bo zostały zwolnione. Model obiektów (punkty jako tablice JS, ślady reguł interpretacji, plany) zostaje największą częścią sterty; jego zmniejszenie wymaga zmian struktury danych.

### Zasięg terenu i brak zależności od miejsca

**Decyzja (2026-11-22).** Reguły interpretacji i renderowania są globalne (konwencje OSM), a różnice krajowe trafiają do profilu kraju tylko wtedy, gdy zostaną jawnie wskazane (`AGENTS.md`). Przegląd kodu pod kątem zależności od miejsca:
- **Logika.** Brak identyfikatorów obiektów OSM i nazw miejsc w logice interpretacji i renderowania.
- **Piramida terenu.** Miała korzeń 65,5 km wokół miejsca startu, więc dalej teren nie istniał. Teraz ma stałą siatkę w układzie NMT (EPSG:2180, PL-1992): korzeń o boku 2^20 m (ok. 1049 km) od punktu (0, 0) układu obejmuje cały jego zasięg w Polsce, niezależnie od miejsca startu. Poziom 13 ma kafle 128 m z komórką 1 m, jak wcześniej poziom 9. Manifest przekazuje klientowi róg korzenia w układzie lokalnym (`tiles.rootWest`, `tiles.rootSouth`).
- **Pusty korzeń wyłączał teren (poprawka 2026-11-24).** Zgłoszenie: przy ul. Branickiego (Wilanów) zniknęła rzeźba terenu. Przyczyna była ogólna. Gruby kafel piramidy powstaje z próbek co 16 km (korzeń) z mozaik wczytanych kafli danych, które mają po 2–5 km. Ma więc dane tylko wtedy, gdy któraś próbka przypadkiem trafi w mozaikę, a po restarcie serwera korzeń był pusty (204).
  - Klient schodził po piramidzie od korzenia i zatrzymywał się na pustym kaflu: rysowanych kafli było 0. `heightAt` też przerywał szukanie na pierwszym pustym poziomie i zwracał brak wysokości.
  - Teraz pusty kafel nie jest rysowany, ale nie blokuje dokładniejszych poziomów, a `heightAt` pomija puste poziomy.
  - Kafle spoza zasięgu wczytanych danych (`TerrainSystem.dataExtent`, ustawiany razem z zasięgiem widoku) nie są pobierane. W miejscu startu liczba pustych zapytań spadła z 646 do 160.
  - Sprawdzenie: w miejscu startu rysowanych jest 8 kafli (wcześniej 0), a przy Branickiego 52. `heightAt` zgadza się z próbnikiem NMT (90,58 m). Test logiki obejmuje pusty korzeń z danymi na niższym poziomie oraz pomijanie kafli poza zasięgiem danych.
- **Wycinek startowy.** Wybierał rzekę po nazwie wpisanej w kodzie. Teraz bierze odcinki rzeki z konfiguracji sceny (`config/sources.json`: `riverWays`), tak jak most i relację trasy. Panel pokazuje ogólny opis, a opis profilu nie wspomina konkretnego miejsca.
- **Narzędzia kontrolne.** Kamery audytu (`AUDIT_CAMERAS`) i trasa testu wydajności zawierają współrzędne okolicy startu, ale są narzędziami, nie logiką.

## Ciągłość geometrii

Audyt `web/src/core/audit.js` ocenia wynik niezależnie od algorytmu wysokości. Sprawdzone na scenie 1884 tras transportowych:

| Miara | Przed | Po |
|---|---:|---:|
| Węzły z różną wysokością na dochodzących trasach | 2 (do 6,0 m) | 0 |
| Trasy przekraczające dopuszczalny spadek swojej klasy | 123 przy progu 12% | 0 |
| Przecięcia z rozdzieleniem poniżej 4 m (na 189) | 82 | 0; najmniej 5,5 m |

Przyczyny, rozdzielone według źródła:

- **Topologia OSM:** 108 końców tras leży do 4 m od innej trasy bez wspólnego węzła, głównie ciągi piesze przy jezdniach. Geometria OSM pozostaje bez zmian. Dla par jezdni diagnostyka ma regułę `topology-gap`; w tej scenie nie ma takiego przypadku.
- **Wysokości:** poziomy liczono osobno dla odcinka, sam `layer` podnosił drogę o 6 m, a węzeł przelotowy pomostu przy bocznej ścieżce był ściągany do terenu. NMT nie zawiera mostów, więc drogi przy przyczółkach wpadały w zagłębienia.
- **Renderowanie:** przybliżony LOD terenu przykrywał końce pomostów, wstęgi nie miały zakończeń na łączeniach, a obrys mostu był płaską płytą. Teraz bufor głębi jest czyszczony po terenie, wstęgi zachodzą na siebie, a obrys przyjmuje wysokość pomostów.

### Nasyp ścieżek i chodników

Trasa na gruncie jest rysowana jak nasyp (wyżej niż inne nawierzchnie, ze ścianami), gdy odbiega od terenu o ponad 0,4 m. Dla jezdni wystarcza pojedyncze wyniesienie (rampa do przyczółka). Ścieżka, chodnik i droga rowerowa są nasypem dopiero wtedy, gdy ponad terenem leży jej odcinek o długości co najmniej 15 m albo połowa trasy (`raisedMeters` z modelu wysokości). Wcześniej np. droga rowerowa `w232225269` (958 m) przez lokalne odchylenie 0,65 m była w całości nasypem i zakrywała przejście `w999568595` i chodniki. Po zmianie: zebry i przejazdy widoczne 25 z 25 (wcześniej 24 i 1 zakryte), szczeliny połączeń 1 (0,4 m², wcześniej 8 i 3,5 m²).

### Wypełnianie dołków NMT pod trasami

**Decyzja.** NMT nie zawiera przepustów ani mostków, więc pod drogą przekraczającą rów, ciek w przepuście albo cień konstrukcji pokazuje dno rowu. Trasa na gruncie „wpadała” wtedy w dołek: nawierzchnia znikała za ścianą rowu albo terenem, a linie oznakowania zostawały w górze i wyglądały, jakby wisiały w powietrzu. Wysokość tras na gruncie (jezdnie, ścieżki, chodniki; bez schodów) jest więc po ograniczeniu spadku wygładzana w `fillRoadDips` (`web/src/core/levels.js`). Punkt jest podnoszony tylko wtedy, gdy w promieniu 20 m wzdłuż sieci po co najmniej dwóch stronach leży wyższy punkt: do niższej z tych wysokości, najwyżej o 2,5 m. Wysokość tylko rośnie; koniec trasy nie jest podnoszony, a szersze obniżenia (doliny, przejazdy pod konstrukcjami) zostają. Węzły tuneli i przejść podziemnych oraz punkty w promieniu 20 m od nich nie są wygładzane, bo rampa do wlotu jest rzeczywistym obniżeniem. Wygładzenie działa przed dowiązaniem do konstrukcji i po nim (z nieruchomymi końcami konstrukcji), więc między dwoma pomostami nie zostaje „V” z ograniczenia spadku. Wypełnienie liczy się do gruntu, a nie do nasypu (`maxOffset`), więc trasa nad rowem nie dostaje ścian ani podpór. Teren dopasowuje się do tras, więc nad przepustem powstaje nasyp, a przepust jest przykryty tubą, a nie odkrytą niecką.

Wynik w wycinku: dołki ponad 0,5 m na trasach na gruncie spadły z 98 do 14 (na jezdniach z 23 do 3; pozostałe to schody i ścieżki przy tunelach). Przykład: `w303249142` nad Nową Ulgą miał punkt 81,78 m między 83,27 i 83,36 m, teraz 83,39 m; przepust `w23072758` jest przykryty drogą. Audyty po świeżym wczytaniu: szczeliny 8 (3,5 m², wcześniej 3,8 m²), tunele ukryte pod terenem 12 z 12, wloty otwarte 30 z 38 (nowy wlot przepustu Nowej Ulgi i wlot `w656822138` przy ścieżce `w282943390` są zasłonięte), podpory 220 (wcześniej 219), jeden uskok poprzeczny jezdni 0,34 m przy tolerancji 0,3 m. Kontrola `auditTunnels` ukrywa na czas pomiaru linie przebiegu: są rysowane na wierzchu i bez tego „widać” tunel z góry.

## Audyt połączeń całej sieci

`web/src/render/networkAudit.js` sprawdza trójkąty faktycznie generowane dla 1884 tras i 2309 węzłów łączących. Stan „przed” zmierzono tym samym audytem na odtworzonych w przeglądarce starych łączeniach i starym LOD.

| Obszar | Miara | Przed | Po |
|---|---|---:|---:|
| Końce wayów | Pary tworzące jedną wstęgę ze skokiem krawędzi | 558 z 558, do 5,89 m | 0 z 817 |
| Szerokości i klasy | Styki pary ze skokiem szerokości | 64 z 64 | 0 z 80 |
| Obrysy | Węzły z wystającym narożnikiem | 57 (24,8 m²) | 2 (0,5 m²) |
| Obrysy | Węzły ze szczeliną | 1 (0,2 m²) | 1 (0,4 m²) |
| LOD | Węzły z jedną z dwóch tras wyłączoną, 5 ujęć kamery | 8 / 55 / 58 / 0 / 9 | 0 / 0 / 0 / 0 / 0 |
| Kafelki | Różnica wysokości na styku poziomów, p99 / maks. | 0,52 / 1,65 m | 0,23 / 0,73 m |
| Poziomy | Skoki na węzłach; przecięcia z prześwitem < 4 m lub złą kolejnością | 0; 0 z 189 | 0; 0 z 189 |

Wynik „po” dla pary obejmuje także przelotowe drogi w skrzyżowaniach, dlatego liczba par wzrosła z 558 do 817.

**Artefakty renderera (naprawione):** osobne prostokątne końce wstęg, poprzeczne kreski obwódek, brak łączenia kierunku i szerokości między wayami oraz LOD liczony per kawałek siatki. Kafelki terenu próbkowały komórkę przesuniętą nawet o pół jej rozmiaru.

**Cechy danych OSM (bez zmian geometrii):** 603 ślepe końce tras i 108 końców leżących do 4 m od innej trasy bez wspólnego węzła, w tym 1 para jezdni i 92 końce ciągów pieszych lub rowerowych. Diagnostyka `topology-gap` zgłasza 64 przypadki do 3 m na tym samym `layer`. Audyt znalazł też 11 par osobnych węzłów oddalonych o mniej niż 0,5 m; żadna nie łączy dwóch tras na tym samym poziomie. Renderer niczego nie skleja na podstawie odległości.

## Górna nawierzchnia jezdni

Audyt przekroju (`auditSurface`, `auditLateralSteps`, `auditBridgePlates` w `web/src/render/networkAudit.js`) mierzy osobno płytę jezdni, jej krawędzie, boki oraz piksele w zbliżeniu.

| Miara | Przed | Po |
|---|---:|---:|
| Przekroje, w których bok nie wychodzi z krawędzi nawierzchni (z ok. 1400) | 808, do 0,50 m | 0 |
| Ściany boczne z błędną normalną | 9 | 0 |
| Dziury w płycie / obniżenie płyty ponad 5 cm w przekroju | 0 / 0 | 0 / 0 |
| Stopnie między stykającymi się jezdniami o tym samym poziomie i podobnym gruncie | 53 przekroje, 14 par, do 2,65 m | 15 przekrojów, 6 par, do 0,57 m |
| Płyta mostu względem pomostów: pod / nad jezdnią | do 3,20 / 2,71 m | do 0,59 / 0,48 m |
| Próbki płyty mostu z odchyleniem ponad 10 cm (z 551) | 508 | 64 |
| Piksele w zbliżeniu, gdzie zamiast nawierzchni widać bok lub obwódkę tej samej trasy (z ok. 312) | 11, pomiar bez rozróżnienia obiektu | 0 |

**Przyczyny:**
- Jezdnie na nasypach były rysowane bez zapisu głębi, więc ich boki przechodziły przez nawierzchnię.
- Boki miały własną geometrię, niezależną od krawędzi wstęgi. Teraz powstają z tych samych punktów co krawędź nawierzchni.
- Obwódka i nawierzchnia leżały na różnych wysokościach. Teraz mają tę samą wysokość, a kolejność ustala bufor głębi.
- Płyta mostu miała rzadkie wierzchołki i była obniżona o 0,3 m. Teraz ma gęstą siatkę opartą na niwelecie pomostów.
- Równoległe jezdnie liczono niezależnie. Sprzężone są wyłącznie jezdnie stykające się bokiem na tym samym poziomie, o różnicy gruntu do 1 m, oraz jezdnie w jednym obrysie `man_made=bridge`.

Ścieżki przy nasypach i drogi na wyraźnie innym terenie pozostają niezależne, więc część stopni między nimi jest zamierzona (54 przekroje, do 4,58 m).

## Podpory estakad

Trójkątne bryły pod estakadami były artefaktem renderera: ściany boczne pomostów i dojazdów schodziły przy końcach aż do gruntu. Inwentaryzacja objęła cały wycinek.

| Miara | Przed | Po |
|---|---:|---:|
| Odcinki ścian zwisające poniżej grubości pomostu | 265 na 111 trasach, do 11,06 m | 0 |
| przy przyczółkach pomostów | 166 (4454 m) | 0 |
| na nasypach i dojazdach | 99 (2454 m) | 0 |
| Podpory z OSM (`bridge:support`) | 0 w danych | 0 |
| Podpory wywnioskowane z geometrii | brak | 213 |

Reguła: pod podniesioną trasą bez zmapowanej podpory generator stawia słup co około 32 m, jeśli pod spodem pomostu jest co najmniej 1 m wolnej przestrzeni. Słup nie powstaje w wodzie, w budynku ani na trasie biegnącej niżej; szuka wtedy miejsca w pobliżu albo rezygnuje. Pominięto 19 stanowisk z powodu wody i 9 z powodu tras. Dla 2 tras bez żadnej możliwej podpory diagnostyka zgłasza `support-unplaced`.

Kontrola niezależna: góra każdego słupa leży na spodzie pomostu, podstawa na NMT, a na rysunku stopa schodzi do najniższego punktu rysowanego terenu pod sobą (teren dopasowany do tras bywa niżej niż NMT; bez tego 52 podpory wisiały do 2,9 m nad terenem, teraz 0 z 219), a kolizji z trasami niżej, budynkami i wodą jest 0. Podpory wywnioskowane są osobną, wyłączalną warstwą, mają identyfikatory `inferred:support:…`, nie mają tagów i nie są obiektami OSM. Tag `bridge:support` w danych utworzy podporę źródłową, która ma pierwszeństwo. `man_made=pier` pozostaje pomostem.

Rondo Mościckiego i ulica Marsa leżą w wycinku (35 podpór w promieniu 260 m). Kandydat na rondo Marsa z `06-inwentaryzacja-zrodel.md` (way 302956384) leży poza zasięgiem danych, więc nie został sprawdzony w scenie.

Porównania przed i po: `docs/podglad/podpory-*.jpg`.

## Schody `highway=steps`

**Decyzja.** Schody są bryłami stopni i spoczników liczonymi przez `web/src/core/steps.js` z tagów, wysokości sieci i sekcji `steps` profilu kraju. Warstwy wyglądu są rozdzielone: materiał stopni ma własny shader z proceduralną fakturą dobraną przez `surface`, a różowa linia jest osobną wstęgą nad krawędziami stopni. Kolor linii nie jest mieszany z materiałem.

| Parametr | Źródło | Gdy brak danych |
|---|---|---|
| Liczba stopni | `step_count` | wysokość biegu / 0,16 m, ograniczona minimalną głębokością 0,22 m |
| Wysokość stopnia | różnica wysokości sieci / liczba stopni | `step:height` służy tylko do kontroli zgodności |
| Kierunek | wysokości sieci, potwierdzane przez `incline` | sprzeczność jest raportowana i nie zmienia wysokości |
| Szerokość | `width` | szerokość klasy, oznaczona jako przybliżona |
| Spocznik | założenie profilu: co 12 stopni, 1,2 m, jeśli bieg ma dość długości | brak spocznika |
| Materiał | mapowanie `surface` w profilu | neutralny materiał zastępczy |

Końce biegu leżą dokładnie na wysokościach węzłów, więc schody stykają się z dojściami. Way pozostaje zwykłym obiektem sieci: zachowuje `layer`, relacje, przecięcia i kontrole kolizji. Edycja `step_count`, `surface`, `incline`, `width` lub `step:height` przelicza schody od razu i można ją cofnąć.

**`placement` (Proposal:Placement, wiki OSM).** Pasy liczy się od lewej, patrząc w kierunku wayu; pas 1 jest skrajnie z lewej. `left_of:N`, `middle_of:N` i `right_of:N` oznaczają, że way biegnie po lewej krawędzi, środkiem albo po prawej krawędzi pasu N. Bez tagu way leży w osi całej jezdni. Na drodze dwukierunkowej obowiązuje wariant `:forward` lub `:backward`: liczy się tylko pasy tego kierunku, patrząc w tym kierunku (podział z `lanes:forward` i `lanes:backward`), więc przy ruchu prawostronnym pas 1 każdego kierunku leży przy osi jezdni. Gdy podane są oba warianty i wskazują różne położenie, użyty jest `:forward` i powstaje zgłoszenie. `:start` i `:end` zmieniają położenie liniowo wzdłuż wayu. `placement=transition` oznacza odcinek przejściowy: łączy krawędzie sąsiednich odcinków, więc oś i szerokość jezdni przechodzą liniowo od sąsiada na początku do sąsiada na końcu, a sąsiedzi zachowują swoje położenie aż do węzła. Kilka odcinków przejściowych z rzędu (np. `lanes=3` i `lanes=4` przed rozwidleniem) tworzy jeden ciąg: szerokość zmienia się liniowo wzdłuż całego ciągu, więc na stykach nie ma uskoku. Gdy odcinek przejściowy kończy się w rozwidleniu, jego szerokością końcową jest suma szerokości gałęzi. Szerokość jezdni bez tagu `width` wynika z `lanes × 3,25 m`, a dopiero bez `lanes` z domyślnej szerokości klasy; na odcinku przejściowym końce przejmują szerokość sąsiadów. Gdy szerokość z liczby pasów odcinka przejściowego leży poza zakresem szerokości sąsiadów (np. 3 pasy → `transition` z `lanes=4` → 3 pasy), tej liczby pasów nie da się pokazać i powstaje zgłoszenie `transition-lanes`. Zwykle oznacza ono błędne `lanes` u sąsiada. Na odcinku przejściowym z `lanes` są linie pasów i strzałki z `turn:lanes`. Na jezdni jednokierunkowej bez `width:lanes` układ pasów wynika z sąsiadów. Na każdym końcu ciągu jest tyle pasów, ile ma sąsiednia jezdnia (przy rozwidleniu: suma pasów gałęzi). Pas istniejący tylko na jednym końcu zwęża się liniowo do zera po stronie ruchu (przy ruchu prawostronnym po prawej) i ma własną linię. Pas pojawiający się i zanikający jest więc widoczny, np. 4 → 3 na `w1581884864` i 3 → 4 na `w827868860`–`w1581884860`. Strona zmiany jest założeniem, oznaczonym w inspektorze jako przybliżenie; dokładny przebieg podaje `width:lanes:start`/`:end`. W pozostałych przypadkach pasy zachowują szerokość z tagów, a zmianę szerokości przejmuje skrajny pas od strony ruchu; na jezdni dwukierunkowej pasy dzielą szerokość równo.

**Szerokość pasów (`width:lanes`).** `width:lanes` (Key:*:lanes) podaje szerokości pasów w metrach, oddzielone `|`, od lewej, patrząc w kierunku jazdy tych pasów. Puste pole oznacza szerokość domyślną: `width` podzielone przez liczbę pasów albo 3,25 m z profilu. Obsługiwane są warianty `:forward` i `:backward` oraz sufiksy `:start` i `:end`. Sufiksy pochodzą z porzuconej propozycji Suffix start and end, ale wiki używa ich w przykładach Proposal:Placement i Lanes. Na jezdni jednokierunkowej szerokości podaje się w kierunku ruchu, więc przy `oneway=-1` są odwracane względem wayu. Na drodze dwukierunkowej przy ruchu prawostronnym pasy przeciwne leżą z lewej strony wayu. Wartość z `:start` obowiązuje na pierwszym węźle, a z `:end` na ostatnim; brakująca wartość pochodzi z `width:lanes`, a potem z wartości domyślnej. Każda granica pasa przesuwa się liniowo między tymi położeniami, więc pas o szerokości 0 zanika płynnie. Na przykład `lanes=3` z `width:lanes:end=||0` daje jezdnię zwężającą się z 9,75 m do 6,5 m. Od szerokości pasów zależą szerokość rysowanej jezdni, linie pasów, położenie `placement` i strzałki. Strzałki na pasie węższym niż 1 m w miejscu strzałki nie ma. Odcinek `transition` z `width:lanes` ma szerokości końców z tagów, a nie od sąsiadów. Błędy są zgłaszane jako `width-lanes-value` (pole nie jest liczbą), `width-lanes-count` (liczba pól różna od liczby pasów) i `width-lanes-split` (brak podziału na kierunki); szerokość pasów pozostaje wtedy domyślna. W wycinku nie ma jeszcze tagów `width:lanes`. Działanie sprawdzono testami logiki i próbną edycją w sesji (`width:lanes:end=|||0` na `w1581884864`).

**Linie krawędziowe.** Jezdnia z oznakowaniem pasów (`lanes`, bez `lane_markings=no`) ma po obu stronach białą ciągłą linię krawędziową zamiast ciemnej obwódki. Linia leży na nawierzchni, w warstwie oznakowania, więc gdy dwie jezdnie stykają się lub nachodzą na siebie, między nimi widać ciągłą linię, jak w rzeczywistości (rozwidlenia, jezdnie dwujezdniowe). Szerokość linii to 0,16 m (`edgeLineWidthMeters`), a linia leży 0,25 m od brzegu nawierzchni (`edgeLineInsetMeters`); oba wymiary są założeniami profilu. Odsunięcie zostawia za linią pas asfaltu: bez niego biała linia przy samym brzegu zlewała się z jasnym terenem obok jezdni (odczyt pikseli: linia 233,231,223, teren 236,·,219). Linia podąża za zmienną szerokością jezdni (`transition`, `width:lanes`).

Linia jest przerywana tam, gdzie leży na innej jezdni tego samego poziomu (różnica do 1,5 m) połączonej z nią wspólnym węzłem: u wlotu drogi bocznej i we wnętrzu skrzyżowania. Pod uwagę brany jest pas jezdni bez zaokrąglenia jej końca, więc po stronie przeciwnej do wlotu linia przechodzi przez węzeł. Linii nie przerywa kontynuacja tej samej jezdni (dwie jezdnie w węźle albo jezdnie biegnące w nim prawie na wprost, do ok. 37°), gałąź rozwidlenia, jezdnia na innym poziomie (wiadukt) ani jezdnia bez wspólnego węzła; równoległe jezdnie nachodzące na siebie mają więc ciągłe linie. Linia jest przerwana na każdym przejściu przez jezdnię, malowanym i nieoznakowanym (ścieżka przez węzeł jezdni, `footway=crossing` bez malowania; `crossZones`), na szerokości przejścia; w wycinku 40 takich przerw na przejściach nieoznakowanych. Linia kończy się dokładnie na linii krawędziowej drugiej jezdni: granica jest wyznaczana bisekcją (dokładność kilku milimetrów), a koniec jest dociągany do 2 m do punktu przecięcia z linią sąsiedniej jezdni, także gdy obie linie kończą się przed nim. Na 401 końców przy wlotach 214 leży na linii sąsiedniej jezdni, 177 przy jezdni bez linii krawędziowej, a 10 przy prawie równoległej linii (zmiana szerokości). Kawałki krótsze niż 1 m są pomijane.

Jezdnia z linią krawędziową ma obwódkę bez poszerzenia, w kolorze nawierzchni. Obwódka zostaje pod nawierzchnią jako podstawa ścian pomostu i wypełnienie styków, ale nie wystaje poza jezdnię. Wcześniej jezdnia na nasypie (rysowana jak pomost, nad innymi nawierzchniami) wystawiała obwódkę o 0,6 m na sąsiednią jezdnię na skrzyżowaniu: ciemny lub jednolity pas innego odcienia pod białą linią, przez który linia wyglądała, jakby wisiała nad drogą. Linie pasów i linie krawędziowe są odsuwane od osi tak jak krawędź nawierzchni: w wierzchołkach osi wzdłuż ukosu, a kreska przechodząca przez wierzchołek ma w nim punkt. Dzięki temu na łukach linie nie ścinają zakrętów i idą równo z jezdnią.

Oznakowanie dzieli kolejność rysowania z nawierzchnią, na której leży. Nawierzchnie na gruncie nie zapisują głębi i są zakrywane przez to, co rysuje się później (nasypy, pomosty, wyniesione ścieżki). Dlatego oznakowanie jezdni na gruncie jest w warstwie `markGround`, zaraz po nawierzchniach na gruncie i przed nasypami i pomostami. To, co zakrywa jezdnię, zakrywa więc także jej linie i strzałki. Wcześniej oznakowanie było w jednej warstwie nad pomostami i pozostawało widoczne nad wyniesioną ścieżką, która zakryła samą jezdnię. Oznakowanie jezdni na pomoście lub nasypie zostaje w warstwie `mark`, po jej nawierzchni. Dodatkowo oznakowanie jezdni jest powiązane z jej nawierzchnią buforem szablonu (stencil). Nawierzchnia jezdni, na gruncie i na nasypie lub pomoście, zapisuje wartość 1 w każdym pikselu, w którym przeszła test głębi. Ścieżka, chodnik lub plac na nasypie albo kładce (`raisedOther`) zapisuje w swoich pikselach 2, więc linie jezdni pod nią znikają. Ścieżka w poziomie gruntu (`groundOther`) nie zmienia oznaczenia: tam, gdzie leży na jezdni, jest przejściem, a zebra i linie zostają na wierzchu. Całe oznakowanie jezdni, na gruncie i na pomoście, jest rysowane tylko w pikselach z wartością 1. Odczyt kolorów pikseli w 60 losowych punktach linii krawędziowych na nasypach i mostach (kamera z góry) potwierdził, że linie przy brzegu pomostu są przy tej regule widoczne tak samo jak bez niej.

Linia krawędziowa leży w odległości połowy rysowanej nawierzchni, liczonej tak samo jak dla nawierzchni: w wierzchołkach osi, z odcinkiem przejściowym, z `width:lanes` i ze stopniowym zwężeniem lub poszerzeniem na 22 m przy styku z jezdnią innej szerokości, a między wierzchołkami liniowo. W wierzchołku osi linia idzie wzdłuż ukosu. Przy ostrym załamaniu (ta sama reguła co dla nawierzchni) po zewnętrznej stronie idzie po łuku, a po wewnętrznej przez punkt przecięcia odsuniętych krawędzi. Wcześniej linia trzymała się stałej szerokości i ukosu; przy stykach i na krótkich odcinkach osi odchodziła od boku nawierzchni nawet o 1,63 m (275 z 2781 wierzchołków ponad 5 cm). Kontrola `auditEdgeAlignment` (konsola) mierzy odległość każdego punktu linii krawędziowej od boku nawierzchni. Wynik: 78 772 punkty zgodne do 10 cm; poza tym 26 punktów to linie pasów zanikającego pasa (ta sama szerokość pociągnięcia), a 118 leży na samych końcach jezdni w strefie węzła. Linia nie wychodzi więc poza widoczną nawierzchnię jezdni: przy przyciętym lub zaokrąglonym końcu jezdni, na ostrym załamaniu, pod ścieżką, terenem czy bryłą. Linia nie może więc być widoczna tam, gdzie nawierzchni nie widać, niezależnie od przyczyny (teren, bryła, nasyp, inna konstrukcja). Renderer ma włączony bufor szablonu (`stencil: true`); w three.js 0.187 jest on domyślnie wyłączony.

Linie i całe oznakowanie poziome jezdni (linie pasów, strzałki) są rysowane tylko na nawierzchni, na której da się je wymalować. Profil ma dla każdego materiału flagę `markable`: asfalt, beton, kostka i płyty oraz „utwardzona, rodzaj nieokreślony” — tak; kamień, drewno, metal, żwir, grunt, trawa, „nieutwardzona” — nie. Jezdnia bez tagu `surface` ma linie oznaczone jako przybliżenie. Drogi dla pieszych, chodniki i ścieżki nie są jezdniami i nie mają linii.

Kontrola `auditEdgeLines` (konsola) sprawdza skrzyżowania trójwlotowe z wlotem bocznym (co najmniej 45°, bez rozwidlenia): po stronie przeciwnej do wlotu przerwa ma być do 0,5 m, a u wlotu co najmniej 80% szerokości drogi bocznej. Wynik w wycinku: 285 jezdni, 67,7 km linii, 20 takich skrzyżowań, 0 przerw po stronie przelotowej, 0 wlotów z linią; żadna linia na chodniku ani na nawierzchni nieutwardzonej, 7 jezdni bez `surface` z linią jako przybliżeniem. Przeliczenie całego planu nawierzchni z liniami krawędziowymi trwa 43–60 ms.

**Ciągłość linii pasów.** Na styku dwóch jezdni z pasami, gdy w węźle nie ma innej jezdni, oraz w rozwidleniu i złączeniu linie pasów biegną do samego węzła, bez 6-metrowego odstępu skrzyżowania. Rytm kresek (3 m kreska, 6 m przerwa) jest liczony wzdłuż całego ciągu jezdni, także gdy sąsiednie waye mają przeciwny kierunek zapisu. Kreska przecięta węzłem kończy się na sąsiedniej jezdni. Odstęp zostaje przy skrzyżowaniu z inną jezdnią i na wolnym końcu, a strefy przejść nadal przerywają linie. W wycinku dotyczy to 147 jezdni.

**Rozwidlenia i złączenia jezdni.** Gdy z jednego pnia wychodzą co najmniej dwie jezdnie w tę samą stronę (kąt do 60°), a pień jest odcinkiem przejściowym albo ma tyle pasów, ile gałęzie razem (i ich łączną szerokość z tolerancją 15%), gałęzie są rysowane obok siebie w przekroju pnia, w kolejności z geometrii. Bez tego obie gałęzie startowałyby na osi pnia i nachodziły na siebie, a pień zwężałby się do szerokości jednej z nich. Przesunięcie trwa tak długo, jak gałęzie na siebie nachodzą. W każdym punkcie gałąź jest odsuwana o brakujący odstęp: w węźle o pełne położenie w przekroju pnia, dalej proporcjonalnie do 1 − odległość / wymagany odstęp. Najpóźniej 10 m przed drugim końcem wayu przesunięcie wygasa, więc tamto połączenie zostaje na miejscu. W danych łącznik `w187536252` i droga `w28966008` biegną 4,3–6,4 m od siebie przy szerokości 6,5 m każda; bez rozsunięcia nachodziły na siebie do 2,2 m i zakrywały pas. Gałąź bez sąsiedniej gałęzi (np. przy relacji `connectivity` z jedną gałęzią) wraca na swoje miejsce na 30 m. Styk gałęzi z pniem jest prostopadły do kierunku pnia z danych, więc krawędzie pnia przechodzą w zewnętrzne krawędzie skrajnych gałęzi. Przy pniu z `placement` gałęzie układają się wokół narysowanej osi pnia. Dane OSM pozostają bez zmian. W wycinku jest 24 takich węzłów; `geometryAudit` sprawdza je osobno (`forks`, `maxForkStep`), a największa różnica krawędzi wynosi poniżej 0,1 mm. Rozwidlenie bez zgodnej liczby pasów, np. jezdnia czteropasowa z odchodzącą drogą serwisową bez `lanes`, pozostaje zwykłym węzłem.

**Połączenia pasów (`type=connectivity`, wiki OSM: Relation:connectivity, status zatwierdzony).** Relacja ma członków `from` (way), `via` (węzeł albo way lub wayje) i `to` (way) oraz tag `connectivity`, np. `1:1|2:2,(3)`. Pasy liczy się od lewej, patrząc w kierunku jazdy od `from` do `to`, pas 1 jest skrajnie z lewej. Kilka pasów docelowych oddziela przecinek, nawias oznacza połączenie wymagające zmiany pasa, a `bw` pas `both_ways`. Moduł `web/src/core/connectivity.js` wyznacza z relacji położenie gałęzi w przekroju pnia przy złączeniu lub rozwidleniu. Gałąź leży przy węźle `via` dokładnie na pasach pnia, z którymi się łączy, i przy węźle zwęża się lub poszerza do ich szerokości. Na przykład łącznik z `connectivity=1:3|2:3` zajmuje przy węźle tylko prawy pas trzypasowej jezdni. Pozostała gałąź bez relacji dostaje wolne pasy pnia, gdy tworzą ciągły blok o jej liczbie pasów; jest to oznaczone w inspektorze jako wywnioskowane. Do położenia liczą się połączenia bez nawiasu, a połączenia w nawiasie tylko wtedy, gdy innych nie ma. Węzeł opisany relacją nie podlega rozpoznaniu rozwidlenia z liczby pasów. Inspektor pokazuje „Połączenie pasów” ze źródłem relacji.

Zgłoszenia (`connectivity-*`): błędna składnia wartości, pas spoza zakresu, brak liczby pasów w kierunku jazdy, `from` lub `to` niekończące się w węźle `via`, węzeł bez jednego pnia. `via` będące wayem jest raportowane: połączenie jest w danych, ale prototyp wyznacza położenie jezdni tylko przy `via` będącym węzłem. W wycinku nie ma jeszcze żadnej relacji `connectivity`. Działanie sprawdzono testami logiki i relacjami wstawionymi tylko w pamięci przeglądarki dla złączenia `w28966008` + `w187536252` → `w1581884863` (`1:3|2:3`) i rozwidlenia `w1581884860` → `w23645777` (`3:1|4:2`). Wynik: 25 rozwidleń i złączeń z różnicą krawędzi poniżej 0,1 mm, oznakowanie bez błędów.

Gdy różne położenia stykają się bez odcinka przejściowego, przesunięcie wygładza się na 30 m przy węźle, aby jezdnia pozostała połączona. Specyfikacja ma status propozycji (Draft), a klucz `placement` jest używany de facto. W wycinku jest 24 wayów z `placement`, wszystkie jednokierunkowe. Trzy z nich to odcinki przejściowe na Moście Siekierkowskim, a żaden nie ma `:start/:end`; obsługę pozostałych wariantów potwierdzają testy logiki.

**Stan w wycinku:** 60 schodów i 897 stopni. Tagi: `step_count` 3, `surface` 15, `incline` 28. Audyt: 0 rozjazdów z węzłami i 0 linii poza zakresem wysokości biegu; linia jest widoczna we wszystkich 25 sprawdzonych miejscach. W żadnym miejscu materiał obok linii nie przyjął jej koloru. Bieg zaczyna się na krawędzi trasy dochodzącej (sekcja „Połączenia geometrii”).

**Ograniczenia:**
- Wysokość biegu pochodzi z modelu sieci, a nie z pomiaru schodów. Przy wyliczonym stopniu spoza 0,10–0,22 m diagnostyka zgłasza `steps-riser`.
- 57 z 60 schodów ma liczbę stopni z założenia, a 45 neutralny materiał.
- 5 schodów nie ma różnicy wysokości w modelu i stopnie są tam tylko podziałem biegu.
- Spoczniki są założeniem, bo OSM ich tu nie opisuje. Poręcze i rampy z tagów nie są jeszcze modelowane.
- Dokumentacja OSM opisuje `step:height` przede wszystkim dla obszarów i budowli, dlatego na schodach pełni tylko rolę kontrolną.

## Nawierzchnie, linie przebiegu i oznakowanie

**Decyzja.** Drogi, chodniki, ścieżki piesze, ścieżki rowerowe i schody korzystają z jednego modelu w `web/src/core/surfaces.js` oraz sekcji `surfaces` profilu kraju (profil 0.6.2). Obraz składa się z trzech niezależnych warstw:

1. **Nawierzchnia:** kolor i proceduralna faktura materiału dobranego przez `surface`.
2. **Linia przebiegu:** schematyczna wstęga w kolorze klasy, prowadzona po geometrii OSM. Ma osobne przełączniki dla dróg, rowerów i pieszych, podrzędne wobec warstwy głównej.
3. **Oznakowanie poziome:** osobna warstwa powstająca wyłącznie z tagów.

Wyłączenie linii lub oznakowania nie przebudowuje geometrii i nie zmienia materiału. Kolizje, poziomy i wybór obiektu nadal opierają się na tych samych wayach.

| Element | Tag | Zachowanie | Gdy danych brak lub są sprzeczne |
|---|---|---|---|
| Materiał | `surface` | mapowanie w profilu, `paved` i `unpaved` mają własne materiały „rodzaj nieokreślony” | materiał neutralny; nieznana wartość daje `surface-unknown` |
| Szerokość jezdni | `width`, potem `lanes` | `lanes` × 3,25 m, oznaczone jako przybliżone | szerokość klasy |
| Linie pasów | `lanes` | przerywane linie rozdzielające pasy | bez `lanes` nic nie powstaje; `lane_markings=no` wyłącza linie |
| Pewność linii | `lane_markings` | `yes` potwierdza malowanie | bez tego tagu linie są „układem pasów”, w jaśniejszym kolorze i z oznaczeniem „przybliżone” |
| Strzałki | `turn:lanes`, `:forward`, `:backward` | jedna strzałka na wskazany kierunek pasa | inna liczba pasów niż w `lanes` daje `turn-lanes-count` i brak strzałek |
| Położenie jezdni | `placement`, `placement:forward`, `placement:backward`, każdy także z `:start` i `:end` | przesuwa rysowaną jezdnię, a nie dane OSM; szczegóły niżej | wartość błędna, pas spoza zakresu, brak podziału kierunków lub `placement` bez wariantu na drodze dwukierunkowej: raport i jezdnia na osi |
| Przejście dla pieszych | `crossing=marked`, `crossing:markings=yes`, wartość `zebra` lub `ladder` | zebra; `marked` i `yes` dają ją na obiekcie pieszym | samo `footway=crossing`, `no`, `unmarked`, `uncontrolled`, `traffic_signals`: brak malowania |
| Przejazd rowerowy | `crossing:markings=dots` albo `crossing=marked` lub `crossing:markings=yes` na obiekcie rowerowym | dwa rzędy kwadratów, szerokość 2,5 m z założenia profilu | samo `cycleway=crossing` nie tworzy wzoru |
| Linie przejścia | `crossing:markings` = `lines`, `dashes` | linie krawędziowe | inne wartości nie tworzą linii |

Znaczenie wartości tagów jest w `surfaces.crossingMarkings` profilu kraju. `footway=crossing` i `cycleway=crossing` mówią tylko, że way jest przejściem, i same nie tworzą malowania. Tag na wayu przejścia obejmuje cały jego przebieg. Tag na węźle `highway=crossing` trafia do wayu właściwego rodzaju i maluje **wyłącznie odcinek przy tym węźle**, więc przejście przez dwie jezdnie może mieć zebrę tylko na jednej. Ogólne `marked` i `yes` daje zebrę wayowi pieszemu, a wzór przejazdu wayowi rowerowemu; samo `foot=designated` na drodze rowerowej nie dodaje zebry. Węzeł bez wayu przejścia tworzy zebrę, a wzór przejazdu tylko przy `bicycle=designated` albo przy `bicycle=yes` z `foot=no`. Dla wartości jawnych, gdy pasującego wayu nie ma, wzór powstaje w węźle na jezdni.

Malowanie obejmuje odcinki leżące na jezdni oraz ścieżkę rowerową, którą przejście faktycznie przecina we wspólnym węźle; ścieżka dochodząca do końca przejścia się nie liczy. Wzór jest prowadzony prosto między końcami odcinka, także gdy way załamuje się na jezdni. Na ścieżce pasy są drobniejsze i kończą się na jej krawędzi. Malowanie nie przechodzi przez pasy rozdziału. Oś linii i oznakowanie korzystają z wysokości sieci. Pomost zasłania je tylko wtedy, gdy rzeczywiście leży wyżej. Założona szerokość z `lanes` służy tylko do rysowania i nie wpływa na wyznaczanie poziomów.

### Jakość powierzchni terenu i faktura nawierzchni

**Nakładka obszarów** na teren ma 8192 px na dłuższy bok wycinka (ok. 0,55 m na piksel przy 4,5 km; wcześniej 4096 px i 1,1 m). Osobna **maska materiału terenu** (4096 px; kanały: roślinność, piasek, woda) jest rysowana z klas obszarów razem z nakładką. W shaderze terenu decyduje ona o fakturze, zamiast zgadywać ją z odcienia koloru. Roślinność (trawa, park, zarośla, las, teren podmokły) ma kępy (ok. 5 m), drobną fakturę (ok. 0,4 m) i jaśniejsze, suchsze plamy. Pozostały teren ma delikatne nierówności, a woda zostaje gładka.

**Faktura asfaltu** (wzór `speckle`) to suma gładkiego szumu: ziarno ok. 8 cm i 2,5 cm, pojedyncze kamyki i plamy zużycia ok. 3 m. Wcześniej były to twarde, rzadkie kropki o boku 3 cm. Faktury liczone są w metrach świata i nie zajmują pamięci. Każda skala szumu wygasa, zanim jej oczko zmaleje do rozmiaru piksela, więc z daleka faktura nie migocze.

Pomiar zmienności jasności (odchylenie standardowe w łatach pikseli pełnej klatki): trawa 6,5–7,7 (wcześniej ok. 0,5, czyli jednolita), asfalt z bliska 3,2 (wcześniej 0,35), z daleka 0,8. Czas odrysowania klatki w ustalonym widoku w panelu przeglądarki bez zmian (0,84 ms); pomiaru w 5120×1440 na docelowym sprzęcie nie wykonano. Odrysowanie nakładki 8192 px trwa ok. 6 ms. Kontrole oznakowania, przejść i schodów bez błędów.

### Przecięcia oznakowania i kolejność warstw

Jezdnia zachowuje wolną strefę wokół każdego przejścia, także bez malowania, oraz wokół ścieżki przechodzącej przez nią we wspólnym węźle. Kreski pasów są w niej przycinane, a strzałki cofane przed strefę razem dla całego kierunku. Strzałka, która po cofnięciu nie mieści się na wayu, jest pomijana. Inspektor pokazuje obie sytuacje jako przybliżenie.

Linia trasy pozostaje ciągła i niezależnie przełączana; przełącznik „Wszystkie linie przebiegu” w panelu warstw wyłącza i włącza naraz linie dróg, rowerów, pieszych i wody, także na schodach. Cieki (`waterway=river`, `canal`, `stream`, `ditch`, `drain`) mają własną grupę „Linie przebiegu: woda” w kolorze #1f9cc4. Linia cieku jest schematem niezależnym od nawierzchni i nie tworzy stref przejść na jezdniach. Linia jest schematem informacyjnym: odcinek w tunelu, przepuście lub przejściu ma jaśniejszy odcień koloru trasy (55% bieli) i leży pod liniami tras na gruncie. Na malowaniu leżącym na jezdni zwęża się do 30% szerokości z przejściem 1 m, a kolor relacji jest tam przerywany. Na ścieżce rowerowej zachowuje pełną szerokość. Malowanie leży nad nią, więc linia niczego nie zasłania.

| Kolejność (od spodu) | Warstwa | Sposób nakładania |
|---|---|---|
| 1 | Teren i obszary | teren wyprofilowany pod trasy zapisuje głębię z zapasem 1 m rosnącym z odległością i rozmiarem oczka kafla, więc wzniesienia przesłaniają obiekty za nimi, a zgrubny kafel nie ucina tras; nad tunelem zapas wynosi około 0,5 m, a teren w obrysie tuby jest wycięty |
| 1b | Oznakowanie jezdni na gruncie (`markGround`) | test głębi bez zapisu; po nawierzchniach na gruncie, przed nasypami i pomostami |
| 1a | Posadzka tunelu (`tunnelFloor`) | test i zapis głębi przed nawierzchnią tunelu, która leży na niej |
| 2 | Obwódki i nawierzchnie na gruncie (`casing`, `ground`); `sunk` i `lineSunk` (bez testu głębi) tylko dla trasy pod ziemią bez bryły tunelu | test głębi bez zapisu; trasa dochodząca jest rysowana przed trasą, do której dochodzi |
| 3 | Bryły, tuba tunelu, schody, konstrukcje, pomosty (`solid`, `tunnel`, `stairs`, `structure`, `raised`) | test i zapis głębi; płyta mostu leży 20 cm pod trasami swojego poziomu; budynki i bryły w obrysie tuby są wycięte |
| 4 | Oznakowanie poziome (`mark`) | test głębi, bez zapisu; jest częścią nawierzchni |
| 5 | Punkty (`point`) | test głębi |
| 6 | Linie przebiegu i linia na schodach (`line`, `stairLine`) | schemat na wierzchu: bez testu głębi, więc nie przesłania ich żadna bryła, teren ani tekstura; kolejność wynika z poziomu (tunel, grunt, pomost 1, 2…), a w poziomie z klasy |

Kolejność jest zapisana w stałej `LAYER_ORDER` w `web/src/render/features.js`.

### Przesłanianie i dopasowanie terenu

Teren i płyty mostów zapisują głębię, a warstwy nakładane mają stałe przesunięcie, które nie przebija ścian w widoku skośnym.

Trasa ma wysokość w węzłach i między nimi biegnie gładko. NMT zawiera nierówności i bywa nad tą linią, więc to **rysowany teren jest dopasowany do tras**, jak grunt wyprofilowany pod drogę: w pasie trasy przyjmuje jej wysokość, a na kolejnych 7 m łagodnie wraca do NMT (`web/src/render/groundConform.js`). Dotyczy to tras na gruncie i nasypach, torów i cieków; nie dotyczy mostów ani tuneli. Gdzie spotyka się kilka tras, teren przyjmuje wysokość najniższej. Dane NMT, wysokości tras, poziomy i kolizje nie są zmieniane. Prowadzenie tras po surowym NMT zostało odrzucone, bo przenosiło jego nierówności na drogi i ścieżki.

Płyta mostu leży 20 cm pod najniższą trasą swojego poziomu w pobliżu, a jej wysokość wynika z próbek co 3 m wzdłuż całych odcinków. Trasy biegnące pod mostem, ponad 2,5 m niżej, nie obniżają płyty. Tunele mają własną bryłę, opisaną w sekcji „Tunele, przejścia i przepusty”.

Teren poza obszarem opracowania nie jest przygaszany; granicę obszaru pokazuje tylko linia przerywana. Scena pojawia się po wczytaniu szczegółów i pierwszych kafli terenu.

Inspektor pokazuje sekcję „Nawierzchnia i oznakowanie” ze źródłem każdej wartości i oznaczeniem przybliżeń. Edycja `surface`, `lanes`, `turn:lanes`, `placement` lub `lane_markings` przelicza plan od razu (zmierzone 50–65 ms na ulicy czteropasowej) i można ją cofnąć. Zaznaczenie tylko barwi nawierzchnię, aby zmiana materiału była widoczna.

**Stan w wycinku:** 1884 trasy, z tego 1039 z `surface` i 845 z materiałem neutralnym. `lanes` ma 279 tras, linie pasów 206, strzałki 83, `lane_markings=no` 18, przesunięcie z `placement` 16. Przejścia: 25 wayów z malowaniem (12 z własnego tagu, 13 z tagu węzła) i 27 malowań w samych węzłach; wzory razem: zebra 44, przejazd rowerowy 8. Trzy zestawy `turn:lanes` są niezgodne z liczbą pasów i pozostają bez strzałek.

**Audyt (`auditSurfacing`):** 0 linii pasów i 0 strzałek bez tagu źródłowego, 0 kresek i 0 strzałek na obszarze malowanych przejść. Malowanie przejść jest widoczne przy włączonych liniach w 25 z 25 miejsc. Próbki pikseli: drogi 19/19, rowery 18/18, piesi 17/17 (2 miejsca pominięte, bo przykrywa je inna trasa): linia widoczna, obok niej materiał, po wyłączeniu linii w tym samym miejscu materiał. Linie pasów: 16/16 widoczne i 16/16 znika po wyłączeniu. Poziomy, prześwity, LOD i kolizje bez zmian.

Szersze jezdnie zmieniły dwa wskaźniki pochodne: podpór wywnioskowanych jest 219 zamiast 212 (nadal 0 kolizji), a próbek styku płyty mostu z pomostem powyżej 10 cm 71 zamiast 64, przy niezmienionych maksimach 0,59 i 0,48 m.

Podgląd: `docs/podglad/nawierzchnia-*.jpg` i `docs/podglad/polaczenia-*.jpg`.

### Połączenia geometrii

Poprzednie połączenia oparte na zaokrąglonych końcach dawały bulwy, nakładanie faktur i szczeliny, dlatego zasada została zmieniona:

- **Styk boczny na gruncie:** trasa dochodzi do węzła płaskim końcem i jest rysowana pod trasą główną. Krawędź styku tworzy trasa główna, bez łuku i bez szczeliny, także na łuku drogi. Chodnik lub ścieżka leży też pod trasą biegnącą tuż obok, więc jej nie przykrywa.
- **Pomosty:** tam kolejność wynika z głębi, więc trasa dochodząca leży do 6 cm niżej. Pomost stykający się z nawierzchnią na gruncie jest przycinany do jej krawędzi.
- **Faktura** jest liczona we współrzędnych świata, dlatego ten sam materiał przechodzi między trasami bez uskoku. Zmiana materiału jest ostrą granicą w węźle, bez mieszania kolorów.
- **Zakręt między dwiema trasami** powyżej 60° jest gładkim łukiem o szerokości trasy, a nie szpicem. Kontynuacje poniżej tego kąta mają wspólne ścięcie.
- **Koniec bez połączenia** jest płaski; zaokrąglenie zostaje tylko na końcu jezdni.
- **Schody** są bryłą zaczynającą się na krawędzi trasy dochodzącej. Dojście kończące się przy schodach ma prostokątny koniec, a linia na schodach ma szerokość linii dojścia.

Wynik audytu połączeń: 2309 węzłów, 8 miejsc ze szczeliną (razem 3,8 m²) i 1 z nadmiarem obrysu (0,4 m²), 0 uskoków krawędzi i szerokości. Wszystkie szczeliny dotyczą pomostu lub nasypu stykającego się z inną trasą. Audyt nie wymaga już nawierzchni za płaskim końcem trasy, co jest zmianą kryterium. Schody: 0 rozjazdów z węzłami, linia widoczna w 25 z 25 próbek. Wydajność przy 5120 × 1440 na RX 6750 XT: 164,7–164,8 kl./s, 1% najwolniejszych 161,3 kl./s, do 2,17 mln trójkątów, do 589 wywołań rysowania; wynik jest ograniczony odświeżaniem ekranu.

**Ograniczenia:**
- Krótszy bieg zmniejszył liczbę stopni wyliczanych z założenia: 897 zamiast 925. Diagnostyka `steps-riser` zgłasza teraz 4 biegi.
- Wzór przejazdu i szerokości przejść są schematem z profilu, a nie pomiarem malowania. Miejsce przejścia wynika z geometrii OSM.
- Przy równoległych rampach i nasypach pomosty różnych tras mogą się przecinać, bo OSM nie opisuje ich rzeczywistego ułożenia. Linia tras bywa tam częściowo zasłonięta (np. rejon x 43, y 556).
- Załamania linii przy schodach wynikają z geometrii wayów OSM i nie są wygładzane.
- Strefa wolna wokół ścieżki bez tagu przejścia jest zabiegiem czytelności i nie oznacza, że w terenie istnieje przejście.
- Płyta mostu nie ma własnej niwelety z pomiaru; jej wysokość wynika z tras na niej.
- Migotania nie mierzono ponownie po zmianie kolejności rysowania; ocena pochodzi z oglądu sprawdzonych widoków.
- `lanes` nie dowodzi istnienia malowania. Rodzaj, ciągłość i dokładne położenie linii nie wynikają z danych, więc rysunek pokazuje układ pasów, a nie inwentaryzację znaków. Linie ciągłe, krawędziowe, parkowanie i pasy rowerowe na jezdni nie są rysowane.
- Szerokość pasa 3,25 m jest założeniem profilu. Przy drodze bez `width` wpływa na szerokość jezdni, położenie strzałek i przesunięcie z `placement`.
- Materiał 845 tras pozostaje neutralny, ponieważ nie mają `surface`. Faktury są umowne i nie oddają wzoru ułożenia ani stanu nawierzchni.
- `change:lanes`, `width:lanes` i `lanes:both_ways` nie są jeszcze interpretowane.
- Przejście bez jezdni tego samego poziomu pod swoim przebiegiem ma tag, ale nie ma malowania na rysunku; inspektor to pokazuje.
- W repozytorium jest tylko profil polski. Niezależność od kraju sprawdza test na zmienionej kopii profilu (strona ruchu, szerokość pasa, mapowanie `surface`), a nie drugi rzeczywisty profil.

## Bariery, bramy i przejścia

**Decyzja.** Tag `barrier` jest modelowany w `web/src/core/barriers.js` i sekcji `barriers` profilu kraju, a nie jako linia na ziemi. Bariera liniowa jest bryłą o wysokości i grubości, z wzorem zależnym od typu; siatka, balustrada i bariera drogowa są ażurowe, więc widać przez nie otoczenie.

| Wymiar | Kolejność źródeł |
|---|---|
| Wysokość | tag `height`; wariant typu (`fence_type`, `wall`, `kerb`); typ `barrier`; dla typu nieznanego profilowi 1 m |
| Grubość bariery | tag `width`; typ `barrier` lub wartość domyślna |
| Szerokość bramy lub przejścia | `maxwidth:physical`, `maxwidth`, `width`; szerokość trasy przechodzącej przez węzeł; typ bramy |
| Materiał | tag `material`, gdy profil go zna |

Wartości z typu są założeniami profilu i inspektor oznacza je jako przybliżone. W danych wycinka żadna z 240 barier liniowych nie ma tagu `height`.

Bariera stoi na rysowanym terenie, czyli na NMT z dopasowaniem do tras. Podstawa jest wygładzona wzdłuż bariery, ale nie odchodzi od podłoża dalej niż o 20 cm (dla barier niskich o 20% wysokości), a dół ściany sięga gruntu. Górna krawędź biegnie więc płynnie, bariera nie zmienia wysokości i nie chowa się w skarpie. Bariery z `layer` powyżej 0 stoją na pomoście albo płycie mostu, jeśli przebiegają przy nich (niżej). Gdzie podłoże przechodzi skokowo z pomostu na teren, bariera jest dzielona na dwa odcinki zamiast tworzyć rampę. Bryły zapisują głębię, więc przesłaniają się poprawnie z terenem, jezdniami i budynkami.

Brama, szlaban, furtka lub wejście w węźle bariery tworzą w niej otwór. Trasa przechodząca przez węzeł bariery bez tagu daje otwór o szerokości trasy i zgłoszenie `barrier-passage-untagged`, ale nie tworzy bramy. Trasa kończąca się przy barierze nie tworzy otworu. Słupki, bloki i krawężniki są osobnymi bryłami.

### Bariera na konstrukcji i nad trasą przechodzącą pod nią

**Decyzja (2026-11-21).** Bariera nie zawsze idzie po terenie: tak jak droga, bariera na konstrukcji ma podłoże wynikające z konstrukcji, a nad trasą przechodzącą pod nią nie schodzi w wycięcie terenu. Przyczyna: ekrany akustyczne `w661448237` i `w545447660` (`barrier=wall`, `wall=noise_barrier`, `layer=1`) przy Alei Bohaterów Bitwy Warszawskiej 1920 stoją 10–11 m od krawędzi autostrady, więc nie miały pod sobą pomostu (szukanego do 2,5 m od jezdni). Stały więc na NMT i nad przejściem pieszym (chodniki na 89 m) schodziły o 7 m w wycięcie terenu i wracały.

- **Płyta mostu.** Bariera z `layer>0` lub `bridge` w obrysie `man_made=bridge` albo do 2,5 m od niego stoi na płycie mostu, tak jak trasa na pomoście. Wysokość płyty liczy ten sam próbnik co jej rysowanie (`FeatureRenderer._plate`). Pomost drogowy do 2,5 m od krawędzi jezdni ma pierwszeństwo jak wcześniej.
- **Przęsło nad trasą.** Gdy trasa niższego poziomu przecina barierę bez wspólnego węzła, bariera przechodzi nad nią jak przęsło (`plan.over`, `_bridgeDips`). Niższy poziom to `layer`, a bez niego tunel poniżej i most powyżej gruntu; dla bariery na konstrukcji także trasa bez poziomu. Przęsło biegnie od najwyższego punktu podłoża do 30 m przed przecięciem do najwyższego do 30 m za nim. Pomost i płyta są nieruchomymi podporami. Reszta bariery stoi na podłożu jak wcześniej.
- **Krawędź konstrukcji.** Na krawędzi pomostu lub płyty bariera nadal dzieli się na odcinki, gdy podłoże zmienia się skokowo, zamiast tworzyć rampę.

Pierwsza wersja z obwiednią ze spadkiem konstrukcji i cięciwami do 60 m wzdłuż całej bariery podnosiła też zwykły teren obok wycięcia o 3–5 m. Zastąpiło ją przęsło liczone tylko przy przecięciu.

**Wynik w oknie przy Alei Bohaterów Bitwy Warszawskiej 1920 (52 tys. obiektów):** oba ekrany mają trzy odcinki: nasyp ok. 96 m, płyta 94,6 m, nasyp 96,6–97,2 m. Spadek podstawy ≤ 2%, a najniższy dół 94,5 m zamiast 89 m. Regułę przęsła dostaje 14 barier, z czego 5 bez `layer`, nad tunelami. Na przykład ekran `w595236938` nad przejściem podziemnym na 69 m przeskakuje wycięcie terenu do 72,8 m na odcinku 31 m, a dalej stoi na terenie. Kontrola `auditBarriers` po zmianie: `floating` 0, `buriedBetween` 0. Największy spadek podstawy spadł z 4,29 do 2,83; pozostałe najwyższe wartości dotyczą zwykłych ogrodzeń na stromym terenie i są takie same jak przed zmianą.

### Ściana oporowa

**Decyzja (2026-11-22).** `barrier=retaining_wall` nie jest już rysowana jak płot o wysokości z profilu (1,2 m) stojący na terenie w osi linii. Wcześniej ściana wzdłuż rampy przejścia pod Aleją Bohaterów Bitwy Warszawskiej 1920 (`w545444972`, `w806172153`) była niskim płotkiem na stoku NMT, w połowie uskoku. Tagowanie jest poprawne. Według opisu tagu na wiki OSM (odczytanego przez taginfo, bo wiki miała awarię) niższa strona jest po prawej względem kierunku linii. W obu ścianach teren po lewej jest wyższy o 3,3–5,3 m.

- **Lico.** Ściana ma lico od terenu po niższej (prawej) stronie do terenu po wyższej (lewej). Teren jest odczytywany 1, 2 i 3 m od osi, bo NMT z siatką 1 m rozmywa uskok na ok. 1–2 m. Po niższej stronie liczy się najniższy odczyt, po wyższej najwyższy. Góra jest wygładzona wzdłuż ściany (±2 m).
- **Wysokość zastępcza.** Gdy teren nie pokazuje uskoku (mniej niż 0,3 m), ściana ma wysokość z tagu `height` albo z profilu, jak inne bariery. Znaczenia `height` dla ściany oporowej nie potwierdzono (wiki niedostępna), więc ten tag nie zastępuje uskoku zmierzonego w terenie.
- **Otwory.** Otwór w barierze robi tylko trasa na tym samym poziomie co bariera. Jezdnia wchodząca we wspólnym węźle na most (przyczółek przy ścianie) albo w tunel przechodzi nad lub pod barierą. Wcześniej obie ściany miały po dwa fałszywe otwory po 9,75 m na szerokość autostrady.

**Wynik w oknie przy moście (37 ścian oporowych, 1149 punktów profilu):**
- Obie ściany ze zgłoszenia są ciągłe, od ok. 89,3 m (dno przejścia) do 90,4–94,8 m (teren na górze).
- Wysokość lica: mediana 1,74 m, 90. percentyl 4,84 m, maksimum 7,8 m. Wysokość zastępczą ma 24% punktów.
- Przejść bez tagu w barierach jest 42 zamiast 63 (−21 fałszywych otworów).
- `auditBarriers`: `floating` 0. Kontrola zakopania dla ścian oporowych sprawdza, czy góra nie leży niżej niż teren w osi (z tolerancją 0,3 m); zostaje jeden przypadek, 0,5 m przy krótkiej ścianie `w1352412764`.

**Uzupełnienie (2026-11-22, zgodnie ze zdjęciem przejścia pod Aleją Bohaterów Bitwy Warszawskiej 1920 przy ul. Pustelnickiej):** ściany pod mostem są pionowe i sięgają spodu konstrukcji, chodnik biegnie tuż przy nich, a skarpy z kostki leżą na zewnątrz mostu.

- **Pod mostem.** Ściana w obrysie `man_made=bridge` albo do 2,5 m od niego kończy się na spodzie płyty mostu (wierzch płyty minus 1,3 m), a nie na poziomie jezdni na moście. Wcześniej przebijała płytę.
- **Dół ściany.** Najniższy odczyt terenu w oknie ±3 m wzdłuż ściany. Pod mostem NMT jest zaszumiony i pojedyncze odczyty skakały o kilka metrów.
- **Strona niższa.** Według konwencji OSM po prawej, chyba że NMT wyraźnie (średnio o ≥ 0,5 m, 2,5 m od osi) pokazuje odwrotnie. W oknie przy moście 5 z 37 ścian ma linię narysowaną odwrotnie do terenu (`w545441705` −7,5 m, `w545441708` −6,9 m, `w545444968` −4,1 m, `w661452537` −1,9 m, `w1352412764` −1,6 m). Dla nich decyduje teren; prawdopodobnie warto odwrócić je w OSM.
- **Teren przy ścianie.** Dopasowanie terenu (CPU, wszystkie ściany) obniża teren po niższej stronie do dołu ściany w pasie 4 m, z przejściem 3 m. Dotyczy tylko ścian z wyraźnym uskokiem w NMT (28 z 37). Wyższa strona zostaje bez zmian. Reguła „większa waga, przy pełnej niższa wysokość” nie przykrywa tras. Skarpy z NMT nie przechodzą już przez ściany: od 2 m od lica teren leży na dole ściany (wcześniej do 5 m wyżej).

**Odrzucone podejścia:**
- **Dociskanie terenu w shaderze do 64 najbliższych odcinków ścian.** Dawało ząbki i plamy terenu na drogach. Podnoszenie terenu po wyższej stronie przykrywało trasy, a limit odcinków zostawiał resztę ścian bez zmian.
- **Pochylona stopa ściany do 3 m.** Na zdjęciu ściany są pionowe. Stopę dostawały też ściany bez uskoku, a na 23% punktów zachodziła na chodniki.

**Cięcie terenu i posadzka (2026-11-22).** Siatka terenu ma oczka od 1 m przy kamerze do 4 m dalej, a dopasowanie 3 m, więc trójkąty przecinające ścianę wychodziły przed lico (ząbki u podstawy). Dla ścian z wyraźnym uskokiem w NMT:
- shader terenu odrzuca teren po niższej stronie w pasie 4 m od osi ściany;
- ściana ma w tym pasie posadzkę na poziomie swojego dołu, rysowaną materiałem terenu (ten sam kolor i faktura, bez dopasowania wysokości).

Odcinki ścian są zapisane w teksturze na siatce dopasowania (numer najbliższego odcinka w tekselu) i w teksturze danych odcinków. Shader liczy dokładną odległość i stronę piksela, także dla sąsiednich odcinków tej samej ściany. Działa to dla wszystkich ścian w zasięgu, bez limitu najbliższych.

**Reguły dołu ściany** (wspólne dla lica, posadzki i obniżenia terenu, więc na granicy pasa nie ma uskoku):
- teren z NMT bez dopasowania, najniższy z odczytów 1–3 m od osi i z osi;
- nie wyżej niż trasa na gruncie w pasie posadzki (chodnik, jezdnia w przejściu), ale najwyżej 2,5 m niżej niż teren. Głębiej leżą tylko trasy związane z tunelem lub jego wlotem, które mają własne konstrukcje; na przykład droga rowerowa przy wylocie tunelu z poziomem 65 m przy terenie 86 m obniżyłaby ścianę o 20 m;
- ściana oporowa nie dostaje przęsła nad trasą przechodzącą pod nią: obudowuje wykop, a nie przechodzi nad nim.

Góra ściany i ściany bez cięcia korzystają z rysowanego terenu, na którym faktycznie stoją. Dół ściany z cięciem nie zależy od dopasowania (dopasowanie wynika z dołu), a upraszczanie profilu zależy tylko od dołu. Dzięki temu wynik nie zależy od kolejności przeliczeń.

**Sprawdzenie w dwóch oknach (oba bez zmian w kodzie pod konkretne miejsce):**

| Kontrola | Okno startowe | Okno przy przejściu |
|---|---:|---:|
| Ściany z cięciem | 64 | 28 |
| Próbki pikseli w pasie posadzki z trzech kamer (z boku, z góry, wzdłuż ściany): dziury (kolor kontrolny tła) | 0 z 1152 | 0 z 504 |
| Teren przed licem tuż nad posadzką (bufor wyboru) | 0 z 119 | 1 z 56* |
| Posadzka nad płytką trasą w pasie | 0 | 0 |
| Widok przyrostowy względem pełnej przebudowy: różne kawałki / teksele dopasowania / teksele indeksu ścian | 0 / 0 / 0 | 0 / 0 / 0 |
| Dwie kolejne pełne przebudowy | 0 / 0 / 0 | 0 / 0 / 0 |

\* Ściana długości 6 m, próbka na jej końcu: linia wzroku przechodzi obok krawędzi ściany.

`auditBarriers` w obu oknach: `floating` 0, `buriedBetween` 1 (wygładzona góra 0,4 m poniżej terenu w osi na jednej ścianie). Kontrola zakopania pomija punkty pod płytą mostu, gdzie ściana kończy się na spodzie płyty.

**Ograniczenia:** w pasie posadzki teren jest płaski na poziomie dołu ściany, więc rzeczywiste nierówności po niższej stronie do 4 m od ściany nie są pokazane. Tekstura odcinków ma szerokość równą ich liczbie (w oknach 384–1100, limit tekstury 16 384).

**Ograniczenia:** wysokości typów są założeniami, a nie pomiarem. Stan bramy (otwarta lub zamknięta) nie wynika z tagów, więc skrzydło jest pokazane jako zamknięte. Wzory są schematyczne. Na stromych skarpach bariera idzie za terenem, więc jest tam równie stroma. Żywopłot z `natural=hedge` nie jest jeszcze ujęty.

## Dachy budynków (`roof:shape`)

**Decyzja (2026-11-22).** Dachy są modelowane według Key:roof:shape (lista kształtów z Template:Roof:shape) i Simple 3D Buildings. Obie strony odczytane 22.11.2026. Profil kraju ma sekcję `roofs` (profil 0.11.0).

**Reguły z dokumentacji:**
- `height` to wysokość do szczytu dachu; ściany mają `height` − `roof:height`; `min_height` to spód bryły.
- `building:levels` liczy kondygnacje bez dachu, `roof:levels` kondygnacje w dachu, każda po 3 m. Przykład z wiki: 3 + 1 kondygnacja = 12 m.
- Grzbiet biegnie wzdłuż dłuższego boku (`roof:orientation=along`, domyślnie); `across` obraca go w poprzek.
- `roof:direction` to kierunek, w który patrzy główna połać (stopnie albo N, NE…).
- Wartości opisane na wiki jako duplikaty są ujednolicane: `pitched` → `gabled`; `mixed`, `mix`, `Mix`, `multi` → `many`. `many` jest według wiki rysowany płasko (zalecane `building:part` z własnymi dachami).

**Wysokość dachu.** Kolejność źródeł: `roof:height`; potem `roof:angle` (wysokość liczona z szerokości budynku); potem `roof:levels` × 3 m. Bez tych tagów: **jedna kondygnacja (3 m)**, założenie profilu z decyzji Q&A, oznaczone w inspektorze jako przybliżenie. Bez `height` wysokość bryły to ściany z kondygnacji plus dach.

**Geometria (`web/src/render/roofs.js`), dla dowolnego obrysu:**
- Układ dachu wyznacza najmniejszy prostokąt opisany na obrysie (oś wzdłuż dłuższego boku).
- Kształty o płaskich połaciach to minimum zestawu płaszczyzn (dla `butterfly` maksimum): `gabled`, `hipped`, `half-hipped`, `skillion`, `saltbox`, `gambrel`, `mansard`, `round` (łuk z cięciw) i `butterfly`.
- Obrys jest dokładnie triangulowany. Każdy trójkąt jest przycinany do komórek wyznaczonych liniami przecięć płaszczyzn, więc każda połać jest płaska, połacie pokrywają dokładnie obrys (także wklęsły i z otworami), a ściany szczytowe i boczne dochodzą do połaci.
- `pyramidal`, `cone`, `dome` i `onion` są budowane pierścieniami od obrysu do wierzchołka nad środkiem ciężkości obrysu. Gdy środek leży poza mocno wklęsłym obrysem, dach zostaje płaski.

**Założenia prezentacyjne** (wiki pokazuje kształty tylko na rysunkach), w profilu w `roofs.parameters`:
- naczółek `half-hipped`: ściana szczytowa do połowy wysokości dachu;
- `saltbox`: krótsza połać zajmuje 1/3 szerokości;
- załamanie `gambrel` (1/4 półszerokości od okapu, 60% wysokości) i `mansard` (1/5, 75%);
- profil cebuli i liczba odcinków łuków.

Kolor dachu pochodzi z `roof:colour`, a bez niego z `roof:material` (kolor materiału: założenie profilu) albo z koloru domyślnego. Kolory są rozjaśniane o 12–15%, aby ciemne połacie pokazywały cieniowanie.

**Kształty nie modelowane** pokazuje się płasko z informacją w inspektorze: `gabled_height_moved`, `side_hipped`, `side_half-hipped`, `hipped-and-gabled`, `bellcast_gable`, `crosspitched`, `sawtooth`, `concave`. Ich geometria zależy od parametrów, których tagi nie podają (np. który koniec, ile zębów).

**Sprawdzenie:**
- W oknie z 246 dachami (10 kształtów): połacie pokrywają obrys z odchyłką 4·10⁻⁹, wysokości wierzchołków zgadzają się z dachem (10⁻¹¹ m), żaden trójkąt nie leży poza obrysem, nie było dachów zastępczych.
- Pierwsza wersja przycinała obrys wprost do komórek. Gubiła wtedy do 2% pola (krawędzie komórek zerowej długości o przypadkowym kierunku) i wypełniała wcięcia obrysów wklęsłych (do 4,5%), co poprawiono.
- Testy logiki: wysokości według wiki, kierunek i orientacja grzbietu, pokrycie i ciągłość połaci na prostokącie, obrysie w kształcie L i obrysie z otworem.

**Ograniczenia:**
- `building:colour` nie jest jeszcze używany (ściany mają kolor klasy).
- `roof:levels=0` mówi, że w dachu nie ma kondygnacji, ale nie podaje wysokości, więc działa założenie 3 m.

## Części budynków (`building:part`)

**Decyzja (2026-11-22).** Stosowana jest reguła Simple 3D Buildings: gdy w obrysie budynku leżą obszary `building:part`, bryłami 3D są tylko części, a obrys budynku nie jest rysowany. Obrys pozostaje obiektem danych: inspektor, diagnostyka i wykrywanie obiektów pod budynkiem dalej z niego korzystają.

**Przypisanie** (`web/src/core/buildings.js`): część należy do obrysu, gdy jej punkt wewnętrzny leży w zewnętrznym pierścieniu obrysu. Punktem jest środek ciężkości, a gdy wypada poza wklęsłą częścią, środek pierwszego trójkąta wachlarza leżącego w środku. Wynik (`model.buildingParts`) liczony jest osobnym etapem przy doczytywaniu i przy edycji tagów. Jest częścią odcisku obiektu, więc zmiana przypisania przebudowuje obrys.

**Kontrola danych.** Gdy części pokrywają mniej niż 90% pola obrysu (próbkowanie ok. 400 punktów), diagnostyka zgłasza `building-parts-gap`, bo reszta obrysu zostaje bez bryły. Zgodnie z wiki obrys nie jest wtedy dorysowywany: to błąd danych, który poprawia się w OSM. Inspektor obrysu podaje liczbę części.

**Sprawdzenie (Warszawa, wczytany obszar, 65 tys. obiektów):**
- 71 obrysów z częściami, 296 przypisanych części;
- żaden ukryty obrys nie daje bryły, każda część daje bryłę;
- 7 części bez obrysu w danych, rysowanych jak zwykle;
- 5 zgłoszeń niepełnego pokrycia (1–85% pola);
- koszt: 43 ms na całym modelu.

Test logiki obejmuje obrys w kształcie L z dwiema częściami, zwykły budynek i obrys pokryty w 25% ze zgłoszeniem.

## Roślinność 3D (drzewa, szpalery, lasy i zarośla)

**Decyzja (2026-11-22, Q&A).** Zakres: drzewa i lasy. Lasy są wypełniane rzadką siatką z dwoma poziomami szczegółowości. Drzewo bez tagów wymiarów ma 10 m wysokości i koronę o średnicy 6 m. Profil 0.12.0 ma sekcję `vegetation`.

**Źródła w OSM** (Tag:natural=tree, Tag:natural=tree_row, Key:leaf_type, Key:diameter_crown, Key:circumference; odczytane 22.11.2026):
- `natural=tree` (punkt) to drzewo;
- `natural=tree_row` to szpaler: linia od pierwszego do ostatniego pnia, z nową klasą `line.tree_row`; `line.natural` zostaje dla żywopłotów;
- `natural=wood` i `landuse=forest` są wypełniane drzewami, a `natural=scrub` i `natural=shrubbery` krzewami.

**Wymiary drzewa:**
- `height` i `diameter_crown` są w metrach;
- `circumference` to obwód pnia w metrach na wysokości 1,3 m, a średnica pnia to obwód / π;
- bez tagów działają wymiary formy z profilu (drzewo 10 m / 6 m, krzew 2 m / 2 m), oznaczone w inspektorze jako przybliżone;
- dla lasów i zarośli wiki nie opisuje tagów wymiarów, więc obowiązują wymiary formy.

**Kształt korony** wynika z `leaf_type`:
- liściaste (`broadleaved`) mają kulistą koronę, iglaste (`needleleaved`) stożek;
- przy `mixed` kształt wybiera się dla każdego drzewa po połowie;
- bez tagu albo przy wartości nierozpoznanej przyjmowane jest drzewo liściaste.

**Założenia prezentacyjne** (OSM ich nie opisuje), zapisane w `profile.vegetation`:
- odstęp w szpalerze 8 m;
- wypełnienie lasu co 8 m, a zarośli co 4 m, z przesunięciem do 35% odstępu;
- spód korony kulistej to wysokość minus średnica korony (co najwyżej 80% wysokości); stożek zaczyna się na 15% wysokości;
- kolory koron, odchyłka odcienia ±8%, kolor pnia;
- zasięgi szczegółowości: pełne bryły do 900 m, bryły uproszczone do 3200 m, dalej sam kolor obszaru.

**Wypełnienie obszarów** (`web/src/render/vegetation.js`):
- Siatka jest zakotwiczona w wielokrotnościach odstępu, a przesunięcie, obrót i odcień wynikają z miejsca. Wynik nie zależy więc od kolejności doczytywania kafli.
- Wnętrze jest wyznaczane z przecięć wierszy siatki z krawędziami (reguła parzystości), więc otwory multipolygonu zostają puste.
- Drzewa omijają trasy z grup `clearance.lineGroups`, z wyjątkiem tuneli. Odstęp od osi to półszerokość trasy plus co najmniej 1 m (jedna czwarta średnicy korony), więc korony mogą częściowo nachodzić na pobocze.
- Drzewa omijają też obszary z grup i klas `clearance` (budynki, woda, konstrukcje, trawniki, piaski).
- Pojedyncze drzewa i szpalery z OSM są rysowane zawsze.
- Podstawa każdej rośliny stoi na rysowanym terenie (`groundAt`, z dopasowaniem pod trasami). Punkt bez danych terenu nie dostaje drzewa. Teren najwyższego poziomu jest pobierany także dla wnętrza lasów: siatka co 48 m plus obrysy.

**Rysowanie:**
- Każda roślina to instancja siatki wzorcowej (pień i korona). Na roślinę przypada 14 liczb: pozycja, wymiary, obrót, kolor i identyfikator wyboru.
- Siatki są dzielone na kwadraty 250 m, osobno dla kształtu korony i poziomu szczegółowości.
- Shader wybiera poziom dla każdego drzewa osobno według odległości od kamery, więc poziomy stykają się bez nakładania.
- Kliknięcie w drzewo wybiera obiekt OSM, z którego pochodzi (drzewo, szpaler albo las).
- Punkt `natural=tree` nie jest już rysowany znacznikiem.

**Budowa porcjami.** Przebudowa kawałka tylko wpisuje zadania (obiekt × kwadrat 250 m) do kolejki. Pętla silnika wykonuje je przez 4 ms na klatkę, od najbliższych celu kamery. Przebudowa kawałka unieważnia jego stare zadania. Indeks tras do omijania liczy się osobnym etapem przy doczytywaniu kafli.

**Pomiary** (Warszawa, wczytany obszar 65 tys. obiektów; okno podglądu 1291×1256, nie docelowe 5120×1440):
- 297 tys. roślin w ok. 5 tys. kwadratów; cała kolejka wykonała się w 3,6 s w tle;
- jedna relacja zarośli daje 102 tys. krzewów, przed podziałem na kwadraty jej budowa trwała 213 ms w jednym kawałku;
- dwa jednorazowe długie zadania po 111 ms przy pierwszym rysowaniu (kompilacja shaderów);
- obrót kamery z 260 m: mediana klatki 13,3 ms z roślinnością i 13,2 ms bez niej (1,27 mln i 0,45 mln trójkątów);
- obrót kamery z 2,2 km: 18,9 ms z roślinnością i 16,4 ms bez niej; wywołań rysowania 1796 i 1075.

**Sprawdzenie:**
- wysokość podstawy drzewa to funkcja terenu, której używają bariery: w przykładzie podstawa 87,84 m, a surowy NMT 87,81 m (różnica to dopasowanie pod trasą);
- kliknięcie korony otwiera las w inspektorze;
- testy logiki: wymiary z tagów i założenia, klasy szpaleru i żywopłotu, otwory w wypełnieniu, przycięcie do kwadratu, omijanie jezdni, rozstaw szpaleru, brak drzew bez terenu.

**Mokradła i wrzosowiska (profil 0.13.0).** Rodzaj roślinności mokradła wynika z `wetland=*` (Key:wetland):
- `swamp` i `mangrove` to mokradła zalesione: drzewa co 8 m;
- `reedbed` dostaje trzcinę co 3 m, a `marsh` co 4 m;
- `fen`, `wet_meadow`, `saltmarsh` i mokradło bez `wetland` dostają kępy turzyc i traw co 4 m (dla braku tagu: założenie, widoczne w inspektorze);
- `bog` i `string_bog` dostają krzewinki co 3 m;
- `tidalflat` i `saltern` zostają bez roślin.

`natural=heath` ma własną klasę `land.heath` z krzewinkami co 3 m; wcześniej trafiał do „innych obszarów”. Formy trzciny, turzyc i krzewinek mają w profilu własny kształt, kolor i spód korony przy gruncie. Trzcina i turzyce mają `growsInWater`: nie omijają obszarów wody, bo trzcinowiska w OSM często nakładają się na wodę (sprawdzone: trzcinowisko w całości na stawie traciło wszystkie 15 kęp). Omijanie rzek i kanałów jako linii zostaje.

**Poprawka danych: relacje wielokątów w kaflach.** Serwer wysyłał w kaflu tylko te wielokąty zewnętrzne relacji, które przecinały kafel. Klient trzyma jeden obiekt na identyfikator, więc wygrywała wersja z ostatnio wczytanego kafla, a reszta relacji znikała. Przykład wyniku: z relacji „Lasy Mareckie” (r5334715) zostawał jeden z dwóch wielokątów, a pole przy Cegielni Osinki zostawało bez lasu, choć według OSM leży w lesie.

Teraz relacja trafia do kafla w całości, gdy którykolwiek jej wielokąt go przecina. Format obiektów kafla ma wersję (`FEATURES_FORMAT = 2` w `server/tiles.py`); kafel zbudowany starszym formatem jest budowany ponownie z OSM z pamięci podręcznej. Test serwera sprawdza relację z dwoma wielokątami.

Ograniczenie, które zostaje: kafel leżący w całości wewnątrz dużej relacji, bez żadnej jej krawędzi, nie dostaje tej relacji z OSM API. Relacja pojawia się dopiero z kaflem, który zawiera jej krawędź.

**Ograniczenia:**
- Nachodzące na siebie obszary lasu i zarośli dają podwójne wypełnienie.
- Liczba wywołań rysowania rośnie z liczbą kwadratów: przy widoku z daleka to główny koszt.
- `leaf_cycle` (np. drzewa bez liści zimą) nie zmienia wyglądu.
- Wypełnienie mokradeł turzycami bez `wetland` to założenie prezentacyjne; OSM nie mówi, co tam rośnie.
- Parki nie są wypełniane, bo OSM nie mówi, czy rosną w nich drzewa. Drzewa w parkach pochodzą tylko z `natural=tree` i szpalerów. Ogrody i rabaty: zob. „Kwiaty, boiska, oświetlenie i linie energetyczne”.

## Kwiaty, boiska, oświetlenie i linie energetyczne

**Decyzje (2026-11-22, Q&A):**
- kwiaty na rabatach i w ogrodach;
- boiska z nawierzchnią, liniami i bramkami;
- linie energetyczne według typowych polskich wymiarów;
- latarnie 8 m z wysięgnikiem nad drogę.

Profil 0.14.0 ma nowe sekcje `furniture` i `sports`, a sekcja `vegetation` dostała kwiaty i ogrody. Bryły powstają w `web/src/render/furniture.js`.

**Kwiaty** (Tag:leisure=garden, Key:garden:type, Tag:landuse=flowerbed):
- `landuse=flowerbed` dostaje kępy kwiatów co 0,7 m.
- `leisure=garden` (wiki: miejsce uprawy roślin do oglądania i odpoczynku) bez `garden:type` i z typami ozdobnymi (`landscaping`, `show_garden`, `street_side`) dostaje mieszankę 70% kwiatów i 30% krzewów co 2 m. Typy `residential` i `private` mają mieszankę pół na pół co 3 m, a `rock_garden` kwiaty z krzewinkami.
- `botanical` dostaje drzewa, krzewy i kwiaty; `arboretum` drzewa co 10 m.
- `community` i `school` (uprawy użytkowe), `roof_garden` (na dachu) i `green_wall` zostają bez roślin.
- Kolor kępy wybiera się z palety formy według miejsca. Wymiary kępy (0,45 m wysokości, 0,9 m średnicy), mieszanki i rozstawy to założenia profilu.

**Reguła wypełnienia przy nakładających się obszarach.** Trawnik i piasek blokują wypełnienie tylko wtedy, gdy są mniejsze od wypełnianego obszaru. Polana w lesie usuwa więc drzewa, a ogród narysowany na trawniku zachowuje kwiaty. Budynki, woda i konstrukcje blokują zawsze, z wyjątkiem roślin wodnych.

**Boiska i bieżnie** (Tag:leisure=pitch, Tag:leisure=track). Nowe klasy `land.pitch` i `land.track` (grupa „Boiska i bieżnie”) mają kolor nawierzchni z `surface` według mapy w `sports.surfaces`. OSM nie mapuje linii ani bramek, więc rysowane są według przepisów dyscypliny:
- piłka nożna (IFAB): pola karne, bramkowe, koło, łuki, punkty, bramki;
- tenis (ITF): linie gry pojedynczej i podwójnej, serwisowe, siatka 0,914 m;
- koszykówka (FIBA): linia za 3 punkty, strefa, koła, kosze 3,05 m;
- siatkówka (FIVB) i plażowa: linie ataku, siatka 2,43 m.

Układ boiska to prostokąt opisany na obrysie (oś wzdłuż dłuższego boku). Linie są rysowane tylko wtedy, gdy obrys wypełnia co najmniej 85% prostokąta, a proporcje różnią się od przepisów o nie więcej niż 40%. Wymiary skalują się jednakowo i liczy się je od najbliższej linii odniesienia (linii końcowej, środka albo boku), więc pole karne zostaje przy linii bramkowej także na mniejszym boisku. Bramki na małych boiskach nie są mniejsze niż 3,66 × 2 m.

**Tory bieżni.** Tory mierzy się od krawężnika wewnętrznego (World Athletics: tor 1,22 m), więc linie torów są równoległe do pierścienia wewnętrznego (płyty) i przycięte do obszaru bieżni.
- Pierwsza wersja prowadziła linie równolegle do obrysu zewnętrznego. Dobieg i narożnik obrysu (np. w MCER) zaginały je wtedy pod kątem prostym, czego nie da się przebiec. Poprawiono to regułą ogólną, nie dla tego jednego miejsca.
- Rysowane są linie między torami; zewnętrzny brzeg ostatniego toru to krawędź nawierzchni. Odcinki krótsze niż 3 m są pomijane.
- Liczba torów pochodzi z `lanes`. Bez tagu, tylko dla dyscyplin z `sports.track.lanedSports` (`running`, `athletics`), liczy się ją z szerokości: mediany odległości krawężnika od obrysu zewnętrznego (dobieg jej nie zawyża).
- Inne tory (np. rolkostrada) mają linie tylko z `lanes`. Bieżnia prosta (bez płyty) ma tory wzdłuż dłuższego boku tylko z `lanes`.
- Sprawdzenie: 6 owalnych bieżni szkolnych (`lanes=2` i `3`) i bieżnia MCER dają ciągłe linie, bez strzępów. Test logiki obejmuje owal z doklejonym dobiegiem: każda linia leży w odległości 1,22·k od krawężnika.

**Oświetlenie** (Tag:highway=street_lamp, Key:lamp_mount, Key:tower:type):
- Latarnia ma słup 8 m (`height` ma pierwszeństwo).
- `bent_mast` (albo brak `lamp_mount`) daje wysięgnik 1,5 m w kierunku z `light:direction` (zapasowo `direction`; stopnie albo N, NE…, kilka wartości po średniku). Bez kierunku wysięgnik celuje w najbliższą oś jezdni w promieniu 25 m. `straight_mast` ma oprawę na szczycie.
- `support=ground`, `fence` i `pedestal` (oraz `bollard`) dają niską oprawę 1 m; `wall` daje oprawę na 4 m bez słupa; `high_mast` daje maszt 30 m z wieńcem opraw.
- Oprawa na słupie innej sieci (`straight_arm`, `bent_arm`, `support=power_pole`) ma tylko wysięgnik.
- Maszt oświetleniowy (`man_made=tower` + `tower:type=lighting`, nowa klasa `point.floodlight`) ma 18 m, a panel opraw jest zwrócony do najbliższego boiska.

**Linie energetyczne** (Tag:power=line/minor_line, Tag:power=pole/tower, Key:cables). Linie napowietrzne mają nową klasę `line.power`, a kable (`power=cable`, `location=underground/underwater`) zostają w `line.utility` i są pokazywane w rzucie.
- Słup dystrybucyjny (linia ≤ 30 kV) to żerdź 12 m z poprzecznikiem. Przewody (`cables`, bez tagu 3) idą poziomo co 0,8 m, a każda kolejna linia na słupie jest 1,2 m niżej.
- Słup przesyłowy (napięcie > 30 kV albo `power=tower` bez znanego napięcia) ma 30 m i ramiona na trzech poziomach (95, 82 i 69% wysokości). Przy 6 przewodach są po obu stronach, a przy 3 po jednej; druga linia na słupie bierze drugą stronę.
- Poprzecznik leży prostopadle do dwusiecznej kierunków linii w słupie. Oba przęsła przy słupie (także kątowym) używają więc tych samych punktów zawieszenia i przewody się łączą.
- Przewód to krzywa zwisu ze zwisem 3% rozpiętości przęsła, rysowana linią szerokości piksela.
- Słup z `location:transition=yes` sprowadza przewody do ziemi (przejście w kabel), a słup z `transformer` ma skrzynię transformatora.

**Pomiary** (MCER i okolice, okno podglądu 1291×1256):
- 1001 słupów i 249 linii z 919 przęsłami, 326 latarni;
- linia bramkowa sprawdzona odczytem pikseli: 4 piksele koloru linii (253,249,237) w miejscu linii;
- obrót kamery z 300 m nad MCER: mediana klatki 8,6 ms z nowymi bryłami i 9,9 ms bez nich (różnica w szumie); wywołań rysowania 464 i 430.

**Testy logiki:**
- klasy (boisko, ogród, rabata, maszt, linia napowietrzna i kabel) i kolor nawierzchni;
- kierunki z tagów i zwis 3%;
- punkty zawieszenia na słupie kątowym leżą na dwusiecznej co 0,8 m;
- odrzucenie boiska nieprostokątnego i o złych proporcjach;
- skalowanie pola karnego od linii bramkowej i koła od środka;
- bramki.

**Ograniczenia:**
- Słupy kratowe są uproszczone do zwężającego się trzonu, bez kratownicy.
- Linia kończąca się poza słupem (np. w stacji) nie ma ostatniego przęsła.
- Konstrukcja słupa (`design=*`) nie zmienia jeszcze układu przewodów.
- Linie boisk wielofunkcyjnych (`sport=multi`) nie są rysowane.
- Oświetlenie nie świeci (nie ma trybu nocnego).

## Drzwi i bramy wjazdowe

**Decyzje (2026-11-24, Q&A):**
- drzwi według rodzaju wejścia, z wyglądem z `door`;
- rodzaj bramy z tagów i z trasy przechodzącej przez bramę.

Profil 0.15.0 ma sekcje `furniture.doors` i `furniture.gates` oraz klasę `point.entrance`. Reguła wejścia ma kolejność 110, więc węzeł z `barrier` i `entrance` pozostaje bramą.

**Drzwi** (Key:entrance, Key:door, Key:automatic_door; odczytane 24.11.2026):
- Węzeł `entrance=*` jest osadzany na najbliższej krawędzi obrysu budynku lub części (do 0,8 m). Ościeżnica i skrzydła stoją na licu po stronie zewnętrznej, a strona wynika z testu punktu w obrysie.
- Bez lica w pobliżu drzwi nie powstają i zostaje znacznik. `door=trapdoor` (właz w podłodze) nie jest rysowany na elewacji.
- Wymiary: `width`, `height` i `door:wings` z tagów, inaczej według rodzaju wejścia (założenie):

| Rodzaj wejścia | Wymiary | Skrzydła i wygląd |
|---|---|---|
| `staircase`, `home`, `service`, `yes`, inne | 1,0 × 2,1 m | jedno |
| `main` | 1,8 × 2,2 m | dwa |
| `shop` | 1,8 × 2,2 m | dwa, szklane |
| `garage` | 2,5 × 2,1 m | segmentowe |
| `emergency`, `exit` | 1,0 × 2,1 m | jedno, z zielonym oznaczeniem |

- `level` > 0 podnosi drzwi o kondygnacje (3 m).
- Wygląd z `door`:
  - `hinged` (i `yes`): skrzydła z klamką;
  - `sliding`: szklane skrzydła przesunięte względem siebie, uchwyt pionowy;
  - `revolving`: bęben ze szklanych paneli przed licem, z daszkiem i skrzydłami na krzyż;
  - `folding`: skrzydła łamane;
  - `overhead`: panel segmentowy z przetłoczeniami;
  - `no`: ciemny otwór.
- Dół drzwi stoi na rysowanym gruncie przy licu (`groundAt`).

**Bramy** (Tag:barrier=gate, lift_gate, swing_gate, sliding_gate):
- `gate:type=sliding` albo `rolling` (oraz `barrier=sliding_gate`) daje bramę przesuwną. Skrzydło zamyka otwór i wystaje za słupek (ogon przeciwwagi), pod nim jest belka jezdna, a na końcu ogona słupek.
- Pozostałe bramy są skrzydłowe. `barrier=gate` ma dwa skrzydła, gdy przechodzi przez nią trasa dla pojazdów (grupa `roads`) albo gdy szerokość z tagu lub z trasy wynosi co najmniej 2,5 m. Domyślna szerokość typu z profilu o tym nie decyduje.
- Furtka ma zawsze jedno skrzydło.
- `material` zmienia wzór i kolor: `metal`/`steel` to pręty, `wood` deski, `wire`/`chain_link` siatka.
- Szlaban (`lift_gate`, `swing_gate`) ma jedno ramię przez cały otwór, a przy `*:type=double` dwa ramiona spotykające się w środku.
- Rodzaj z pochodzeniem pokazuje inspektor bariery („Rodzaj”). Bariery, które się nie otwierają (np. `cycle_barrier`), rodzaju nie dostają.

**Wynik (wczytany obszar):**
- Drzwi: 665 wejść, z czego 626 osadzonych na licu (94%).
- Bramy:
  - `gate`: 1255 dwuskrzydłowych na trasach dla pojazdów, 2 dwuskrzydłowe z szerokości, 595 jednoskrzydłowych;
  - `lift_gate`: 8 dwuramiennych i 168 jednoramiennych;
  - przesuwnych w danych nie ma (żadna brama nie ma `gate:type`).
- W pierwszej wersji domyślna szerokość bramy (3 m) dawała dwa skrzydła 1565 bramom. Poprawiono to tak, by decydowała tylko szerokość zmierzona.
- Drzwi dodają w ujęciu nad osiedlem około 4,5 tys. z 2,62 mln trójkątów (0,2%).

**Testy logiki:**
- rodzaje bram (przesuwna z `gate:type`, dwa skrzydła na drodze, jedno na ścieżce, drewno, szlaban `single`/`double`, furtka na drodze);
- drzwi (lico od zewnątrz, wymiary pojedynczych i głównych, brama garażowa, drzwi obrotowe, brak lica).

**Podstawa ścian budynków (poprawka 2026-11-24, decyzja użytkownika).** Pod drzwiami widać było pas ściany. Ściana zaczynała się na najniższym punkcie obrysu, a teren ma odsuniętą głębię (1 m + 1,5 × oczko siatki), żeby nie przesłaniał tras, więc dolna część ściany była widoczna także pod gruntem. Pomiar pikselami przy wejściu głównym: 0,42 m ściany pod drzwiami. Różnica między gruntem przy drzwiach a podstawą budynku: mediana 0,22 m, ponad 20 cm w 768 z 1483 wejść.
- Teraz bryła stojąca na gruncie (`min_height` = 0) ma dół ścian na rysowanym terenie (`groundAt`) 3 cm pod powierzchnią. Krawędzie obrysu są dzielone co 2 m (także między załamaniami dachu).
- Dół w punkcie podziału to minimum gruntu w nim i w środkach sąsiednich odcinków, więc dół ściany nie wychodzi nad wklęsły teren. Bez tego szczeliny pod ścianą były w 3,4% próbek (do 1,28 m).
- Bryła uniesiona (`min_height` > 0) ma płaski spód jak wcześniej. Wysokość dachu nadal liczy się od najniższego punktu obrysu. Silnik pobiera teren także wzdłuż obrysów budynków.
- Wynik: przy wejściu głównym pod drzwiami od razu jest grunt (pas ściany 0,42 m → 0), przy klatce schodowej zostaje 1–2 cm.
- Audyt 1,46 mln próbek wzdłuż ścian: szczeliny w 0,075% próbek (maksimum 0,26 m); ściana poniżej gruntu ma medianę 4,4 cm, 99. percentyl 26 cm, maksimum 3 m (przy uskokach dopasowania).
- Koszt w ujęciu nad osiedlem: 3,08 mln trójkątów zamiast 2,62 mln (+18%), mediana klatki 18,2 ms (wcześniej 20,4 ms). Pobieranie wysokości przy pierwszym wczytaniu trwa 6,1 s zamiast 4,4 s; to czas sieci w tle, nie klatek.
- Test logiki: budynek na pochyłym terenie ma dół ścian na gruncie, a bryła z `min_height` ma płaski spód.

## Tunele, przejścia i przepusty

**Decyzja.** Tunel (`tunnel=yes`, `tunnel=passage`), przejście pod budynkiem (`tunnel=building_passage`) i przepust lub ciek w tunelu (`tunnel=culvert`, `waterway` z `tunnel`) są bryłą, a nie przygaszonym paskiem na powierzchni. Plan liczy `web/src/core/tunnels.js` z danych i sekcji `tunnels` profilu kraju. Obiekty planowane i nieistniejące, na przykład `railway=proposed` z `tunnel=yes`, nie dostają bryły.

| Wymiar | Źródło |
|---|---|
| Prześwit | tag `maxheight:physical`, potem `maxheight`; bez tagu założenie profilu dla grupy trasy (drogi 4,7 m, ruch pieszy i rowerowy 2,5 m, kolej 5,6 m, woda 1,0 m) |
| Ograniczenie prześwitu | tunel z modelu poziomów mieści się w odstępie poziomów (5,5 m) wraz ze stropem; przejście mieści się pod budynkiem, a przy `min_height` pod jego spodem |
| Szerokość wnętrza | szerokość trasy i po 1,0 m (drogi), 0,5 m (piesi, rowery), 1,5 m (kolej) lub 0,2 m (woda) z każdej strony |
| Posadzka | poziom tunelu z modelu poziomów; w przepuście wysokość niższego wlotu z NMT, bo woda nie płynie pod górę |
| Ściana, strop | 0,4 m i 0,5 m (profil) |

Bryła zależy od tego, co leży nad tunelem. Gdzie grunt lub nasyp jest co najmniej 0,6 m nad stropem albo nad przejściem stoi budynek, powstaje zamknięta tuba z ciemnym wnętrzem. Gdzie terenu nad stropem nie ma, jest niecka z murami oporowymi sięgającymi terenu. W miejscu przejścia niecki w tubę stoi portal z nadprożem i ościeżami, tak jak na wlocie przejścia podziemnego. Tunel nie wystaje więc ponad teren.

Teren i budynki są wycinane w obrysie tuby w shaderze, więc wlot jest otwarty. Zapas głębi terenu nad tunelem wynosi około 0,5 m zamiast kilku metrów, dlatego wnętrza nie widać przez teren. Obrysy są przekazywane do shadera jako maks. 96 odcinków; w wycinku jest ich 55. Pętla po odcinkach liczy się tylko w pasie maski tuneli, więc nie obniża wydajności. Nawierzchnia i oznakowanie leżą na posadzce. Linia przebiegu biegnie po osi tunelu na wysokości posadzki i jako schemat jest widoczna zawsze, także przez teren, w jaśniejszym odcieniu. Inspektor pokazuje sekcję tunelu ze źródłem prześwitu, szerokości i posadzki.

Kontrola `auditTunnels` (konsola, `web/src/render/networkAudit.js`) sprawdza na pikselach otwarte wloty i ukrycie wnętrza pod terenem, po doczytaniu kafli terenu. Wynik w wycinku: 23 obiekty (9 tuneli, 5 przejść, 9 przepustów), 374 m tuby i 331 m niecki, 11 z 11 odcinków przykrytych niewidocznych z góry, 30 z 36 wlotów otwartych. Wydajność w 5120×1440 bez zmian: gęsta scena 164,5 kl./s, 1% najwolniejszych 161,3 kl./s.

**Ograniczenia:** prześwity bez tagów są założeniami. Żaden tunel w wycinku nie ma tagu `maxheight`. Przejścia `w404587139` (rowerowe) i `w404587142` (piesze) przez wał są w OSM dwiema drogami na różnych poziomach, a w terenie to jedna ścieżka z podziałem na część rowerową i pieszą. Ich tuby nachodzą na siebie; rozwiązaniem jest poprawa tagowania, nie renderowania. Wylot przepustu `w23945674` zasłania płot stojący na danych OSM. Przejście `w428748054` biegnie wzdłuż ściany budynku, więc z jednej strony widać ścianę budynku zamiast ściany tunelu. Przekrój tuby jest prostokątny; kształt sklepienia i przepustu rurowego nie wynika z danych.

## Kryteria odbioru (`04-prototyp.md`)

| # | Wynik | Podstawa |
|---|---|---|
| 1 | Spełnione | Pokrycie poligonu NMT 100%, bez luk. Definicja poligonu do oceny użytkownika. |
| 2 | Spełnione | Osobne klasy i style; relacja 7421590 zachowana jako kontekst, bez własnej geometrii. |
| 3 | Spełnione | 249 przecięć tras w rzucie 2D: 245 rozdzielonych tagami, 3 podejrzenia ścieżka–ciek, 1 niejasna kolejność. Żadna kolizja nie dotyczy mostu ani dojazdów drogowych; 0 potwierdzonych. |
| 4 | Spełnione | Inspektor pokazuje surowe tagi, reguły, pochodzenie i niepewności. |
| 5 | Spełnione | Test w interfejsie: zwykły tag 7–30 ms, zmiana konstrukcji mostu do ok. 85 ms, bez przeładowania; różnice, cofanie, przywracanie. |
| 6 | Spełnione | Ostrzeżenia nie blokują edycji; brak żądań poza serwer lokalny; zmiany żyją tylko w pamięci strony. |
| 7 | Spełnione | Sprawdzono obie odpowiedzi w oknie; aktywna scena była dostępna do końca budowy nowej migawki. |
| 8 | Zmierzone z zastrzeżeniem | Ryzen 5 7600, 32 GB DDR5, RX 6750 XT, bufor 5120 × 1440, po przebudowie łączeń: nawigacja 59,9–60,0 kl./s, gęsta scena 60,0 kl./s, 1% najwolniejszych klatek 58,5–58,8 kl./s. Widok był emulowany na monitorze 2560 × 1440 przy 60 Hz, a wynik jest ograniczony odświeżaniem. |

## Ograniczenia i blokady

- **Poziomy pomostów są przybliżone.** Ciągłość i prześwit są własnością modelu, a nie pomiarem mostu. Rzeczywiste rzędne wymagają NMPT lub LiDAR, które nie są jeszcze wczytywane. Teren zasłania obiekty dopiero, gdy leżą za nim dalej niż odsunięcie jego głębi.
- **BDOT10k:** adapter niewdrożony; pokrycie i warunki produktu dla poligonu nie są sprawdzone.
- **MPHP10k:** WFS zwraca stronę logowania ISOK, więc dostęp wektorowy jest niepotwierdzony.
- **Ortofotomapa:** warstwa nieaktywna; źródło i warunki usługi nie są sprawdzone.
- **OSM API:** wycinek pobierany jest przez `map?bbox`. Zgodność częstego odświeżania z zasadami korzystania z API nie została oceniona; adapter można wymienić na Overpass lub ekstrakt.
- **Budynki:** dachy są płaskie, a grupowanie `type=building` i przypadek PKiN należą do kolejnych scen.
- Rzędna wody nie jest znana. Woda leży na NMT i nie służy do potwierdzania kolizji.
