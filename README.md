# GPX Track Splitter

Een webapplicatie om GPX wandel- en fietsroutes op te splitsen in dagetappes, de zwaarte per etappe te berekenen en de kaart offline mee te nemen.

## Live Demo

**https://obvius1.github.io/GPXTrackSplitter/**

## Wat doet deze applicatie?

GPX Track Splitter helpt je bij het plannen van meerdaagse tochten:

- GPX-bestanden laden en op een interactieve kaart tonen
- De route in dagetappes verdelen, met de hand of automatisch
- Per etappe afstand, hoogtemeters, equivalente kilometers en stapduur berekenen
- Rekening houden met je trainingsniveau en rugzakgewicht
- Overnachtingen en rustpunten markeren (camping, hotel, wildkamperen, ...)
- Elke dagetappe exporteren als GPX voor je horloge, OsmAnd, Komoot of Garmin
- Kaarttegels offline bewaren voor gebieden zonder bereik

## Hoe werkt het?

### 1. Route laden
Klik op **Route openen** en kies een GPX-bestand. Routes met `<trk>` of `<rte>` werken allebei; bestaat de GPX uit meerdere losse stukken, dan tellen de sprongen ertussen niet mee als gewandelde afstand.

Je werk wordt automatisch bewaard in de browser. Sluit je het tabblad per ongeluk, dan staat je route er bij het openen gewoon weer.

### 2. Verdelen in dagen

**Automatisch**: klik op het ✦-icoon in het paneel en kies het aantal dagen. De route wordt verdeeld in even *zware* dagen (stijgen en dalen tellen mee, niet alleen de kilometers).

**Met de hand**: klik op **Punt**, kies een type en klik op de route. De modus blijft actief, dus je kunt meerdere punten na elkaar plaatsen. `Esc` sluit af.

### 3. Punten aanpassen
- **Verplaatsen**: sleep een punt; het springt naar het dichtstbijzijnde punt op de route en de etappes worden opnieuw gesorteerd
- **Type of naam wijzigen**: klik op een punt
- **Verwijderen**: via het punt zelf of met "Punt weg" op de dagkaart
- **Ongedaan maken**: de ↶-knop of `Ctrl+Z`

### 4. Instellingen
- **Trainingsniveau**: van ongetraind tot zeer goed getraind
- **Rugzakgewicht**: 15 kg maakt een etappe ongeveer 20% zwaarder
- **Startdatum**: toont een datum bij elke dagetappe

Deze instellingen worden lokaal in je browser bewaard.

### 5. Bewaren en exporteren
- **Project opslaan**: je route en punten als JSON-bestand
- **Exporteren**: elke dag als apart GPX-bestand, alles in één GPX met een track per dag, of enkel de punten als waypoints

### 6. Offline kaart
Via **Offline** kies je een gebied, met een getekende veelhoek of als strook van ruim een kilometer rond je route. Alleen de tegels binnen dat gebied worden opgehaald; de schatting toont vooraf hoeveel tegels, hoeveel MB en hoe lang het ongeveer duurt. Een lopende download kun je stoppen; wat al binnen is blijft bruikbaar.

Opgeslagen gebieden staan met een stippellijn op de kaart. In "Opgeslagen gebieden" zie je het verbruik en verwijder je wat je niet meer nodig hebt; tegels die een ander gebied ook gebruikt blijven staan.

> De tegels komen van vrijwilligers van OpenStreetMap. Download alleen het gebied dat je echt nodig hebt - zie de [tile usage policy](https://operations.osmfoundation.org/policies/tiles/).

### 7. Onderweg
**GPS** toont je positie met een nauwkeurigheidscirkel, **Volgen** laat de kaart meebewegen. Onderaan verschijnt hoever het nog is tot het volgende punt op je route, en of je offline bent.

## Sneltoetsen

| Toets | Actie |
|-------|-------|
| `A` | Punt toevoegen aan/uit |
| `L` | GPS aan/uit |
| `F` | Hele route in beeld |
| `Ctrl+Z` | Ongedaan maken |
| `Esc` | Modus of venster sluiten |

## Moeilijkheidsberekening

### Equivalente kilometers
`(afstand + hm↑/80 + hm↓/150) × rugzakfactor`, met rugzakfactor `1 + gewicht/75` (15 kg = ×1,20).

Hoogtemeters worden berekend over een voortschrijdend gemiddelde van 5 punten, met een drempel van 0,5 m tegen GPS-ruis.
Die afvlakking loopt over de hele route, niet per dag: anders zou er bij elke dagovergang een stukje stijging wegvallen.

Verschillen met Komoot of Strava zijn normaal. Elk programma gebruikt een eigen hoogtemodel en een eigen filter, en
een verschil van 3 tot 5 procent op dezelfde route is gebruikelijk. Deze app rekent met de hoogtes die in het
GPX-bestand zelf staan en verzint er niets bij.

### Classificatie
De grenzen schuiven mee met je trainingsniveau:

| Niveau | Comfortabel | Stevig | Zwaar |
|--------|-------------|--------|-------|
| Ongetraind | < 20 km | 20-28 km | 28-35 km |
| Beginnend | < 24 km | 24-32 km | 32-40 km |
| Gemiddeld | < 30 km | 30-38 km | 38-45 km |
| Goed getraind | < 36 km | 36-44 km | 44-52 km |
| Zeer goed | < 42 km | 42-52 km | 52-60 km |

### Tijdsberekening
`(afstand/4) + (hm↑/500) + (hm↓/2000)`, aangepast aan het trainingsniveau. Het rugzakgewicht telt hier (nog) niet in mee.

## Punttypes

🚩 Splitpunt · ⛺ Wildkamperen · 🏕️ Camping · 🏨 Hotel/B&B · ☕ Rustpunt

## Technologie

- Pure HTML/CSS/JavaScript, geen frameworks en geen buildstap
- [Leaflet.js](https://leafletjs.com/) met OpenStreetMap-tegels
- IndexedDB voor offline tegels en de automatisch bewaarde sessie
- localStorage voor instellingen
- Service worker voor de app zelf (relatieve paden, werkt dus ook onder een submap zoals GitHub Pages)
- Donkere modus volgt je systeeminstelling

## Progressive Web App

Installeerbaar op desktop en mobiel:

**Desktop (Chrome/Edge)**: installatie-icoon in de adresbalk
**Android**: Menu → "App installeren"
**iOS**: Deel-icoon → "Zet op beginscherm"

> Op iOS wordt opslag van websites die *niet* op het beginscherm staan na ongeveer een week zonder gebruik gewist. Zet de app op je beginscherm als je de offline kaart lang vooraf downloadt.

## Browser Compatibiliteit

Alle moderne browsers met ES2020-ondersteuning (Chrome/Edge 105+, Firefox 110+, Safari 15.4+).

## Licentie

MIT - zie [LICENSE](LICENSE).
