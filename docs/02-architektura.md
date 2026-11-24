# Architektura logiczna

**Status:** kierunek architektoniczny, nie specyfikacja implementacyjna.

## Podział odpowiedzialności

```text
Źródła zewnętrzne
  OSM · dane wysokościowe · usługi krajowe
            │
            ▼
Adaptery źródeł i cache
            │
            ▼
Wspólny model danych geograficznych
            │
            ├── Profil kraju: źródła, CRS, reguły interpretacji
            ├── Interpretacja OSM: klasyfikacja semantyczna
            └── Profil kartograficzny: symbole i reguły wyglądu
            │
            ▼
Silniki wspólne: kafelki · teren · geometria · kamera
            │
            ▼
Renderer 3D i interakcje
```

Diagram przedstawia przepływ odpowiedzialności, a nie ustalony podział na procesy lub pakiety kodu.

## Warstwy

### 1. Adaptery źródeł i cache

Pobierają dane ze skonfigurowanych usług, obsługują ich formaty i ograniczenia, kontrolują cache oraz przekazują wyniki dalej. Cache prototypu jest trwały między uruchomieniami, ma początkowy limit 10 GB (konfigurowalny), przechowuje metadane aktualności i odświeża się ręcznie. Po zapełnieniu usuwa najdawniej używane dane, chroniąc aktywną scenę. Nie oznacza to trybu offline. Nadal trzeba zweryfikować licencje, limity usług i dostępność źródeł. Adapter dostawcy nie powinien narzucać semantyki renderera.

### 2. Wspólny model danych

Udostępnia ujednolicony opis geometrii, tagów, układu współrzędnych, wysokości, pochodzenia i jakości danych. Model ma zachowywać odniesienie do źródła i nie gubić nieznanych tagów.

Dane złożonego budynku mogą obejmować obrys, części oraz relację grupującą. Wspólny model zachowuje tożsamość, role i tagi każdego członka dla `type=building` oraz budynkowych multipolygonów; nie wyprowadza semantycznego `building:part` z samej roli lub notatki. Renderer i diagnostyka korzystają z geometrii relacji bez spłaszczania danych źródłowych.

### 3. Profile krajowe

Określają dostępne źródła, transformacje i układy odniesienia, reguły interpretacji lokalnych konwencji oraz powiązany styl kartograficzny. Są wersjonowaną konfiguracją JSON oddzieloną od renderera, walidowaną względem schematu; profil nie zawiera wykonywalnego kodu, a złożone operacje geometryczne wykonuje wspólny silnik. Profil Polski będzie pierwszą konkretną konfiguracją. Silnik nie powinien zawierać specjalnych przypadków Polski poza samym profilem.

### 4. Wspólne silniki geograficzne

Obsługują kafelkowanie/strumieniowanie, geometrię, budowę terenu, kamerę i przejście globus–widok lokalny. Konkretne rozwiązania algorytmiczne pozostają otwarte do czasu prototypu.

Strumieniowanie używa hierarchii poziomów szczegółowości i utrzymuje pokrycie rodzica do czasu gotowości dokładniejszych kafelków, aby uniknąć pustych obszarów. Poza aktywnym obszarem widoku dane są zwalniane zgodnie z budżetem pamięci. Ciągły model wysokości może być lokalnie uszczegóławiany źródłami o większej rozdzielczości, np. LiDAR, przy zachowaniu informacji o pochodzeniu i jakości.

### 5. Renderer i interakcje

Renderują ujednolicone dane i wynik stylu kraju. Nie powinny samodzielnie pobierać danych krajowych ani interpretować surowych tagów OSM.

### 6. Hydrologia i relacje przestrzenne

Hydrologia jest częścią modelu sceny od pierwszego prototypu: cieki, zbiorniki, brzegi/koryta i ich relacja do terenu oraz mostów/przepustów. Nie zakładamy dostępności batymetrii; głębokość jest prezentowana tylko na podstawie wiarygodnych danych, a jej brak pozostaje jawny. Symulacja przepływu i powodzi jest osobną możliwością rozwojową.

Rzędna powierzchni wody pochodzi z wiarygodnego źródła, gdy jest dostępna. Brak rzędnej może skutkować przybliżoną wizualizacją oznaczoną jako niepewna; taka powierzchnia nie może stanowić jedynej podstawy potwierdzonej kolizji.

Konflikt między tagami OSM o poziomie obiektu a NMPT/LiDAR pozostaje jawny: dane OSM są edytowalną bazą, a niezależne źródło wysokościowe staje się dowodem w raporcie, nigdy automatyczną korektą OSM.

Wysokości mają rozdzielone role: NMT opisuje bazową powierzchnię gruntu, geometria OSM zachowuje znaczenie mapowanych obiektów, a NMPT i LiDAR mogą dostarczyć dokładniejszej powierzchni do lokalnej weryfikacji i uszczegóławiania. Adaptery danych muszą jawnie kontrolować i transformować układy współrzędnych oraz układy wysokościowe przed połączeniem warstw.

Robocze układy pierwszego prototypu: WGS84 dla współrzędnych OSM i widoku globusa; PL-1992 (EPSG:2180) dla lokalnych obliczeń metrycznych, geometrii sceny i kolizji; PL-EVRF2007-NH dla rzędnych wysokościowych. Transformacje pomiędzy wejściowymi układami muszą być jawne i sprawdzone. Rzędnej ze źródła w innym układzie wysokościowym nie wolno porównywać bez transformacji.

Renderer pokazuje rzeźbę terenu przez subtelne cieniowanie i naturalną paletę wysokości. Pionowa skala rzeczywista 1:1 jest domyślna; ewentualne wyolbrzymienie jest jawną, regulowaną prezentacją i nie zmienia danych geograficznych ani pomiarów.

Każda warstwa zachowuje metadane pochodzenia, datę pozyskania/aktualności, rozdzielczość i układ odniesienia, o ile są dostępne. Cache udostępnia odświeżenie na żądanie i stabilną wersję zestawu danych na czas edycji. Małe luki wysokościowe mogą być interpolowane z oznaczeniem obniżonej pewności; większe braki pozostają jawne.

Warstwa interfejsu atrybucji stale pokazuje wymagane oznaczenie OSM i link do informacji o licencji. Rozwijane informacje o źródłach uwzględniają aktywne warstwy oraz ich warunki wykorzystania.

### 7. Walidacja geometrii i kolizji

Osobna logika walidacji analizuje przecięcia i bliskości w 3D, biorąc pod uwagę poziomy, mosty, tunele, części budynków i dachy. Potwierdzona kolizja fizyczna wymaga wiarygodnych geometrii i poziomów obu obiektów wykazujących rzeczywiste przecięcie; wynik zależny od wysokości przybliżonej lub nieznanego poziomu pozostaje podejrzeniem. Konflikt kontekstowy (np. słup wewnątrz jezdni) jest osobnym typem diagnostyki i może być potwierdzony tylko przy wiarygodnym położeniu obiektów. Prawidłowe skrzyżowanie na różnych wysokościach ani wspólna granica sąsiadujących części nie są same w sobie kolizją. Niekompletne lub niespójne grupowanie budynku daje częściowy render i raport diagnostyczny.

Raport konfliktu zachowuje oba identyfikatory i zestawy tagów, opis przyczyny, poziomy 3D, źródła wymiarów oraz oddzielne oceny wagi wpływu i pewności wykrycia. Po lokalnej edycji tagów widoczny obszar podlega ponownej walidacji.

### 8. Inspektor i lokalny podgląd zmian

Panel obiektu ujawnia identyfikator i link do źródła OSM, tagi, interpretację, niepewności, konflikty i wyjaśnione propozycje tagów z linkami do dokumentacji reguł. Lokalna edycja pozwala dodawać, zmieniać i usuwać dowolne tagi, także nierozpoznane; przelicza interpretację i render na żywo, pokazuje różnice względem danych źródłowych oraz obsługuje cofanie/przywrócenie zmian. W prototypie ta sesyjna edycja nie publikuje zmian do OSM.

Interfejs dla szerokiego widoku DQHD pozostawia mapę na pełną szerokość: warstwy/nawigacja rozwijają się z górnej krawędzi, a inspektor/diagnostyka z dolnej, oba na środku. Boczne panele nie zabierają szerokości mapy.

Wybór części złożonego obiektu zachowuje relację do grupy nadrzędnej i innych członków, a zarazem pozwala inspektorowi edytować wybraną część oddzielnie. Test PKiN obejmuje rzeczywistą relację `type=multipolygon`; standardowa relacja `type=building` pozostaje osobnym przypadkiem.

Widok początkowy prowadzi do Warszawy, a szybki wybór/wyszukiwarka pozwala przejść do udokumentowanych punktów testowych, miejsc, współrzędnych i identyfikatorów OSM. Oddalenie kamery zachowuje przejście do globusa.

Początkowo aktywne są podstawowe warstwy 3D; ortofotomapa pozostaje wyłączona, dopóki użytkownik jej nie włączy. Etykiety i LOD są dopasowywane do skali.

Walidacja kolizji startuje automatycznie dla widocznego obszaru, a jej markery są domyślnie widoczne z możliwością przełączenia widoczności.

Diagnostyka jakości danych używa osobnej klasy markerów dla niepewnych i niekompletnych obiektów. Markery te są domyślnie widoczne i pozostają rozróżnialne od kolizji geometrycznych.

Warstwy referencyjne hydrografii są domyślnie aktywne w trybie diagnostycznym, lecz pozostają odrębną, niezależnie przełączalną warstwą poza geometrią OSM.

Filtry diagnostyczne działają niezależnie dla klas problemów, w tym kolizji, brakujących tagów/wysokości i pozostałych niepewności.

Lista diagnostyczna sortuje według wagi problemu, a w jej obrębie według odległości od kamery; aktywacja wyniku prowadzi kamerę do zgłoszonego obiektu.

Lokalne zmiany nie są trwałe po zamknięciu prototypu; odświeżanie danych źródłowych pozostaje ręczne, aby aktywna sesja edycji była stabilna. Jeśli istnieją zmiany sesyjne, aplikacja pyta przed odświeżeniem: można pozostać przy aktualnym zestawie albo jawnie odrzucić zmiany i odświeżyć źródła.

## Granice danych i wizualizacji

Przetwarzanie rozdziela trzy reprezentacje:

1. **Dane źródłowe:** niezmienione tagi, geometrie, relacje i metadane źródła.
2. **Interpretacja:** jawna, możliwa do prześledzenia klasyfikacja z reguł profilu kraju.
3. **Prezentacja:** kolory, symbole, szerokości, wysokości i hierarchia wizualna.

Każdy wynik interpretacji powinien dać się powiązać z regułą, która go utworzyła. Dzięki temu można poprawić profil bez utraty źródłowych danych.

## Decyzje techniczne pozostawione otwarte

Formaty i poziomy kafelkowania, projekcja/układy odniesienia dla poszczególnych etapów, biblioteki geodezyjne, format pośredni, strategia cache oraz konkretne źródła danych będą ustalane po zebraniu wymagań i testach prototypu. Three.js jest uzgodnioną podstawą renderowania, ale nie rozstrzyga pozostałych wyborów.
