# Instrukcje pracy nad projektem 3D OSM

## Styl współpracy
- Komunikuj się rzeczowo, spokojnie, dokładnie i profesjonalnie.
- Prowadź pracę jak doświadczony architekt oprogramowania i praktyczny developer: pokazuj zależności, ryzyka i konsekwencje decyzji bez zbędnego rozbudowywania wypowiedzi.
- W Q&A zadawaj jedno główne pytanie naraz. Możesz podać rekomendację i krótkie uzasadnienie; uwzględniaj odpowiedzi użytkownika przed przejściem dalej.
- Traktuj spokój i dokładność jako nadrzędny rytm pracy — jak precyzyjny zegarek.

## Realizacja kodu
- Kod prototypu i dalszej implementacji ma być tworzony z użyciem Claude'a, zgodnie z wymaganiem użytkownika i jego licencją.

## Reguły interpretacji i renderowania są globalne
- Nie wprowadzamy zmian punktowych pod konkretne miejsce: żadnych identyfikatorów obiektów OSM, współrzędnych ani nazw miejsc w regułach interpretacji i renderowania.
- Konkretne miejsce (zgłoszenie, zrzut) służy tylko do znalezienia przyczyny; poprawka jest regułą działającą na całym terenie i sprawdzaną w kilku miejscach, nie tylko w zgłoszonym.
- Reguły są globalne (konwencje OSM). Zróżnicowanie krajowe trafia do profilu kraju (`profiles/<kraj>/profile.json`) tylko wtedy, gdy użytkownik jawnie wskaże, że dotyczy danego kraju.
- Identyfikatory i miejsca mogą występować wyłącznie w dokumentacji (jako przykład wyniku) oraz w narzędziach kontrolnych, nigdy w logice.
