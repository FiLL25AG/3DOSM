# Profile krajowe i kartografia

**Status:** profil jest wersjonowaną konfiguracją JSON oddzieloną od renderera; szczegółowy schemat pól do dopracowania.

**Zakres pierwszego prototypu:** interpreter obsługuje pełen zakres tagów i grupowań potrzebnych dla uzgodnionych klas oraz potwierdzonych scen testowych. Nie zakłada się implementacji każdego istniejącego tagu OSM. Wszystkie tagi źródłowe, także nierozpoznane przez interpreter, pozostają zachowane i widoczne w inspektorze.

## Po co profile krajowe

Każdy kraj może mieć inne źródła i układy danych, przepisy, lokalne rozszerzenia oraz zwyczaje mapujących. Te różnice wpływają zarówno na interpretację tagów, jak i na oczekiwany język graficzny mapy. Projekt ma więc stosować zasadę: **globalny silnik, lokalna interpretacja danych i lokalny styl kartograficzny**.

Nie oznacza to, że znaczenie każdego tagu OSM jest inne w każdym kraju. Reguły wspólne powinny być bazą globalną; profil krajowy dodaje, zawęża lub zmienia zachowanie tylko tam, gdzie istnieje uzasadnienie i udokumentowana reguła.

## Zawartość profilu

Profil kraju powinien docelowo opisywać:

- **Tożsamość i obszar:** kod kraju, zasięg geograficzny, wersja profilu.
- **Źródła danych:** OSM i krajowe źródła wysokościowe/uzupełniające, formaty, ograniczenia, atrybucję, licencje i dostępność.
- **Odniesienia przestrzenne:** układy współrzędnych źródeł, transformacje i wymagania precyzji.
- **Reguły interpretacji:** kategorie dróg, ulic, ścieżek, rowerowych, pieszych, transportu, pokrycia terenu, obiektów i lokalnych tagów.
- **Profil kartograficzny:** paleta, hierarchia, symbole, wzory oznaczeń, szerokości i zachowanie w różnych skalach.
- **Niepewność i braki:** nierozpoznane tagi, konflikty reguł, brak danych i poziomy pewności.
- **Pochodzenie i utrzymanie:** źródła reguł, wersja, data przeglądu i osoba/proces odpowiedzialny za aktualizację.
- **Atrybucję i warunki użycia:** wymagane oznaczenia dla źródeł krajowych i ich produktów danych.

## Trzy oddzielne elementy

1. **Katalog tagów i reguł globalnych** – wspólne, przenośne znaczenia i domyślne klasyfikacje.
2. **Nadpisania/reguły profilu kraju** – lokalna interpretacja i uzasadnione wyjątki.
3. **Styl kartograficzny profilu** – sposób przedstawienia wyniku interpretacji, bez zmiany semantyki ani danych źródłowych.

Reguły powinny być deterministyczne, wersjonowane i mieć określoną kolejność pierwszeństwa. Konflikty nie mogą być rozstrzygane ukrytym przypadkiem w rendererze.

Profil krajowy dostarcza deklaratywne ustawienia interpretacji i stylu w JSON walidowanym względem wersjonowanego schematu, a wspólny silnik wykonuje złożone operacje geometryczne. Profil nie zawiera wykonywalnego kodu. Każda reguła ma stabilny identyfikator, źródło/uzasadnienie i jawną kolejność; niezgodność lub brak rozstrzygnięcia pozostawia dane źródłowe bez zmian i podnosi diagnostykę.

## Zakres pierwszego profilu: Polska

Profil Polski będzie pierwszym kompletnym profilem, początkowo skupionym na Warszawie i okolicach. Do opracowania w pierwszej kolejności:

- hierarchia dróg i ulic;
- infrastruktura rowerowa, w tym drogi, pasy, ciągi współdzielone i lokalne oznaczenia;
- piesze drogi i szlaki;
- transport publiczny oraz infrastruktura kolejowa;
- pokrycie i użytkowanie terenu;
- źródła NMT/DEM, NMPT i LiDAR, o ile mają dostępność i jakość przydatną dla zakresu;
- symbole i sposób prezentacji, które będą rozpoznawalne w polskim kontekście.

Wygląd tras pieszych i rowerowych wynika z oznaczeń obecnych w OSM (w tym relacji tras oraz tagów takich jak `network`, `osmc:symbol` i `colour`) i reguł profilu Polski. Nie tworzymy z domysłu fizycznych znaków przy drodze; są pokazywane tylko wtedy, gdy zostały oddzielnie odwzorowane w danych.

Szczegółowe reguły nie są tu jeszcze deklarowane jako kompletne. Należy je oprzeć na udokumentowanych tagach, lokalnych konwencjach OSM, dostępnych źródłach i ocenie mapy przez użytkownika.

## Przykładowy przepływ: droga rowerowa

1. Zachowujemy wszystkie źródłowe tagi i geometrię obiektu.
2. Reguła globalna rozpoznaje ogólną semantykę tagów.
3. Profil Polski interpretuje lokalny wariant i ewentualną niejednoznaczność.
4. Styl polski przypisuje symbol/kolor/szerokość odpowiedni dla skali i kontekstu.
5. Jeśli brak podstaw do rozstrzygnięcia, obiekt otrzymuje neutralną prezentację i informację o niepewności.

Kolor lub wygląd drogi rowerowej nie może sam w sobie zmieniać jej klasyfikacji.

## Wymagania jakościowe

- zachować możliwość odtworzenia decyzji interpretacyjnej;
- odróżniać brak danych od braku obiektu;
- nie zakładać, że identyczny styl lub dostępność źródeł obowiązuje w każdym kraju;
- uwzględniać poziom skali, czytelność i konflikty symboli;
- notować źródło i uzasadnienie krajowej reguły;
- testować profile na rzeczywistych przykładach i przypadkach granicznych przed deklaracją kompletności.

## Zastosowanie w prototypie Polski

Pierwszy profil obejmie reguły i styl potrzebne dla Warszawy i okolic, w szczególności dróg, rowerów, szlaków pieszych, torów kolejowych, budynków i hydrologii. Stacje oraz transport publiczny są odłożone, ale model danych pozostanie rozszerzalny. Profil dostarcza zarówno reguły interpretacji, jak i lokalne symbole kartograficzne; globalny renderer otrzymuje już sklasyfikowane obiekty.

W prototypie profil Polski obejmuje podstawowe kategorie pokrycia terenu — lasy, parki i tereny zielone — jako kontekst wizualny dla szlaków pieszych i hydrologii.

Dla hydrologii OSM jest główną edytowalną geometrią, a BDOT10k i MPHP10k pełnią rolę referencyjną do wykrywania braków/rozbieżności. W prototypie rola referencyjna BDOT10k ogranicza się do hydrografii. Wynik diagnostyczny wskazuje źródła i nie nadpisuje tagów ani geometrii OSM. Obiekt brakujący w OSM może być pokazany jako oddzielna geometria referencyjna z oznaczeniem braku w OSM.

Panel inspektora ma ujawniać, które reguły profilu wpłynęły na wynik. Przy niejednoznaczności system raportuje rozpoznane tagi, powód niepewności i możliwe uzupełnienia, bez automatycznej zmiany danych OSM. Lokalna edycja tagów odświeża wynik interpretacji i styl na żywo.

W profilu Polski etykiety preferują polską nazwę `name:pl`; gdy jej brak, używają `name`. Pozostałe warianty nazw są zachowane i dostępne w inspektorze.
