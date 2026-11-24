# Prototyp techniczny — uzgodniony zakres

**Status:** zakres wstępnie uzgodniony w Q&A; przygotowanie specyfikacji do kodowania trwa. Kandydaci źródeł są opisani w `06-inwentaryzacja-zrodel.md`; dokładna granica, fixtures OSM, warunki wybranych danych i ilościowe progi akceptacji pozostają do zamknięcia.  
**Cel:** sprawdzić ryzyka geometrii, interpretacji OSM, hydrologii, edycji na żywo i wydajności na reprezentatywnym obszarze.

## Obszar i poziom szczegółowości

- **Obszar:** Warszawa i okolice, z ciągłym pokryciem oraz wyższą szczegółowością w miejscach testowych.
- **Poziom szczegółowości:** dobierany automatycznie według dystansu; użytkownik może regulować detal i zasięg widoku suwakiem.
- **Strumieniowanie:** dynamiczne ładowanie kafelków w widocznym obszarze. Najpierw ma pojawić się pokrycie zgrubne, następnie dokładniejsze kafelki mają płynnie zastępować rodziców bez pustych miejsc; odległe kafelki są zwalniane z pamięci.
- **Teren:** ciągły model wysokości jako warstwa bazowa; dokładniejsze dane wysokościowe, w tym LiDAR, uszczegóławiają obszary, w których są dostępne i użyteczne.
- **Wygląd terenu:** delikatne cieniowanie reliefu i naturalna paleta wysokości; warstwa wysokościowa może być włączana/wyłączana. Skala pionowa 1:1 jest domyślna, z opcjonalnym zwiększeniem wyolbrzymienia dla analiz.
- **Braki wysokościowe:** małe luki NMT mogą być interpolowane z sąsiedztwa i oznaczane jako przybliżone; większe braki pozostają jawnie widoczne jako brak danych.
- **Odświeżanie:** pokazujemy czas pobrania/aktualności warstw, gdy źródło udostępnia takie metadane. Odświeżenie źródeł następuje na żądanie; w trakcie lokalnej edycji aktywny zestaw danych pozostaje stabilny. Jeśli istnieją zmiany sesyjne, przed odświeżeniem użytkownik wybiera pozostanie przy bieżących danych albo odrzucenie tych zmian i odświeżenie.
- **Lokalne zmiany:** edycje tagów są tymczasowe dla bieżącej sesji, można je cofnąć, a po zamknięciu prototypu źródłowe dane pozostają niezmienione.
- **Priorytet sprzętowy:** desktop.
- **Łączność:** aplikacja online; cache jest trwały między uruchomieniami, ma początkowy limit 10 GB (zmienialny), chroni aktywną scenę i przechowuje metadane aktualności. Po zapełnieniu usuwa najdawniej używane dane. Odświeżanie ręczne; tryb offline poza zakresem.
- **Renderowanie:** Three.js.
- **Profil:** Polska, z krajowymi regułami interpretacji i stylem kartograficznym.
- **Język interfejsu:** polski w pierwszym prototypie; architektura powinna umożliwić dodanie kolejnych języków.

## Warstwy i obiekty

Przy starcie włączone są warstwy bazowe: teren, budynki, drogi, infrastruktura rowerowa, szlaki piesze, tory kolejowe, hydrologia i pokrycie terenu. Etykiety oraz szczegółowość zależą od skali. Ortofotomapa jest domyślnie wyłączona.

Interpreter obejmuje pełny zakres tagów i grupowań istotnych dla tych klas oraz potwierdzonych scen testowych. Nie zakładamy implementacji wszystkich tagów OSM na świecie. Dane źródłowe zawsze zachowują wszystkie tagi; nierozpoznane wartości są dostępne w inspektorze i nie są po cichu odrzucane.

Kontrola kolizji działa automatycznie dla widocznego obszaru, a oznaczenia wykrytych problemów są domyślnie widoczne; można je ukryć.

Niepewne lub niekompletne dane mają osobne oznaczenia mapowe, odróżnione od kolizji. Są widoczne domyślnie i można je ukryć; panel wyjaśnia, co wymaga pracy edytorskiej.

Warstwy referencyjne BDOT10k/MPHP10k są domyślnie widoczne w trybie diagnostycznym, wizualnie odróżnione od OSM i niezależnie przełączalne.

Panel diagnostyczny pozwala niezależnie filtrować co najmniej kolizje, brakujące tagi/wysokości oraz pozostałe niepewne dane.

Wyniki są sortowane najpierw według wagi problemu, a następnie odległości od kamery. Wybór wyniku centruje i przybliża widok na odpowiedni obiekt.

1. Grunt z NMT jako podstawowego modelu terenu. NMPT i LiDAR służą do lokalnego uszczegóławiania oraz weryfikowania powierzchni i wysokości obiektów; nie zastępują semantyki i geometrii obiektów z OSM. Przed połączeniem danych trzeba sprawdzić ich układy odniesienia i wysokościowe oraz jawnie je ujednolicić. Wstępne indeksy arkuszy opisuje `06-inwentaryzacja-zrodel.md`; pokrycie dokładnych fixtures pozostaje do potwierdzenia.
2. Budynki z OSM: wysokości z tagów, jeżeli istnieją; w pozostałych przypadkach wysokość przybliżona i oznaczona jako taka. Obsługujemy tagi budynku i dachu występujące w obszarze testowym, zachowując wszystkie tagi źródłowe. Nieznane tagi pozostają widoczne w inspektorze.
3. Drogi i ulice.
4. Infrastruktura rowerowa oraz szlaki piesze.
5. Tory kolejowe. Stacje i warstwa transportu publicznego są poza pierwszym zakresem, ale model danych ma umożliwiać ich późniejsze dodanie.
6. Hydrologia od początku: rzeki, cieki, zbiorniki, brzegi i koryta oraz ich relacja z terenem i obiektami. OSM pozostaje główną edytowalną geometrią; BDOT10k i MPHP10k są warstwami referencyjnymi do wykrywania braków i rozbieżności, raportowanymi ze wskazaniem źródła. Dno/głębokość pokazujemy tam, gdzie istnieją wiarygodne dane; braki są jawne. Mosty i przepusty uwzględniamy w relacji do wody. Symulacje przepływu i powodzi są osobnym zakresem.

Poziom powierzchni wody korzysta z wiarygodnych rzędnych, jeśli są dostępne. Bez takich danych powierzchnia może być pokazana jako przybliżona i niepewna; nie służy wówczas do potwierdzania kolizji.

Obiekt hydrograficzny znaleziony w źródle referencyjnym, którego brakuje w OSM, może być widoczny jako osobna geometria referencyjna z oznaczeniem „brak w OSM”; nie staje się przez to częścią geometrii OSM.
7. Podstawowe pokrycie terenu z OSM: lasy, parki i tereny zielone jako kontekst dla szlaków i hydrologii. Pojedyncze drzewa 3D uwzględniamy tam, gdzie dostępne są wiarygodne dane.
8. Obiekty mogące powodować konflikty przestrzenne, w tym podpory mostów, słupy oświetlenia i sygnalizacji, o ile są dostępne w danych.
9. Nazwy ulic, rzek i ważnych miejsc, wyświetlane zależnie od skali; w profilu Polski preferowane jest `name:pl`, z `name` jako wariantem zapasowym. Inne warianty nazw pozostają w danych i inspektorze.
10. Ortofotomapa jako opcjonalna warstwa porównawcza, domyślnie wyłączona; jej data i rozdzielczość są widoczne w informacjach o warstwie.

Styl Polski ma zachować lokalne konwencje i rozpoznawalne symbole dla dróg, tras rowerowych i szlaków, w ramach spójnego, czytelnego widoku 3D.

Style tras pieszych i rowerowych wynikają z danych OSM i reguł profilu Polski, w tym z relacji tras oraz dostępnych oznaczeń (`network`, `osmc:symbol`, `colour`). Prototyp nie generuje fizycznych znaków terenowych, jeśli nie są osobnymi obiektami w OSM.

## Obszary testowe i przypadki brzegowe

Pierwszy działający wycinek end-to-end powstaje przy Moście Siekierkowskim. Obejmuje cały węzeł mostowy, dojazdy i ścieżki do miejsc, w których sieć się upraszcza, oraz około 1 km Wisły w górę i w dół od mostu. Już w tym wycinku dostępne są: wybór obiektu, inspektor tagów i interpretacji, diagnostyka kolizji/niepewności oraz sesyjna edycja tagów z natychmiastowym przeliczeniem, podglądem różnic i cofnięciem. Są to elementy warunku odbioru pierwszego wycinka, a nie późniejsze rozszerzenia. W tym miejscu w pierwszej kolejności weryfikujemy model terenu i separację poziomów. Kolejne sceny walidacyjne to: rondo Marsa i wiadukty w stronę Żołnierskiej; Zielonka/Marki z lokalnymi przeprawami nad Długą; na końcu złożone grupowanie budynku i dachy PKiN. Dokładny poligon wycinka zostanie wyprowadzony z geometrii przypadków OSM i dostępnych arkuszy danych.

- Most Siekierkowski i pobliskie wiadukty (pierwszy wycinek end-to-end).
- Rondo Marsa oraz wiadukty w stronę ulicy Żołnierskiej.
- Przejścia nadziemne i podziemne.
- Zielonka i Marki, w tym wiadukty nad autostradą.
- Lokalne małe mosty oraz ścieżki przy rzece Długiej.
- Pałac Kultury i Nauki jako przypadek złożonego grupowania budynku i jego części.

Te miejsca służą jako przypadki testowe dla prawidłowych połączeń i poziomów w 3D, interpretacji tagów, relacji do terenu i wody oraz kontroli kolizji.

Kandydaci na identyfikatory OSM są zebrani w `06-inwentaryzacja-zrodel.md`. Przed zamrożeniem zestawu testowego trzeba potwierdzić geometrie, członkostwa relacji, sąsiednie obiekty i tagi.

Kolejność walidacji prototypu: najpierw kompletny wycinek przy Moście Siekierkowskim; następnie rondo Marsa i wiadukty Żołnierskiej; dalej Zielonka/Marki i Długa; na końcu grupowanie części i dachy na przykładzie PKiN.

## Nawigacja

- Przy uruchomieniu kamera startuje nad Warszawą; oddalenie prowadzi do uproszczonego globusa. Szczegółowe OSM i teren są dostępne w obszarze prototypu; pełne dane świata pozostają poza zakresem.
- Szybki wybór/wyszukiwarka prowadzi do wskazanych lokalizacji testowych: mostu Siekierkowskiego, ronda Marsa, Zielonki, Marek, rzeki Długiej i PKiN.
- Wyszukiwarka przyjmuje nazwę miejsca, współrzędne lub identyfikator OSM; wybór otwiera lokalizację i obiekt w inspektorze.
- Płynne przejście między globusem a widokiem lokalnym.
- Obracanie, pochylanie i przybliżanie/oddalanie.
- Łatwy powrót do widoku z góry.
- Przycisk ustawiający północ u góry oraz blokada północy. Blokada zatrzymuje obrót azymutalny; pochylanie i zoom pozostają dostępne.
- Na ekranie DQHD mapa wykorzystuje pełną szerokość. Zwijany panel warstw i nawigacji znajduje się u góry pośrodku i rozwija w dół; inspektor/diagnostyka znajduje się na dole pośrodku i rozwija w górę. Nie stosujemy stałych bocznych paneli.

## Inspektor obiektu i edycja na żywo

Po wybraniu obiektu użytkownik widzi panel zawierający:

- identyfikator i typ obiektu;
- odczytane tagi;
- zastosowaną interpretację/profilową regułę;
- niepewność lub wykryty konflikt;
- możliwe tagi do uzupełnienia wraz z przyczyną i uzasadnieniem.
- pochodzenie danych oraz — jeśli dostępne — datę pozyskania, rozdzielczość i układ wysokościowy.
- link do obiektu źródłowego OSM oraz linki do dokumentacji OSM dla proponowanych tagów/reguł.

Przy kliknięciu części zgrupowanego budynku inspektor pokazuje wybraną część, relację nadrzędną oraz pozostałe części grupy, zachowując możliwość osobnej analizy i edycji.

Prototyp umożliwia lokalne dodawanie, zmianę i usuwanie dowolnych tagów wybranego obiektu, także nierozpoznanych przez interpreter, oraz natychmiastowe przeliczenie interpretacji i wyglądu mapy. Walidacja zgłasza błędne lub nierozpoznane wartości jako ostrzeżenia, ale nie blokuje ich wpisania. Panel pokazuje wartości źródłowe obok zmienionych, wyróżnia różnice i pozwala cofnąć zmiany albo przywrócić wartości źródłowe. Prototyp nie zapisuje ich bezpośrednio do OSM; edytor OSM pozostaje miejscem publikacji zmian.

## Kontrola kolizji 3D

- Sprawdzamy fizyczne konflikty geometrii w trzech wymiarach oraz podejrzane umieszczenie obiektów w kontekście dróg, np. podpory mostu, słupa oświetlenia lub sygnalizacji w obrysie jezdni.
- Kontrola obejmuje też części budynków i dachy; poprawne wspólne granice sąsiadujących części nie są zgłaszane jako kolizja.
- Wiadukt nad drogą lub przejście nadziemne nie jest kolizją, jeżeli geometrie są rozdzielone w pionie.
- Wynik rozróżnia **kolizję potwierdzoną** od **podejrzenia opartego na wymiarach przybliżonych**.
- Kolizja fizyczna jest potwierdzona tylko wtedy, gdy wiarygodne geometrie i poziomy obu obiektów wykazują rzeczywiste przecięcie. Przybliżonej wysokości lub nieznanego poziomu nie wolno używać do potwierdzenia.
- Konflikt kontekstowy, np. słup wewnątrz jezdni, jest osobnym typem raportu. Może otrzymać status potwierdzony tylko wtedy, gdy położenie obiektów jest wiarygodne.
- Waga wpływu problemu i pewność wykrycia są osobnymi polami diagnostycznymi; poważne, ale niepewne przypadki nie są utożsamiane z drobnymi, pewnymi problemami.
- Raport jest dostępny w panelu wybranego obiektu i wskazuje przyczynę oraz użyte dane.
- Każdy raport wskazuje oba obiekty, identyfikatory, tagi, przyczynę konfliktu, ich poziomy 3D oraz oddzielne oceny wagi problemu i pewności wykrycia.
- Identyfikatory w panelu pozwalają otworzyć obiekty źródłowe w OSM; linki są nawigacyjne, a zmiany w prototypie nie zapisują danych w OSM.
- Brak wymiarów lub niewystarczające tagi nie uzasadniają arbitralnego stwierdzenia kolizji.

## Zasady niepewności

Gdy tagi lub geometria nie wystarczają do ustalenia połączenia albo poziomu obiektu, system nie zgaduje. Oznacza przypadek jako niepewny i wyjaśnia, co interpreter rozpoznał oraz jakie tagi mogą pomóc. Proponowane tagi muszą być uzasadnione regułami profilu i sprawdzone względem dokumentacji OSM. Użytkownik jako edytor decyduje, czy i jak poprawić dane.

Jeśli tagi OSM dotyczące położenia pionowego są sprzeczne z NMPT lub LiDAR, geometria/tagi OSM pozostają bazą edytowalną. System raportuje rozbieżność, pokazuje pochodzenie i parametry obu źródeł oraz nie nadpisuje automatycznie danych OSM.

## Źródła i atrybucja

Widok mapy stale pokazuje krótką atrybucję „© OpenStreetMap contributors” z linkiem do informacji o ODbL. Rozwijany panel źródeł pokazuje aktywne warstwy, ich pochodzenie i — jeśli dostępne — aktualność, rozdzielczość oraz układ odniesienia. Wymagane informacje i warunki wykorzystania pozostałych źródeł są sprawdzane osobno dla każdego produktu danych.

## Złożone budynki i relacje

Interpreter rozpoznaje relacje `type=building` i role członków `outline` oraz `part`, grupując części w jeden obiekt logiczny przy zachowaniu geometrii i tagów poszczególnych elementów. Osobno obsługuje relacje budynków `type=multipolygon` i role `outer`/`inner`, zachowując ich geometrię i członkostwa. Przypadek PKiN sprawdza tę strukturę multipolygon; role ani notatki członków nie są automatycznie zamieniane na semantyczne tagi `building:part`. Jeśli relacja jest niekompletna lub niespójna, poprawnie opisane części pozostają widoczne, a grupa otrzymuje diagnostykę wyjaśniającą brakujące lub sprzeczne elementy.

Model dachów uwzględnia tagi dachu dostępne w obszarze testowym. Gdy brak tagów kształtu, renderer stosuje neutralny dach domyślny i oznacza go jako przybliżenie.

## Kryteria oceny prototypu

Prototyp będzie oceniany przez to, czy:

1. kamera płynnie przechodzi od globusa do obszaru lokalnego i obsługuje uzgodnione sterowanie;
2. drogi, mosty, wiadukty, przejścia i tunele zachowują poprawną separację pionową w miejscach testowych;
3. hydrologia jest częścią modelu sceny od początku, a mosty/przepusty zachowują relację do wody i terenu;
4. panel pokazuje tagi, interpretację, niepewność, konflikty i uzasadnione sugestie;
5. zmiana tagu w panelu natychmiast zmienia wynik na mapie i można ją cofnąć;
6. kolizje potwierdzone są odróżnione od podejrzeń opartych na przybliżeniach; kontrola obejmuje też dachy i części budynków;
7. poziom detalu reaguje na dystans i można go regulować;
8. kafelki doczytują się stopniowo bez pustych fragmentów, a zgrubny widok pozostaje widoczny do czasu otrzymania danych dokładniejszych;
9. nazwy i lokalny styl Polski pozostają czytelne przy różnych skalach.

Progi wydajności, dokładności oraz konkretne źródła danych trzeba ustalić przed implementacją prototypu.

Wstępny cel wydajnościowy: około 60 kl./s przy typowej nawigacji i co najmniej 30 kl./s w gęstych obszarach testowych na ustalonym desktopie. Docelowy sprzęt trzeba zanotować przy pomiarach.

Punkt odniesienia sprzętowego: 32 GB RAM DDR5, procesor AMD Ryzen 5 7600, karta graficzna AMD Radeon RX 6750 XT. Rozdzielczość testowa: DQHD 5120 × 1440 (format 32:9).

### Kryteria odbioru pierwszego wycinka

Pierwszy wycinek przy Moście Siekierkowskim przechodzi odbiór funkcjonalny, gdy:

1. scena obejmuje cały uzgodniony węzeł, dojazdy/ścieżki do uproszczenia sieci i ok. 1 km Wisły w obu kierunkach, bez luk w bazowym terenie;
2. drogi mostowe, konstrukcja mostu, Wisła, pieszo-rowerowe przebiegi, sygnalizacja i lampy są rozróżnialne w scenie; relacja `route=road` zachowuje członkostwo jako kontekst bez dublowania geometrii, a wszystkie obiekty zachowują tagi i identyfikatory;
3. most i jego dojazdy nie są raportowane jako fizyczne kolizje wyłącznie dlatego, że ich rzuty 2D przecinają drogi lub wodę na innym poziomie;
4. wybór obiektu pokazuje surowe tagi, interpretację/regułę profilu, pochodzenie oraz niepewności; nieznane tagi pozostają dostępne;
5. dodanie, zmiana i usunięcie tagu odświeża wygląd i diagnostykę bez przeładowania sceny, pokazuje różnicę względem wartości źródłowej i może zostać cofnięte/przywrócone;
6. nierozpoznana lub podejrzana wartość generuje ostrzeżenie bez blokowania edycji; zmiany nie są wysyłane do OSM i nie pozostają po zamknięciu sesji;
7. ręczne odświeżenie przy lokalnych zmianach wymaga wyboru użytkownika; aktywna scena pozostaje chroniona w cache, dopóki użytkownik nie zleci jawnego odświeżenia;
8. przejście testowe przy 5120 × 1440 mierzy płynność i ładowanie; cel wydajności to około 60 kl./s podczas typowej nawigacji i minimum 30 kl./s w gęstej scenie.

Identyfikatory w `06-inwentaryzacja-zrodel.md` są kandydatami do fixtures. W kryteriach dotyczących podpór, lamp i sygnalizacji status kolizji ustala się dopiero po potwierdzeniu geometrii i wysokości; brak wiarygodnych danych oznacza podejrzenie albo brak podstaw do raportu.

## Wstępne źródła wysokościowe do weryfikacji

- [GUGiK — NMT](https://www.geoportal.gov.pl/pl/dane/numeryczny-model-terenu-nmt/): grunt jako baza wysokościowa.
- [GUGiK — NMPT](https://www.geoportal.gov.pl/pl/dane/numeryczny-model-pokrycia-terenu-nmpt/): powierzchnia wraz z obiektami nad gruntem; używać do weryfikacji i lokalnego uszczegóławiania.
- [GUGiK — LiDAR](https://www.geoportal.gov.pl/pl/dane/dane-pomiarowe-lidar-lidar/): dane punktowe o klasach i wysokościach; zakres i datę pozyskania sprawdzić dla lokalizacji testowych.
- [GUGiK — ortofotomapa](https://www.geoportal.gov.pl/pl/dane/ortofotomapa-orto/): opcjonalna warstwa zdjęciowa; dobór wersji według aktualności/rozdzielczości i dostępności dla obszaru.
- [GUGiK — BDOT10k](https://www.geoportal.gov.pl/pl/dane/baza-danych-obiektow-topograficznych-bdot10k/): w prototypie źródło referencyjne wyłącznie dla hydrografii.
- [Wody Polskie — MPHP10k](https://dane.gov.pl/pl/dataset/2167%2Cmapa-podzialu-hydrograficznego): źródło referencyjne dla sieci hydrograficznej.

Wstępna inwentaryzacja źródeł nie zastępuje kontroli licencji, daty pozyskania, pokrycia, formatu i układu wysokościowego dla konkretnych arkuszy.

## Poza pierwszym zakresem

Pełne pokrycie świata, tryb offline, stacje i warstwa transportu publicznego, zapis zmian do OSM, kompletna biblioteka profili krajowych, symulacja przepływu/powodzi oraz zaawansowana analiza pozostają poza pierwszym zakresem. Architektura powinna umożliwić ich późniejsze dodanie.
