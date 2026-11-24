# Plan dokumentacji i otwarte decyzje

## Uzgodnione dla prototypu

Prototyp obejmuje Warszawę i okolice, z ciągłym pokryciem oraz regulowaną szczegółowością zależną od odległości. Zawiera teren, budynki, drogi, infrastrukturę rowerową, szlaki piesze, tory kolejowe, hydrologię od początku, lokalne nazwy oraz polski styl kartograficzny. Stacje i transport publiczny pozostają poza pierwszym zakresem, lecz system ma dać się łatwo rozszerzyć.

Prototyp ma dynamicznie strumieniować kafelki z poziomami szczegółowości, zachowując zgrubne pokrycie do czasu otrzymania danych dokładniejszych; ciągły model terenu będzie lokalnie uszczegóławiany dokładniejszymi danymi. Ma też sprawdzać poziomy i połączenia obiektów 3D, w tym złożonych budynków grupowanych relacją `type=building`; wykrywać kolizje z oznaczeniem pewności; wyjaśniać problemy z tagami w panelu obiektu; oraz pozwalać na lokalną edycję tagów z natychmiastowym podglądem i cofnięciem zmian. Nie publikuje zmian do OSM. Nawigacja obejmuje przejście globus–widok lokalny, orbitę/pochylenie/zoom, powrót do góry i przycisk blokady północy. Szczegóły znajdują się w [specyfikacji prototypu](04-prototyp.md).

**Decyzja przyjęta w Q&A:** roboczym układem wysokościowym pierwszego prototypu jest PL-EVRF2007-NH. Dane w innym układzie wolno łączyć po zastosowaniu jawnej i sprawdzonej transformacji; bez niej należy zgłosić niezgodność, nie porównywać surowych rzędnych.

**Decyzja przyjęta w Q&A:** wejściowe współrzędne OSM i widok globusa pozostają w WGS84; lokalne obliczenia metryczne pierwszego wycinka wykorzystują PL-1992 (EPSG:2180), z jawną transformacją na granicach układów.

**Decyzja przyjęta w Q&A:** pierwszy działający wycinek przy Moście Siekierkowskim ma zawierać pełny główny przepływ: wybór obiektu, inspektor, diagnostykę oraz lokalną edycję tagów z natychmiastową aktualizacją, podglądem różnic i cofnięciem.

**Punkt odniesienia wydajności:** AMD Ryzen 5 7600, 32 GB RAM DDR5, AMD Radeon RX 6750 XT; testy docelowe w DQHD 5120 × 1440.

**Decyzja przyjęta w Q&A:** cache trwały między uruchomieniami, początkowy limit 10 GB z możliwością zmiany, usuwanie najdawniej używanych danych z ochroną aktywnej sceny; odświeżanie ręczne.

**Decyzja przyjęta w Q&A:** profil kraju jest wersjonowaną konfiguracją oddzieloną od renderera; złożone obliczenia geometrii należą do wspólnego silnika. Schemat pól pozostaje do dopracowania.

**Decyzja przyjęta w Q&A:** formatem profilu kraju jest JSON z walidacją wersjonowanego schematu; profil nie zawiera wykonywalnego kodu.

**Zakres globusa potwierdzony w Q&A:** widok całej Ziemi jest uproszczony; szczegółowe OSM i teren dotyczą obszaru prototypu, a pełne pokrycie świata pozostaje poza zakresem.

## Najbliższe prace dokumentacyjne

1. **Zestaw przypadków OSM:** najpierw potwierdzić identyfikatory i geometrię dla pierwszego wycinka przy Moście Siekierkowskim; opisać oczekiwany wynik 3D oraz problemy tagowania. Potem zamykać kolejne miejsca w kolejności ze specyfikacji.
2. **Granica i dane:** zamienić obwiednię źródłową na dokładny ciągły poligon/korytarz. Pierwsza scena obejmuje cały węzeł Mostu Siekierkowskiego, uproszczone dojazdy/ścieżki i ok. 1 km Wisły w obu kierunkach; powiązać ją z arkuszami wysokościowymi, hydrografią i aktualnymi warunkami wykorzystania. PL-EVRF2007-NH jest przyjętym układem wysokościowym roboczym; trzeba zweryfikować dostępne transformacje pozostałych źródeł.
3. **Schemat profilu kraju:** zaprojektować pola JSON, kolejność i priorytety reguł, styl Polski oraz raportowanie nierozpoznanych przypadków.
4. **Kryteria jakości i wydajności:** ustalić mierzalne progi dla DQHD, LOD, ładowania, pamięci, dokładności geometrii i zachowania przy brakujących danych.
5. **Decyzje techniczne (ADR):** zapisać uzgodnione podstawy (Three.js, WGS84/EPSG:2180/PL-EVRF2007-NH, JSON profilu kraju i politykę cache) oraz rozstrzygać wyłącznie brakujące szczegóły implementacyjne, gdy są potrzebne do zadania.
6. **Pakiet zadań dla Claude Code:** podzielić zatwierdzony zakres na małe etapy; każdy etap dostanie cel, ograniczenia, kryteria odbioru i jawne zależności. Ramy przekazania opisuje [dokument przygotowania Claude Code](07-przekazanie-do-claude-code.md). Kodowanie rozpoczyna Claude Code dopiero po zamknięciu niezbędnych decyzji i akceptacji pakietu.

## Gotowość dokumentacji do przekazania

| Obszar | Stan | Dokument/warunek zamknięcia |
|---|---|---|
| Cel, UI i zachowanie prototypu | Opisane | `01-zalozenia.md`, `04-prototyp.md`; sprawdzić spójność po zamknięciu przypadków brzegowych. |
| Architektura i profile krajowe | Podział oraz JSON uzgodnione | `02-architektura.md`, `03-profile-krajowe.md`; pozostały szczegółowy schemat pól/reguł i interfejsy modułów. |
| Źródła i pokrycie wysokościowe | Wstępnie zinwentaryzowane; układy i podstawowa polityka cache ustalone | `06-inwentaryzacja-zrodel.md`; dokładne poligony, fixtures, pokrycie arkuszy, licencje źródeł i dostęp do hydrologii do potwierdzenia. |
| Przypadki OSM i oczekiwane wyniki | W toku | `06-inwentaryzacja-zrodel.md`; kandydaci ID wymagają sprawdzenia geometrii i relacji. |
| Kryteria odbioru i wydajności | Częściowe; sprzęt i cel 60/30 kl./s zapisane | `04-prototyp.md`; dopisać powtarzalną metodę oraz progi dla ładowania, pamięci, dokładności i gęstych scen. |
| Pakiet wdrożeniowy dla Claude Code | Ramy przygotowane; zadania implementacyjne jeszcze niegotowe | `07-przekazanie-do-claude-code.md`; uzupełnić zadania po potwierdzeniu fixtures, danych i progów odbioru. Uzgodnione układy pozostają bazą projektu. |

## Otwarte decyzje

- Które konkretne źródła OSM, wysokościowe i ortofotomapowe będą użyte w pierwszym wycinku oraz jakie są ich warunki licencyjne, atrybucja i ograniczenia cache?
- Które arkusze NMT, NMPT i LiDAR przecinają dokładny poligon pierwszego wycinka; jakie mają daty, rozdzielczość i jakość, i jak mają być zestawione bez szczelin?
- Jakie formaty i poziomy kafelkowania najlepiej sprawdzą się dla globalnego widoku i lokalnego obszaru prototypu?
- Które sprawdzone transformacje są potrzebne dla konkretnych, wybranych źródeł spoza uzgodnionej bazy WGS84/EPSG:2180/PL-EVRF2007-NH?
- Które źródła hydrologii pokrywają Wisłę w pierwszym wycinku i Długą w kolejnych; które zawierają geometrię, brzegi, rzędne wody lub batymetrię?
- Jakie tolerancje geometrii liczyć przy fizycznej kolizji i anomalii kontekstowej? Zasada statusu potwierdzone/podejrzenie jest ustalona; pozostają konkretne progi i metody.
- Jak powtarzalnie mierzyć cel około 60 kl./s w typowej nawigacji i minimum 30 kl./s w gęstych scenach oraz jakie ustalić limity pamięci, ładowania i dokładności?
- Jak cache ma identyfikować wersje źródeł i unieważniać kafelki po ręcznym odświeżeniu? Ustalono już trwałość między uruchomieniami, początkowy limit 10 GB z możliwością zmiany, ochronę aktywnej sceny, usuwanie najdawniej używanych danych, ręczne odświeżanie oraz pytanie przed odrzuceniem zmian sesyjnych. Prezentacja nieaktualności jest szczegółem UX do opisania przy projekcie interfejsu.

## Uzgodnienia, których nie należy ponownie otwierać

- Zakres: Warszawa i okolice; pierwszy pełny wycinek przy Moście Siekierkowskim obejmuje cały węzeł, dojazdy/ścieżki do miejsca uproszczenia sieci i około 1 km Wisły w obu kierunkach.
- Widok globusa jest uproszczony; szczegółowe OSM i teren dotyczą obszaru prototypu.
- Układy bazowe: WGS84 dla OSM/globusa, EPSG:2180 dla lokalnych obliczeń i PL-EVRF2007-NH dla wysokości.
- Renderer: Three.js. Profil kraju: wersjonowany JSON, oddzielony od renderera, bez wykonywalnego kodu.
- Cache: trwały, początkowo 10 GB i regulowany; aktywna scena chroniona; LRU; odświeżanie ręczne z pytaniem przy niezapisanych zmianach.
- Wymagania sprzętowe i rozdzielczość testowa: Ryzen 5 7600, 32 GB DDR5, RX 6750 XT, DQHD 5120 × 1440; cele 60 kl./s w typowej nawigacji i minimum 30 kl./s w gęstej scenie.
- Edycja tagów jest lokalna i sesyjna, obejmuje dowolne tagi, aktualizuje podgląd i diagnostykę od razu oraz nie publikuje zmian do OSM.

## Zasada rozstrzygania

Nie wpisujemy niezweryfikowanych dostawców, licencji, parametrów technicznych ani krajowych konwencji jako faktów. Najpierw gromadzimy źródła i przykłady dla Warszawy, potem zapisujemy decyzje i ich uzasadnienie. Zmiana wcześniejszego ustalenia powinna być oznaczona jako nowa decyzja wraz z powodem.
