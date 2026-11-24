# Lista startowa pierwszego wycinka — Claude Code

**Cel:** rozpocząć implementację pierwszego prototypu w istniejącym repozytorium 3DOSM bez kolejnej rundy pytań o uzgodnione wymagania.

**Zakres startu:** działający fundament aplikacji 3D i pionowy wycinek przy Moście Siekierkowskim. Ten dokument jest briefem roboczym dla Claude Code; nadrzędne wymagania są w dokumentach `01`–`07`.

## Ustalenia zamknięte — nie otwierać ponownie

- Prototyp: Warszawa i okolice; pierwszy pełny obszar to węzeł Mostu Siekierkowskiego, dojazdy i ścieżki do uproszczenia sieci oraz około 1 km Wisły w obu kierunkach.
- Globus uproszczony; szczegółowe OSM i teren ograniczone do obszaru prototypu.
- Three.js; OSM/globus w WGS84, lokalne obliczenia w EPSG:2180, wysokości w PL-EVRF2007-NH. Każda transformacja źródła ma być jawna i sprawdzona.
- Profil Polski to wersjonowany JSON poza rendererem, walidowany schematem i bez wykonywalnego kodu. Wszystkie źródłowe tagi pozostają dostępne, także nierozpoznane.
- Cache jest trwały, początkowo 10 GB i regulowany; chroni aktywną scenę, usuwa najdawniej używane dane i odświeża źródła ręcznie.
- Edycja tagów jest tymczasowa dla sesji, obejmuje dowolne tagi, natychmiast odświeża interpretację i scenę, pozwala cofnąć/przywrócić zmiany i nigdy nie publikuje ich do OSM.
- Główne funkcje pierwszego wycinka od początku obejmują wybór obiektu, inspektor, diagnostykę, lokalną edycję tagów i podgląd zmian. Nie odkładać ich na późniejszy etap.
- Sprzęt odniesienia: Ryzen 5 7600, 32 GB DDR5, RX 6750 XT; rozdzielczość DQHD 5120 × 1440; cele około 60 kl./s w typowej nawigacji i co najmniej 30 kl./s w gęstej scenie.

## Lista kontrolna przygotowania i realizacji

### Przed pierwszą sceną z danymi rzeczywistymi

- [ ] Obejrzeć strukturę repozytorium, bieżący kod i pliki `AGENTS.md`; zachować istniejący stack, jeśli już jest.
- [ ] Przeczytać dokumenty `01`–`07` i wskazać ich wymagania jako źródło prawdy.
- [ ] Wyznaczyć dokładny poligon pierwszego wycinka z geometrii OSM: pełny węzeł, dojazdy/ścieżki i odcinek Wisły.
- [ ] Potwierdzić kandydatów OSM z `06-inwentaryzacja-zrodel.md`: geometrię, tagi, członkostwa relacji i rzeczywiste poziomy.
- [ ] Sprawdzić pokrycie arkuszy NMT/NMPT/LiDAR oraz danych hydrograficznych w poligonie, układy/transformacje, daty, formaty i warunki użycia.
- [ ] Nie oznaczać kandydującego obiektu ani kolizji jako potwierdzonych, dopóki geometria i poziomy nie dają do tego podstaw.

### Implementacja pierwszego wycinka

- [ ] Zbudować lub rozwinąć aplikację w zastanym stacku z widokiem Three.js, uproszczonym globusem i przejściem do obszaru lokalnego.
- [ ] Uruchomić strumieniowanie: najpierw pokrycie zgrubne, potem dokładniejsze dane bez pustych luk; LOD regulowany przez użytkownika.
- [ ] Wczytać ciągły teren oraz wybrane i zweryfikowane źródła. OSM pozostaje główną geometrią edytowalną; hydrografia referencyjna jest oddzielną warstwą.
- [ ] Wdrożyć wersjonowany profil Polski w JSON, walidację oraz prześledzenie reguły, która wpłynęła na interpretację i styl obiektu.
- [ ] Zachować relacje i grupowanie obiektów; nie scalać geometrii tylko dlatego, że elementy należą do jednej relacji.
- [ ] Dodać wybór obiektu, inspektor tagów, interpretację, pochodzenie danych, niepewności oraz diagnostykę kolizji fizycznych i anomalii kontekstowych jako odrębnych kategorii.
- [ ] Dodać sesyjną edycję dowolnych tagów, natychmiastowe przeliczenie widoku/diagnostyki, diff i cofanie/przywracanie; brak zapisu do OSM.
- [ ] Zastosować polski interfejs i uzgodniony układ paneli na DQHD: górny panel rozwija się w dół, dolny w górę, mapa zachowuje pełną szerokość.
- [ ] Zaimplementować cache zgodnie z ustaleniami oraz ochronę aktywnej sceny i pytanie przed odrzuceniem zmian podczas ręcznego odświeżania.

## Kryteria odbioru

Pierwszy wycinek ocenić według sekcji **„Kryteria odbioru pierwszego wycinka”** w `04-prototyp.md`. W szczególności sprawdzić pełne pokrycie ustalonego obszaru, poprawną separację poziomów mostu i dróg, widoczność surowych tagów/reguł, natychmiastowy podgląd edycji i brak nieuzasadnionych potwierdzonych kolizji. Wynik wydajnościowy raportować na sprzęcie i rozdzielczości wskazanych wyżej; nie deklarować spełnienia celu bez pomiaru.

## Granice samodzielnych decyzji Claude Code

- Wolno dobierać szczegóły implementacyjne zgodne z dokumentacją, gdy są potrzebne do bieżącego zadania; zapisać krótko wybór i uzasadnienie.
- Nie wolno zmieniać zakresu produktu, przyjętego renderera, układów odniesienia, polityki cache ani zasad lokalnej edycji.
- Nie wolno zgadywać licencji, semantyki tagów, wysokości ani relacji obiektów. Brak danych ma być jawnie oznaczony i pozostawić diagnostykę w stanie niepewnym.
- Jeśli konkretna usługa lub licencja nie jest potwierdzona, przygotować wymienny adapter/konfigurację źródła i kontynuować niezależne elementy; nie przedstawiać danych zastępczych jako rzeczywistych danych OSM.
- Nie edytować ani nie usuwać plików synchronizowanych w `sources/`.
- Nie rozpoczynać od makiety statycznej. Rezultat ma być uruchamialną aplikacją z działającą sceną i przepływem użytkownika; jeśli rzeczywiste źródło blokuje dany element, jasno oznaczyć ograniczenie.

## Brief do wklejenia w Claude Code

```text
Pracujesz w repozytorium 3DOSM. Zacznij od odczytu AGENTS.md oraz dokumentów docs/01–07, a następnie sprawdź istniejący kod i strukturę repozytorium. Dokumentacja jest źródłem wymagań. Uzgodnione decyzje są zapisane w docs/05-plan-i-otwarte-decyzje.md i w sekcji „Ustalenia zamknięte” dokumentu docs/08-lista-startowa-claude-code.md; nie pytaj ponownie o te decyzje.

Zadanie: rozpocznij pierwszy działający wycinek prototypu przy Moście Siekierkowskim, zgodnie z docs/04-prototyp.md i checklistą w docs/08-lista-startowa-claude-code.md. Ma to być uruchamialna aplikacja, nie statyczna makieta. Pierwszy wycinek obejmuje cały węzeł, dojazdy/ścieżki do miejsca uproszczenia sieci i około 1 km Wisły w obie strony. Główne funkcje pierwszego wycinka to od początku: scena 3D, wybór obiektu, inspektor, diagnostyka, sesyjna edycja dowolnych tagów, natychmiastowy podgląd i cofnięcie.

Pracuj w istniejącym stacku, jeśli repozytorium już go ma; renderer to Three.js. Zachowaj WGS84 dla OSM/globusa, EPSG:2180 dla obliczeń lokalnych i PL-EVRF2007-NH dla wysokości. Profil Polski ma być wersjonowanym JSON-em poza rendererem, walidowanym względem schematu i bez wykonywalnego kodu. OSM pozostaje głównym źródłem edytowalnej geometrii. Nie publikuj zmian do OSM.

Najpierw przedstaw krótki plan implementacji oparty na rzeczywistej strukturze repozytorium, po czym realizuj zadanie etapami i zostawiaj repozytorium w stanie uruchamialnym. Nie zatrzymuj się na ponownym opisie makiety. Nie zgaduj licencji, układów danych, tagów, wysokości, relacji ani niepotwierdzonych kolizji. Kandydatów OSM i źródeł sprawdź zgodnie z docs/06-inwentaryzacja-zrodel.md. Niepotwierdzone dane pokaż jako brakujące/niepewne; jeśli źródło blokuje konkretny element, kontynuuj niezależne części i opisz blokadę. Nie przedstawiaj danych zastępczych jako rzeczywistych danych OSM.

Nie zmieniaj zatwierdzonego zakresu ani wcześniejszych decyzji. Nie edytuj zawartości sources/. Format kafelków, biblioteki pomocnicze i inne szczegóły implementacyjne możesz dobrać samodzielnie w ramach architektury; odnotuj wybory i uzasadnienie. Przed końcem podaj, co działa, jak uruchomić aplikację, co zostało zweryfikowane, jakie źródła/licencje lub dane nadal blokują pełną scenę i które kryteria odbioru z docs/04 są spełnione. Nie deklaruj wydajności bez pomiaru na sprzęcie Ryzen 5 7600 / 32 GB DDR5 / RX 6750 XT w 5120 × 1440.
```

## Co nadal wymaga pracy, ale nie kolejnych odpowiedzi użytkownika

Potwierdzenie geometrii fixtures OSM, dokładnego poligonu, pokrycia i licencji wybranych źródeł, dostępności hydrografii oraz pomiary wydajności to zadania wykonawcze/weryfikacyjne. Claude Code powinien je sprawdzać na podstawie danych i dokumentacji, a nierozstrzygalne ograniczenia opisać konkretnie. Nie są powodem do ponownego zadawania pytań o zatwierdzony zakres produktu.
