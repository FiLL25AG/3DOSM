# Przygotowanie przekazania do Claude Code

**Status:** plan przygotowania; nie jest poleceniem rozpoczęcia implementacji. Kod prototypu ma powstać z Claude Code zgodnie z ustaleniem projektu.

## Po co ten dokument

Zamienić uzgodnioną dokumentację produktu w serię małych, sprawdzalnych zadań dla Claude Code. Każde zadanie musi wskazywać źródłowe wymagania, granice zmian, zależności, sposób weryfikacji i kryteria odbioru. Claude nie powinien podejmować za użytkownika otwartych decyzji o zachowaniu produktu, danych lub licencjach.

## Materiały źródłowe

- `01-zalozenia.md` — cel, użytkownik i ogólne założenia.
- `02-architektura.md` — granice modułów i przepływ danych.
- `03-profile-krajowe.md` — odpowiedzialność profili i lokalny styl.
- `04-prototyp.md` — zachowania oraz wstępne kryteria oceny.
- `05-plan-i-otwarte-decyzje.md` — status decyzji i bramki gotowości.
- `06-inwentaryzacja-zrodel.md` — kandydaci źródeł, zasięg i przypadki OSM.
- `AGENTS.md` — reguły pracy repozytorium; w szczególności wymóg tworzenia kodu z Claude Code.

## Warunki rozpoczęcia kodowania

Przed przekazaniem pierwszego zadania implementacyjnego dokumentacja powinna wskazywać:

1. zamknięty zakres pierwszego prototypu, obszar i zestaw zweryfikowanych przypadków OSM;
2. źródła dla każdego przypadku, ich warunki użycia, atrybucję, datę, rozdzielczość, układy odniesienia i zasady cache;
3. obowiązujące decyzje o współrzędnych i granicach odpowiedzialności modułów (uzgodniona baza: WGS84 dla OSM/globusa, EPSG:2180 dla lokalnych obliczeń i PL-EVRF2007-NH dla wysokości; transformacje źródeł muszą być jawne i sprawdzone; formaty kafelków i danych można ustalać w zadaniu implementacyjnym);
4. wynik oczekiwany dla kluczowych przypadków oraz mierzalne kryteria odbioru i wydajności;
5. listę jawnie odłożonych funkcji, których Claude nie ma implementować w prototypie.

Interfejs pierwszego prototypu jest po polsku; konstrukcja tekstów powinna umożliwiać późniejszą lokalizację.

Cache prototypu działa między uruchomieniami, ma początkowy limit 10 GB z możliwością zmiany, chroni aktywną scenę, usuwa najdawniej używane dane i pokazuje aktualność źródeł; odświeżanie jest ręczne. Nie implementować pełnego trybu offline.

Globusem steruje uproszczona warstwa Ziemi; szczegółowe OSM i teren są ładowane wyłącznie dla obszaru prototypu. Nie pobierać ani nie renderować szczegółowej mapy całego świata.

Docelowy sprzęt do pomiarów jest znany: AMD Ryzen 5 7600, 32 GB RAM DDR5, AMD Radeon RX 6750 XT, rozdzielczość DQHD 5120 × 1440.

Interpreter ma pełną obsługę tagów wymaganych przez zatwierdzone klasy/sceny testowe oraz zachowuje i ujawnia wszystkie pozostałe tagi. Nie należy rozszerzać zakresu do pełnego katalogu tagów OSM bez osobnej decyzji.

Styl tras w Polsce ma wynikać z istniejących oznaczeń OSM i wersjonowanych reguł profilu; nie wolno generować niezamapowanych fizycznych znaków terenowych.

Kolizję fizyczną wolno potwierdzić wyłącznie na podstawie wiarygodnej geometrii i poziomów obu obiektów. Przypadki zależne od przybliżeń są podejrzeniami; anomalia kontekstowa, jak słup w jezdni, jest raportowana osobno.

Profil kraju jest wersjonowaną konfiguracją JSON poza rendererem, walidowaną względem schematu i bez wykonywalnego kodu. Proste reguły lokalne są opisane profilem, złożone obliczenia pozostają we wspólnym silniku; szczegółowy schemat pól trzeba jawnie zaprojektować.

Nie każda decyzja o pełnej wersji świata musi być rozstrzygnięta. Otwarte kwestie muszą jednak być oznaczone i nie mogą blokować ani zmieniać zakresu zadania bieżącego.

## Docelowa kolejność pakietów prac

Poniższa kolejność jest robocza. Pierwszym celem jest kompletny wycinek end-to-end przy Moście Siekierkowskim; konkretne zadania i zależności zostaną dopisane po zamknięciu warunków rozpoczęcia.

Pierwszy wycinek musi już zawierać pełny główny przepływ użytkownika: wybór obiektu, inspektor, diagnostykę, lokalną edycję tagów, natychmiastowe przeliczenie i cofnięcie. Kolejność poniżej rozbija pracę według zależności technicznych; nie oznacza odkładania tych funkcji do późniejszego zakresu.

Edytor tagów ma umożliwiać dodawanie, zmianę i usuwanie dowolnych kluczy/wartości, również nierozpoznanych. Zmiany są tymczasowe, od razu przeliczają scenę i nie są zapisywane do OSM.

Walidacja tagów może pokazywać ostrzeżenia o nierozpoznanych lub podejrzanych wartościach, ale nie blokuje ich wpisania.

Przy ręcznym odświeżeniu źródeł w obecności lokalnych zmian aplikacja pyta użytkownika, czy pozostać przy aktywnych danych, czy odrzucić zmiany i odświeżyć; nie wolno ich po cichu utracić.

1. **Wycinek przy Moście Siekierkowskim:** fundament aplikacji i układ współrzędnych potrzebne do jednego działającego, możliwego do obejrzenia scenariusza.
2. **Dane, teren i ładowanie:** źródła i transformacje, ciągły teren, szczegółowość, doczytywanie bez pustych luk i zwalnianie danych poza zasięgiem.
3. **Interpretacja sceny:** wymagane dla tego miejsca obiekty OSM, polskie reguły, most, drogi, jezdnie/ścieżki pod mostem, łącznice i Wisła.
4. **Inspektor i diagnostyka:** tagi i ich interpretacja, poziomy, niepewność, kolizje potwierdzone/podejrzane oraz lokalna edycja z cofnięciem.
5. **Nawigacja i odbiór pierwszego wycinka:** widok lokalny, panel, DQHD i pomiary na uzgodnionym sprzęcie.
6. **Rozszerzenie scen:** Marsa/Żołnierska, Zielonka/Marki/Długa, następnie PKiN; na tych etapach uzupełniamy ogólne obiekty i przypadki relacji/dachów.

Etapy można podzielić na mniejsze zadania. Każde powinno kończyć się działającym, możliwym do obejrzenia rezultatem zamiast dużej, niezweryfikowanej zmiany.

## Format pojedynczego zadania dla Claude Code

Każde zadanie otrzyma:

- **Cel:** jeden obserwowalny rezultat.
- **Kontekst:** odnośniki do wymagań i decyzji projektowych.
- **Zakres:** konkretne elementy do dodania lub zmiany.
- **Ograniczenia:** czego zadanie nie obejmuje i jakich danych/reguł nie wolno zgadywać.
- **Kryteria odbioru:** zachowanie widoczne dla użytkownika oraz warunki jakości.
- **Weryfikacja:** wskazane sprawdzenia i sposób pokazania wyniku.
- **Raport końcowy:** pliki zmienione, decyzje, ograniczenia i następne zależności.

Odbiór pierwszego wycinka jest opisany w sekcji „Kryteria odbioru pierwszego wycinka” w `04-prototyp.md`. Zadania dla Claude Code muszą linkować do tych kryteriów, zamiast przepisywać je nieco inaczej.

Claude Code ma zgłosić brakujące informacje blokujące zadanie zamiast wymyślać wymagania. Zmiany architektury lub zakresu wymagają aktualizacji dokumentacji przed dalszą implementacją.

## Aktualny stan przekazania

Dokumentacja produktu i architektury jest zebrana. Pierwszy wycinek ustalono funkcjonalnie: cały węzeł Mostu Siekierkowskiego, dojazdy/ścieżki do uproszczenia sieci i ok. 1 km Wisły w obu kierunkach. Dokładny poligon nadal wymaga geometrii potwierdzonych fixtures OSM. Następne prace dotyczą potwierdzenia fixtures i hydrologii, dokładnego pokrycia wybranych źródeł, mierzalnej metody odbioru oraz sprawdzenia spójności całości. Uzgodnione układy współrzędnych, renderer i podstawowa polityka cache są już zamknięte i nie są blokadami do ponownego rozstrzygnięcia. Potem przygotujemy konkretne zadania dla Claude Code.

Na tym etapie nie generujemy kodu ani polecenia startowego dla Claude Code.
