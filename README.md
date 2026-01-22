# GPX Track Splitter

> Dit project is volledig "vibe coded" met behulp van GitHub Copilot

Een webapplicatie om GPX wandel- en fietsroutes op te splitsen in kleinere segmenten en de moeilijkheidsgraad per segment te berekenen.

## Live Demo

**https://obvius1.github.io/GPXTrackSplitter/**

## Wat doet deze applicatie?

GPX Track Splitter helpt je bij het plannen van meerdaagse wandel- of fietstochten door:
- GPX bestanden te laden en op een kaart te visualiseren
- De route op te splitsen in dagstappen of segmenten
- Automatisch de moeilijkheidsgraad per segment te berekenen
- Rekening te houden met je trainingsniveau en rugzak gewicht
- Verschillende stopplaatsen te markeren (camping, hotel, wildcamperen, etc.)

## Hoe werkt het?

### 1. Route laden
- Upload een GPX bestand via de file input
- De route verschijnt automatisch op de interactieve kaart
- Je ziet direct statistieken voor de volledige route

### 2. Route opsplitsen
- Selecteer een punt type (Splitpunt, Wildcamperen, Camping, Hotel/B&B, Rustpunt)
- Klik op "Voeg punt toe"
- Klik op de kaart waar je het segment wilt afsluiten
- De applicatie vindt automatisch het dichtstbijzijnde punt op de route

### 3. Punten aanpassen
- **Verplaatsen**: Sleep markers naar een nieuwe positie
- **Type wijzigen**: Klik op een marker en selecteer een nieuw type
- **Verwijderen**: Gebruik de "Verwijder punt" knop bij een segment
- **Ongedaan maken**: Gebruik de paarse "Ongedaan maken" knop

### 4. Instellingen aanpassen
- Klik op "Instellingen"
- **Trainingsniveau**: Pas aan tussen Ongetraind en Zeer goed getraind
- **Rugzak gewicht**: Geef het gewicht van je rugzak in (0-25 kg)
- Deze instellingen worden lokaal opgeslagen in je browser

### 5. Project opslaan/laden
- **Bewaar project**: Slaat je route en alle splitpunten op als JSON bestand
- **Laad project**: Laad een eerder opgeslagen project terug

## Moeilijkheidsberekening

### Equivalente kilometers
De applicatie berekent equivalente kilometers op basis van:
- **Afstand** in kilometers
- **Hoogtemeters stijging** (÷ 80)
- **Hoogtemeters daling** (÷ 150)
- **Rugzak gewicht** (15kg = ×1.25)

Formule: `(afstand + hm↑/80 + hm↓/150) × rugzak_multiplier`

### Moeilijkheidsclassificatie
De thresholds voor moeilijkheidsgraad passen zich aan op basis van je trainingsniveau:

| Niveau | Comfortabel | Stevig | Zwaar |
|--------|-------------|--------|-------|
| Ongetraind | < 20 km | 20-28 km | 28-35 km |
| Beginnend | < 24 km | 24-32 km | 32-40 km |
| Gemiddeld | < 30 km | 30-38 km | 38-45 km |
| Goed getraind | < 36 km | 36-44 km | 44-52 km |
| Zeer goed | < 42 km | 42-52 km | 52-60 km |

### Tijdsberekening
Geschatte wandeltijd: `((afstand/4) + (hm+/500) + (hm-/2000))` aangepast voor trainingsniveau

## Marker types

- 🚩 **Splitpunt** (rood) - Algemeen splitpunt
- ⛺ **Wildcamperen** (groen) - Wildcampeerlocatie
- 🏕️ **Camping** (blauw) - Officiële camping
- 🏨 **Hotel/B&B** (paars) - Accommodatie
- ☕ **Rustpunt** (oranje) - Pauze of rustlocatie

## Technologie

- Pure HTML/CSS/JavaScript (geen frameworks)
- [Leaflet.js](https://leafletjs.com/) voor interactieve kaarten
- OpenStreetMap tiles
- localStorage voor settings persistentie
- Client-side GPX parsing

## Features

- ✅ GPX bestand upload en parsing
- ✅ Interactieve kaart met route visualisatie
- ✅ Dynamische segment kleuren op basis van moeilijkheidsgraad
- ✅ 5 verschillende marker types met kleuren
- ✅ Versleepbare en bewerkbare markers
- ✅ Undo functionaliteit (laatste 20 acties)
- ✅ Configureerbare settings (fitness niveau, rugzak gewicht)
- ✅ Project opslaan/laden als JSON
- ✅ Hover effecten en zoom naar segment
- ✅ Responsive design

## Browser Compatibiliteit

Werkt in alle moderne browsers die HTML5 en ES6+ ondersteunen.

## Licentie

Open source - gebruik en pas aan naar believen.
