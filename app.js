/* ============================================================
   GPX Track Splitter
   Splitst een GPX-route in dagetappes, berekent de zwaarte per
   etappe en bewaart kaarttegels offline.
   ============================================================ */

const APP_VERSION = '3.0';

/* ---------- Status ---------- */
let map = null;
let tileLayer = null;
let gpxData = [];            // [{lat, lon, ele}]
let trackName = '';
let gpxPolyline = null;      // volledige route (zichtbaar zolang er niet gesplitst is)
let segmentPolylines = [];
let splitMarkers = [];       // altijd gesorteerd op pointIndex
let markerHistory = [];
let isAddingPoint = false;
let pendingMarkerType = 'split';
let editingMarker = null;

/* Instellingen */
const DEFAULT_SETTINGS = { fitnessLevel: 2, backpackWeight: 15, startDate: '' };
let settings = { ...DEFAULT_SETTINGS };

/* Punttypes - kleuren zijn inline SVG/CSS, dus geen externe afbeeldingen nodig */
const markerTypes = {
    split:    { name: 'Splitpunt',     icon: '\u{1F6A9}', color: '#dc2626' },
    wildcamp: { name: 'Wildkamperen',  icon: '\u{26FA}',  color: '#16a34a' },
    camping:  { name: 'Camping',       icon: '\u{1F3D5}', color: '#2563eb' },
    hotel:    { name: 'Hotel/B&B',     icon: '\u{1F3E8}', color: '#7c3aed' },
    rest:     { name: 'Rustpunt',      icon: '\u{2615}',  color: '#ea580c' }
};

/* ============================================================
   Kleine hulpjes
   ============================================================ */

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** Getallen met een komma, zoals in het Nederlands gebruikelijk. */
function nf(value, decimals = 1) {
    if (!isFinite(value)) return '-';
    return value.toLocaleString('nl-BE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatHours(hours) {
    if (!isFinite(hours) || hours < 0) hours = 0;
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m === 60 ? `${h + 1}u00` : `${h}u${String(m).padStart(2, '0')}`;
}

function formatBytes(mb) {
    return mb >= 1024 ? `${nf(mb / 1024)} GB` : `${nf(mb, mb < 10 ? 1 : 0)} MB`;
}

function formatDuration(seconds) {
    if (seconds < 60) return `${Math.round(seconds)} sec`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
    return `${(seconds / 3600).toFixed(1)} uur`;
}

/** Meldingen onderaan het scherm; vervangt alert() voor niet-blokkerende info. */
function toast(message, type = 'info', options = {}) {
    const host = $('toasts');
    if (!host) return;

    const el = document.createElement('div');
    el.className = `toast ${type}`;

    const text = document.createElement('div');
    text.textContent = message;
    el.appendChild(text);

    if (options.actionLabel && typeof options.onAction === 'function') {
        const btn = document.createElement('button');
        btn.className = 'toast-action';
        btn.textContent = options.actionLabel;
        btn.addEventListener('click', () => {
            options.onAction();
            remove();
        });
        el.appendChild(btn);
    }

    host.appendChild(el);

    let timer = null;
    function remove() {
        if (timer) clearTimeout(timer);
        if (!el.isConnected) return;
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 200);
    }
    timer = setTimeout(remove, options.duration || (type === 'error' ? 7000 : 4000));
    return remove;
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Pas vrijgeven nadat de browser de download heeft opgepikt
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function slugify(value, fallback = 'route') {
    const slug = (value || '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase();
    return slug || fallback;
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/* ============================================================
   Instellingen
   ============================================================ */

/** Houdt onbruikbare waarden (NaN, null, buiten bereik) uit de berekeningen. */
function sanitizeSettings(raw) {
    const clean = { ...DEFAULT_SETTINGS, ...(raw || {}) };

    const level = parseInt(clean.fitnessLevel, 10);
    clean.fitnessLevel = (level >= 1 && level <= 5) ? level : DEFAULT_SETTINGS.fitnessLevel;

    const weight = parseFloat(clean.backpackWeight);
    clean.backpackWeight = (isFinite(weight) && weight >= 0 && weight <= 60) ? weight : DEFAULT_SETTINGS.backpackWeight;

    clean.startDate = typeof clean.startDate === 'string' ? clean.startDate : '';
    return clean;
}

function loadSettings() {
    try {
        const saved = localStorage.getItem('gpxSplitterSettings');
        settings = sanitizeSettings(saved ? JSON.parse(saved) : null);
    } catch (e) {
        console.error('Instellingen konden niet geladen worden:', e);
        settings = { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    try {
        localStorage.setItem('gpxSplitterSettings', JSON.stringify(settings));
    } catch (e) {
        console.error('Instellingen konden niet bewaard worden:', e);
    }
}

/** 0 kg = x1.0, 15 kg = x1.20, 30 kg = x1.40 */
function getBackpackMultiplier() {
    return 1 + (settings.backpackWeight / 75);
}

/* ============================================================
   GPX lezen
   ============================================================ */

/** Tags opzoeken, ook als de GPX met een namespace-prefix werkt (<gpx:trkpt>). */
function findTags(root, tagName) {
    const byNs = root.getElementsByTagNameNS('*', tagName);
    if (byNs.length) return Array.from(byNs);
    return Array.from(root.getElementsByTagName(tagName));
}

function readPoint(node) {
    const lat = parseFloat(node.getAttribute('lat'));
    const lon = parseFloat(node.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) return null;        // kapot punt overslaan

    const eleNode = findTags(node, 'ele')[0];
    const raw = eleNode ? parseFloat(eleNode.textContent) : NaN;

    // Ontbrekende hoogte blijft null en wordt verderop ingevuld; 0 zou een
    // berg van 1500 m naar zeeniveau laten duiken.
    return { lat, lon, ele: isFinite(raw) ? raw : null };
}

/** Gaten in de hoogtedata lineair opvullen zodat de hoogtemeters kloppen. */
function fillElevationGaps(points) {
    const known = points.filter(p => p.ele !== null);
    if (known.length === 0) {
        points.forEach(p => { p.ele = 0; p.noElevation = true; });
        return false;
    }

    let lastKnown = -1;
    for (let i = 0; i < points.length; i++) {
        if (points[i].ele === null) continue;

        if (lastKnown === -1) {
            for (let j = 0; j < i; j++) points[j].ele = points[i].ele;
        } else if (i - lastKnown > 1) {
            const start = points[lastKnown].ele;
            const step = (points[i].ele - start) / (i - lastKnown);
            for (let j = lastKnown + 1; j < i; j++) points[j].ele = start + step * (j - lastKnown);
        }
        lastKnown = i;
    }
    for (let j = lastKnown + 1; j < points.length; j++) points[j].ele = points[lastKnown].ele;

    return known.length === points.length;
}

/** Punten uit een projectbestand of bewaarde sessie opschonen. */
function sanitizePoints(raw) {
    if (!Array.isArray(raw)) return [];

    const points = [];
    for (const p of raw) {
        if (!p) continue;
        const lat = parseFloat(p.lat);
        const lon = parseFloat(p.lon);
        if (!isFinite(lat) || !isFinite(lon)) continue;

        const ele = parseFloat(p.ele);
        points.push({ lat, lon, ele: isFinite(ele) ? ele : null, brk: !!p.brk });
    }
    fillElevationGaps(points);
    return points;
}

/** Enkel punten die een echte etappe opleveren. */
function usableMarkers(list) {
    return (Array.isArray(list) ? list : []).filter(m =>
        m && Number.isInteger(m.pointIndex) && m.pointIndex > 0 && m.pointIndex < gpxData.length - 1);
}

function parseGPX(gpxText) {
    const xmlDoc = new DOMParser().parseFromString(gpxText, 'text/xml');

    if (xmlDoc.getElementsByTagName('parsererror').length) {
        throw new Error('Dit bestand is geen geldige GPX (XML-fout).');
    }

    const points = [];
    let segmentCount = 0;

    // Elk <trkseg> (of <rte>) apart lezen: de sprong tussen twee stukken is
    // geen gewandelde afstand en mag niet meetellen.
    const addSegment = (nodes) => {
        const parsed = nodes.map(readPoint).filter(Boolean);
        if (parsed.length === 0) return;
        if (points.length > 0) parsed[0].brk = true;   // breuk met het vorige stuk
        points.push(...parsed);
        segmentCount++;
    };

    findTags(xmlDoc, 'trkseg').forEach(seg => addSegment(findTags(seg, 'trkpt')));

    if (points.length === 0) {
        // Geen <trkseg>: losse trackpunten of een route (<rte>)
        const loose = findTags(xmlDoc, 'trkpt');
        if (loose.length) addSegment(loose);
        else findTags(xmlDoc, 'rte').forEach(rte => addSegment(findTags(rte, 'rtept')));
        if (points.length === 0) addSegment(findTags(xmlDoc, 'rtept'));
    }

    const hasFullElevation = fillElevationGaps(points);

    // De naam van de track zelf, niet die van een waypoint dat er toevallig voor staat
    const nameHost = findTags(xmlDoc, 'trk')[0] || findTags(xmlDoc, 'rte')[0] || findTags(xmlDoc, 'metadata')[0];
    const nameNode = nameHost ? findTags(nameHost, 'name')[0] : null;
    const name = nameNode ? nameNode.textContent.trim() : '';

    return { points, name, segmentCount, hasFullElevation };
}

/* ============================================================
   Berekeningen
   ============================================================ */

function calculateDistance(p1, p2) {
    const R = 6371;
    const dLat = (p2.lat - p1.lat) * Math.PI / 180;
    const dLon = (p2.lon - p1.lon) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const SMOOTH_WINDOW = 5;
const ELEVATION_THRESHOLD = 0.5;

/** Voortschrijdend gemiddelde over de hoogtes, tegen GPS-ruis. */
function smoothElevations(points) {
    const half = Math.floor(SMOOTH_WINDOW / 2);
    const smoothed = [];

    for (let i = 0; i < points.length; i++) {
        let sum = 0, count = 0;
        for (let j = Math.max(0, i - half); j <= Math.min(points.length - 1, i + half); j++) {
            sum += points[j].ele;
            count++;
        }
        smoothed.push(sum / count);
    }
    return smoothed;
}

/** Zelfde afvlakking, maar per aaneengesloten stuk van de track. */
function smoothedPerRun(points) {
    const out = new Array(points.length);
    let index = 0;

    for (const run of splitRuns(points)) {
        const smoothed = smoothElevations(run);
        for (let i = 0; i < run.length; i++) out[index++] = smoothed[i];
    }
    return out;
}

/** Hoogtemeters met voortschrijdend gemiddelde en drempel tegen GPS-ruis. */
function calculateElevation(points) {
    if (points.length < 2) return { gain: 0, loss: 0 };

    const smoothed = smoothElevations(points);
    const threshold = ELEVATION_THRESHOLD;
    let gain = 0, loss = 0, cumulative = 0;

    for (let i = 1; i < smoothed.length; i++) {
        cumulative += smoothed[i] - smoothed[i - 1];
        if (cumulative > threshold) { gain += cumulative; cumulative = 0; }
        else if (cumulative < -threshold) { loss += Math.abs(cumulative); cumulative = 0; }
    }

    return { gain, loss };
}

/** Punten opdelen op de breuken tussen twee trackdelen. */
function splitRuns(points) {
    const runs = [];
    let current = [];

    for (const point of points) {
        if (point.brk && current.length) { runs.push(current); current = []; }
        current.push(point);
    }
    if (current.length) runs.push(current);
    return runs;
}

function calculateSegmentStats(points) {
    let distance = 0, gain = 0, loss = 0;

    // Per aaneengesloten stuk rekenen: de sprong tussen twee stukken is niet gewandeld
    for (const run of splitRuns(points)) {
        for (let i = 1; i < run.length; i++) distance += calculateDistance(run[i - 1], run[i]);
        const elevation = calculateElevation(run);
        gain += elevation.gain;
        loss += elevation.loss;
    }

    const equivalentKm = (distance + gain / 80 + loss / 150) * getBackpackMultiplier();
    const baseHours = (distance / 4) + (gain / 500) + (loss / 2000);
    const hours = baseHours * (0.9 + (3 - settings.fitnessLevel) * 0.1);

    return { distance, elevationGain: gain, elevationLoss: loss, equivalentKm, hours };
}

const DIFFICULTY_THRESHOLDS = {
    1: { comfortable: 20, moderate: 28, heavy: 35 },
    2: { comfortable: 24, moderate: 32, heavy: 40 },
    3: { comfortable: 30, moderate: 38, heavy: 45 },
    4: { comfortable: 36, moderate: 44, heavy: 52 },
    5: { comfortable: 42, moderate: 52, heavy: 60 }
};

function getDifficulty(equivKm) {
    const t = DIFFICULTY_THRESHOLDS[settings.fitnessLevel] || DIFFICULTY_THRESHOLDS[3];
    if (equivKm < t.comfortable) return { level: 'Comfortabel', varName: '--diff-1' };
    if (equivKm < t.moderate)    return { level: 'Stevig', varName: '--diff-2' };
    if (equivKm < t.heavy)       return { level: 'Zwaar', varName: '--diff-3' };
    return { level: 'Zeer zwaar', varName: '--diff-4' };
}

function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#16a34a';
}

function findClosestPointIndex(latlng) {
    let minDistance = Infinity;
    let closestIndex = 0;
    const probe = { lat: latlng.lat, lon: latlng.lng };

    for (let i = 0; i < gpxData.length; i++) {
        const d = calculateDistance(probe, gpxData[i]);
        if (d < minDistance) { minDistance = d; closestIndex = i; }
    }
    return { index: closestIndex, distance: minDistance };
}

/** Segmenten op basis van de (gesorteerde) splitpunten. */
function getSegments() {
    if (gpxData.length === 0) return [];
    const segments = [];
    let start = 0;

    for (const marker of splitMarkers) {
        segments.push({ start, end: marker.pointIndex, marker });
        start = marker.pointIndex;
    }
    segments.push({ start, end: gpxData.length - 1, marker: null });

    return segments.filter(s => s.end > s.start);
}

/* ---------- Automatisch verdelen ---------- */

/** Opgetelde zwaarte (equivalente km) tot aan elk punt van de route. */
function effortProfile() {
    const smoothed = smoothedPerRun(gpxData);
    const profile = new Array(gpxData.length).fill(0);
    let accumulator = 0;
    let total = 0;

    for (let i = 1; i < gpxData.length; i++) {
        if (gpxData[i].brk) {
            accumulator = 0;                       // sprong tussen twee stukken telt niet mee
        } else {
            total += calculateDistance(gpxData[i - 1], gpxData[i]);
            accumulator += smoothed[i] - smoothed[i - 1];

            if (accumulator > ELEVATION_THRESHOLD) { total += accumulator / 80; accumulator = 0; }
            else if (accumulator < -ELEVATION_THRESHOLD) { total += Math.abs(accumulator) / 150; accumulator = 0; }
        }
        profile[i] = total;
    }
    return profile;
}

/** Verdeelt de route in even zware dagen en zet de splitpunten. */
function autoSplit(dayCount) {
    if (gpxData.length < 2 || dayCount < 2) return;

    const profile = effortProfile();
    const total = profile[profile.length - 1];
    if (total <= 0) { toast('Deze route kan niet verdeeld worden.', 'warn'); return; }

    saveToHistory();
    splitMarkers.forEach(m => map.removeLayer(m));
    splitMarkers = [];

    let searchFrom = 1;
    for (let day = 1; day < dayCount; day++) {
        const target = (total * day) / dayCount;

        let index = searchFrom;
        while (index < gpxData.length - 2 && profile[index] < target) index++;
        searchFrom = index + 1;

        if (index > 0 && index < gpxData.length - 1 && !splitMarkers.some(m => m.pointIndex === index)) {
            createMarker({ pointIndex: index, type: 'split', name: '' });
        }
    }

    afterMarkersChanged();
    toast(`Route verdeeld in ${getSegments().length} dagen.`, 'success');
}

function openAutoSplitModal() {
    if (gpxData.length === 0) return;

    const stats = calculateSegmentStats(gpxData);
    const suggested = Math.max(2, Math.min(20, Math.round(stats.equivalentKm /
        (DIFFICULTY_THRESHOLDS[settings.fitnessLevel] || DIFFICULTY_THRESHOLDS[3]).comfortable)));

    const slider = $('autoSplitDays');
    slider.value = suggested;
    updateAutoSplitPreview();
    openModal('autoSplitModal');
}

function updateAutoSplitPreview() {
    const days = parseInt($('autoSplitDays').value, 10);
    const stats = calculateSegmentStats(gpxData);
    const perDay = stats.equivalentKm / days;
    const difficulty = getDifficulty(perDay);

    $('autoSplitDaysOut').textContent = `${days} dagen`;
    $('autoSplitPreview').textContent =
        `Ongeveer ${nf(stats.distance / days)} km en ${nf(stats.elevationGain / days, 0)} hm per dag ` +
        `· ${nf(perDay)} equivalente km · ${difficulty.level.toLowerCase()}`;
}

/* ============================================================
   Kaart
   ============================================================ */

function initMap() {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: true,
        doubleClickZoom: true
    }).setView([51.0543, 3.7174], 13);

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    tileLayer = new L.TileLayer.Offline('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap',
        maxZoom: 19,
        maxNativeZoom: 19,
        crossOrigin: true
    }).addTo(map);

    map.on('click', onMapClick);

    window.addEventListener('online', onConnectionChange);
    window.addEventListener('offline', onConnectionChange);
}

function pinIcon(type) {
    const cfg = markerTypes[type] || markerTypes.split;
    return L.divIcon({
        className: 'pin-wrapper',
        html: `<div class="route-pin" style="--pin:${cfg.color}"><span>${cfg.icon}</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 34],
        popupAnchor: [0, -32]
    });
}

function drawRoute(fit = true) {
    if (gpxPolyline) { map.removeLayer(gpxPolyline); gpxPolyline = null; }
    if (gpxData.length === 0) return;

    gpxPolyline = L.polyline(gpxData.map(p => [p.lat, p.lon]), {
        color: cssVar('--route'),
        weight: 4,
        opacity: 0.85
    }).addTo(map);

    if (fit) map.fitBounds(gpxPolyline.getBounds(), { padding: [40, 40] });
}

function onMapClick(e) {
    if (!isAddingPoint || gpxData.length === 0) return;

    const { index, distance } = findClosestPointIndex(e.latlng);

    if (distance > 2) {
        toast('Dat punt ligt meer dan 2 km van de route. Klik dichter bij het spoor.', 'warn');
        return;
    }
    addSplitMarkerAt(index, pendingMarkerType);
}

function addSplitMarkerAt(pointIndex, type) {
    if (pointIndex <= 0 || pointIndex >= gpxData.length - 1) {
        toast('Een splitpunt op het begin of einde van de route levert geen etappe op.', 'warn');
        return;
    }
    if (splitMarkers.some(m => m.pointIndex === pointIndex)) {
        toast('Hier staat al een punt.', 'warn');
        return;
    }

    saveToHistory();
    createMarker({ pointIndex, type, name: '' });
    afterMarkersChanged();
}

/** Maakt de Leaflet-marker; verandert de historiek niet. */
function createMarker(data) {
    const point = gpxData[data.pointIndex];
    if (!point) return null;

    const marker = L.marker([point.lat, point.lon], {
        draggable: true,
        icon: pinIcon(data.type),
        autoPan: true
    }).addTo(map);

    marker.pointIndex = data.pointIndex;
    marker.markerType = markerTypes[data.type] ? data.type : 'split';
    marker.markerName = data.name || '';

    marker.on('dragstart', () => saveToHistory());

    marker.on('dragend', () => {
        const { index } = findClosestPointIndex(marker.getLatLng());
        const clash = splitMarkers.some(m => m !== marker && m.pointIndex === index);

        if (clash || index <= 0 || index >= gpxData.length - 1) {
            // Terug naar de oude plek: twee punten op dezelfde plaats geeft lege etappes
            const old = gpxData[marker.pointIndex];
            marker.setLatLng([old.lat, old.lon]);
            toast('Daar kan het punt niet staan.', 'warn');
            markerHistory.pop();
            updateUndoButton();
            return;
        }

        marker.pointIndex = index;
        const snapped = gpxData[index];
        marker.setLatLng([snapped.lat, snapped.lon]);
        afterMarkersChanged();     // hersorteert, anders lopen de etappes door elkaar
    });

    marker.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        openMarkerEditModal(marker);
    });

    splitMarkers.push(marker);
    splitMarkers.sort((a, b) => a.pointIndex - b.pointIndex);
    return marker;
}

function afterMarkersChanged() {
    splitMarkers.sort((a, b) => a.pointIndex - b.pointIndex);
    renderTrackList();
    updateControls();
    updateStatusPill();
    scheduleSessionSave();
}

function deleteMarker(index) {
    const marker = splitMarkers[index];
    if (!marker) return;

    saveToHistory();
    map.removeLayer(marker);
    splitMarkers.splice(index, 1);
    afterMarkersChanged();
}

/* ---------- Historiek ---------- */

function snapshot() {
    return splitMarkers.map(m => ({ pointIndex: m.pointIndex, type: m.markerType, name: m.markerName }));
}

function saveToHistory() {
    markerHistory.push(snapshot());
    if (markerHistory.length > 30) markerHistory.shift();
    updateUndoButton();
}

function updateUndoButton() {
    const disabled = markerHistory.length === 0;
    $('undoBtn').disabled = disabled;
}

function undo() {
    if (markerHistory.length === 0) return;

    const previous = markerHistory.pop();
    splitMarkers.forEach(m => map.removeLayer(m));
    splitMarkers = [];
    previous.forEach(data => createMarker(data));

    updateUndoButton();
    afterMarkersChanged();
}

/* ============================================================
   Paneel met dagetappes
   ============================================================ */

function makeStat(value, label) {
    const stat = document.createElement('div');
    stat.className = 'stat';

    const v = document.createElement('span');
    v.className = 'stat-value';
    v.textContent = value;

    const l = document.createElement('span');
    l.className = 'stat-label';
    l.textContent = label;

    stat.append(v, l);
    return stat;
}

/** Klein hoogteprofiel als SVG. */
function buildProfile(points, color) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'profile');
    svg.setAttribute('viewBox', '0 0 100 30');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');

    if (points.length < 2) return svg;

    const sampleCount = Math.min(80, points.length);
    const step = (points.length - 1) / (sampleCount - 1);
    const elevations = [];
    for (let i = 0; i < sampleCount; i++) elevations.push(points[Math.round(i * step)].ele);

    const min = Math.min(...elevations);
    const max = Math.max(...elevations);
    const range = max - min || 1;

    const coords = elevations.map((ele, i) => {
        const x = (i / (sampleCount - 1)) * 100;
        const y = 28 - ((ele - min) / range) * 26;
        return `${x.toFixed(2)},${y.toFixed(2)}`;
    });

    const area = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    area.setAttribute('points', `0,30 ${coords.join(' ')} 100,30`);
    area.setAttribute('fill', color);
    area.setAttribute('opacity', '0.16');

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', coords.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', '1.4');
    line.setAttribute('vector-effect', 'non-scaling-stroke');

    svg.append(area, line);
    return svg;
}

function dayLabel(index) {
    if (!settings.startDate) return '';
    const date = new Date(settings.startDate + 'T12:00:00');
    if (isNaN(date)) return '';
    date.setDate(date.getDate() + index);
    return date.toLocaleDateString('nl-BE', { weekday: 'short', day: 'numeric', month: 'short' });
}

function renderTrackList() {
    const list = $('trackList');
    list.textContent = '';

    segmentPolylines.forEach(p => map.removeLayer(p));
    segmentPolylines = [];

    if (gpxData.length === 0) {
        list.appendChild(buildEmptyState());
        $('panelCount').textContent = '0';
        updateRouteSummary();
        return;
    }

    const segments = getSegments();
    $('panelCount').textContent = String(segments.length);

    // Zonder splitpunten tonen we de route in één stuk
    if (gpxPolyline) gpxPolyline.setStyle({ opacity: splitMarkers.length === 0 ? 0.85 : 0 });

    const totals = { distance: 0, gain: 0, loss: 0, equiv: 0, hours: 0 };

    segments.forEach((segment, index) => {
        const points = gpxData.slice(segment.start, segment.end + 1);
        const stats = calculateSegmentStats(points);
        const difficulty = getDifficulty(stats.equivalentKm);
        const color = cssVar(difficulty.varName);

        totals.distance += stats.distance;
        totals.gain += stats.elevationGain;
        totals.loss += stats.elevationLoss;
        totals.equiv += stats.equivalentKm;
        totals.hours += stats.hours;

        const poly = L.polyline(points.map(p => [p.lat, p.lon]), {
            color, weight: 5, opacity: 0.85
        }).addTo(map);
        segmentPolylines.push(poly);

        const card = document.createElement('article');
        card.className = 'day-card';
        card.style.setProperty('--c', color);

        /* Kop */
        const head = document.createElement('header');
        head.className = 'day-head';

        const name = document.createElement('span');
        name.className = 'day-name';
        name.textContent = splitMarkers.length === 0 ? 'Volledige route' : `Dag ${index + 1}`;
        head.appendChild(name);

        const dateText = splitMarkers.length === 0 ? '' : dayLabel(index);
        if (dateText) {
            const date = document.createElement('span');
            date.className = 'day-date';
            date.textContent = dateText;
            head.appendChild(date);
        }

        const chip = document.createElement('span');
        chip.className = 'diff-chip';
        chip.textContent = difficulty.level;
        head.appendChild(chip);
        card.appendChild(head);

        /* Eindpunt van de etappe */
        if (segment.marker) {
            const cfg = markerTypes[segment.marker.markerType];
            const end = document.createElement('div');
            end.className = 'day-end';

            const icon = document.createElement('span');
            icon.className = 'end-icon';
            icon.textContent = cfg.icon;

            const label = document.createElement('span');
            label.textContent = segment.marker.markerName || cfg.name;

            end.append(icon, label);
            card.appendChild(end);
        }

        /* Cijfers */
        const grid = document.createElement('div');
        grid.className = 'stat-grid';
        grid.append(
            makeStat(`${nf(stats.distance)} km`, 'afstand'),
            makeStat(`${nf(stats.elevationGain, 0)} m`, 'stijging'),
            makeStat(`${nf(stats.elevationLoss, 0)} m`, 'daling'),
            makeStat(formatHours(stats.hours), 'stappen')
        );
        card.appendChild(grid);
        card.appendChild(buildProfile(points, color));

        /* Knoppen */
        const actions = document.createElement('div');
        actions.className = 'day-actions';

        const zoomBtn = document.createElement('button');
        zoomBtn.className = 'btn';
        zoomBtn.textContent = 'Inzoomen';
        zoomBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            map.fitBounds(poly.getBounds(), { padding: [50, 50] });
        });

        const gpxBtn = document.createElement('button');
        gpxBtn.className = 'btn';
        gpxBtn.textContent = 'GPX';
        gpxBtn.title = 'Deze etappe als GPX bewaren';
        gpxBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            exportSegment(index, segment);
        });

        actions.append(zoomBtn, gpxBtn);

        if (segment.marker) {
            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-danger-ghost';
            delBtn.textContent = 'Punt weg';
            delBtn.title = 'Het punt dat deze etappe afsluit verwijderen';
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteMarker(splitMarkers.indexOf(segment.marker));
            });
            actions.appendChild(delBtn);
        }
        card.appendChild(actions);

        /* Interactie met de kaart */
        card.addEventListener('mouseenter', () => poly.setStyle({ weight: 8, opacity: 1 }));
        card.addEventListener('mouseleave', () => poly.setStyle({ weight: 5, opacity: 0.85 }));
        card.addEventListener('click', () => map.fitBounds(poly.getBounds(), { padding: [50, 50] }));

        list.appendChild(card);
    });

    if (segments.length > 1) {
        const total = document.createElement('article');
        total.className = 'day-card total';

        const head = document.createElement('header');
        head.className = 'day-head';
        const name = document.createElement('span');
        name.className = 'day-name';
        name.textContent = 'Totaal';
        head.appendChild(name);

        const chip = document.createElement('span');
        chip.className = 'diff-chip';
        chip.textContent = `${segments.length} dagen`;
        head.appendChild(chip);
        total.appendChild(head);

        const grid = document.createElement('div');
        grid.className = 'stat-grid';
        grid.append(
            makeStat(`${nf(totals.distance)} km`, 'afstand'),
            makeStat(`${nf(totals.gain, 0)} m`, 'stijging'),
            makeStat(`${nf(totals.loss, 0)} m`, 'daling'),
            makeStat(formatHours(totals.hours), 'stappen')
        );
        total.appendChild(grid);
        list.appendChild(total);
    }

    updateRouteSummary(totals, segments.length);
}

function buildEmptyState() {
    const wrap = document.createElement('div');
    wrap.className = 'empty-state';
    wrap.innerHTML = `
        <span class="empty-icon" aria-hidden="true">\u{1F97E}</span>
        <p class="empty-title">Nog geen route</p>
        <p class="empty-text">Open een GPX-bestand of een eerder bewaard project om te beginnen.</p>`;

    const openBtn = document.createElement('button');
    openBtn.className = 'btn btn-primary';
    openBtn.textContent = 'Route openen';
    openBtn.addEventListener('click', () => $('gpxFileInput').click());

    const loadBtn = document.createElement('button');
    loadBtn.className = 'btn btn-quiet';
    loadBtn.textContent = 'Project laden';
    loadBtn.addEventListener('click', () => $('projectFileInput').click());

    wrap.append(openBtn, loadBtn);
    return wrap;
}

function updateRouteSummary(totals, dayCount) {
    const el = $('routeSummary');
    if (gpxData.length === 0) {
        el.textContent = 'Geen route geladen';
        return;
    }
    const parts = [];
    if (trackName) parts.push(trackName);
    if (totals) {
        parts.push(`${nf(totals.distance)} km`);
        parts.push(`${nf(totals.gain, 0)} hm`);
        if (dayCount > 1) parts.push(`${dayCount} dagen`);
    }
    el.textContent = parts.join(' · ');
}

function updateControls() {
    const hasRoute = gpxData.length > 0;
    ['addPointBtn', 'fitRouteBtn', 'clearBtn', 'saveProjectBtn', 'exportGpxBtn', 'autoSplitBtn',
     'menuSaveProject', 'menuExportGpx', 'menuAutoSplit', 'menuClear', 'routeBufferBtn'].forEach(id => {
        const el = $(id);
        if (el) el.disabled = !hasRoute;
    });
    updateUndoButton();
}

/* ============================================================
   Route laden, wissen, bewaren
   ============================================================ */

/** Zet alles terug naar leeg. Vraagt niets - de aanroeper beslist. */
function resetAll() {
    setAddMode(false);
    clearPendingArea();

    if (gpxPolyline) { map.removeLayer(gpxPolyline); gpxPolyline = null; }
    segmentPolylines.forEach(p => map.removeLayer(p));
    segmentPolylines = [];
    splitMarkers.forEach(m => map.removeLayer(m));
    splitMarkers = [];

    gpxData = [];
    trackName = '';
    markerHistory = [];

    renderTrackList();
    updateControls();
    updateStatusPill();
}

function clearAllWithConfirm() {
    if (gpxData.length === 0 && splitMarkers.length === 0) return;
    if (!confirm('Alles wissen? De geladen route en alle punten verdwijnen.')) return;

    resetAll();
    clearSession();
    toast('Alles gewist.');
}

function loadGpxText(text, fileName) {
    let parsed;
    try {
        parsed = parseGPX(text);
    } catch (error) {
        toast(error.message, 'error');
        return;
    }

    if (parsed.points.length === 0) {
        toast('Geen trackpunten gevonden in dit GPX-bestand.', 'error');
        return;
    }

    resetAll();
    gpxData = parsed.points;
    trackName = parsed.name || (fileName || '').replace(/\.gpx$/i, '');

    drawRoute(true);
    renderTrackList();
    updateControls();
    scheduleSessionSave();

    toast(`${trackName || 'Route'} geladen · ${gpxData.length} punten`, 'success');

    if (parsed.segmentCount > 1) {
        toast(`Deze GPX bestaat uit ${parsed.segmentCount} losse stukken. De sprongen ertussen tellen niet mee als afstand.`, 'info', { duration: 8000 });
    }
    if (!parsed.hasFullElevation) {
        toast('Niet elk punt heeft een hoogte; de ontbrekende waarden zijn ingevuld tussen de gekende punten.', 'warn', { duration: 8000 });
    }
}

function saveProject() {
    if (gpxData.length === 0) return;

    const project = {
        version: '3.0',
        name: trackName,
        settings: { startDate: settings.startDate },
        gpxData,
        markers: snapshot(),
        savedAt: new Date().toISOString()
    };

    downloadBlob(
        new Blob([JSON.stringify(project)], { type: 'application/json' }),
        `${slugify(trackName, 'gpx-project')}-${new Date().toISOString().slice(0, 10)}.json`
    );
    toast('Project bewaard.', 'success');
}

function loadProject(jsonText) {
    let project;
    try {
        project = JSON.parse(jsonText);
    } catch (e) {
        toast('Dit projectbestand kan niet gelezen worden.', 'error');
        return;
    }

    if (!project || !Array.isArray(project.gpxData) || project.gpxData.length === 0) {
        toast('Dit projectbestand bevat geen route.', 'error');
        return;
    }

    const points = sanitizePoints(project.gpxData);
    if (points.length === 0) {
        toast('Dit projectbestand bevat geen bruikbare punten.', 'error');
        return;
    }

    resetAll();
    gpxData = points;
    trackName = project.name || '';
    if (project.settings && project.settings.startDate) {
        settings.startDate = project.settings.startDate;
        saveSettings();
    }

    drawRoute(true);

    const markers = Array.isArray(project.markers)
        ? project.markers
        : (Array.isArray(project.markerIndices) ? project.markerIndices.map(i => ({ pointIndex: i, type: 'split' })) : []);

    usableMarkers(markers).forEach(m => createMarker(m));

    markerHistory = [];
    afterMarkersChanged();
    toast('Project geladen.', 'success');
}

/* ============================================================
   Exporteren naar GPX
   ============================================================ */

function buildGpx(tracks, waypoints = []) {
    const now = new Date().toISOString();
    const lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<gpx version="1.1" creator="GPX Track Splitter" xmlns="http://www.topografix.com/GPX/1/1">',
        `  <metadata><time>${now}</time></metadata>`
    ];

    for (const wpt of waypoints) {
        lines.push(`  <wpt lat="${wpt.lat.toFixed(6)}" lon="${wpt.lon.toFixed(6)}">`);
        if (Number.isFinite(wpt.ele)) lines.push(`    <ele>${wpt.ele.toFixed(1)}</ele>`);
        lines.push(`    <name>${escapeXml(wpt.name)}</name>`);
        if (wpt.symbol) lines.push(`    <sym>${escapeXml(wpt.symbol)}</sym>`);
        lines.push('  </wpt>');
    }

    for (const track of tracks) {
        lines.push('  <trk>');
        lines.push(`    <name>${escapeXml(track.name)}</name>`);

        // Elk aaneengesloten stuk krijgt een eigen <trkseg>; anders trekt een
        // kaartapp een rechte lijn over de sprong ertussen
        for (const run of splitRuns(track.points)) {
            lines.push('    <trkseg>');
            for (const p of run) {
                const ele = Number.isFinite(p.ele) ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
                lines.push(`      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${ele}</trkpt>`);
            }
            lines.push('    </trkseg>');
        }
        lines.push('  </trk>');
    }

    lines.push('</gpx>');
    return lines.join('\n');
}

function segmentTitle(index, segment, total) {
    const base = trackName ? `${trackName} - ` : '';
    const suffix = segment && segment.marker && segment.marker.markerName ? ` (${segment.marker.markerName})` : '';
    return total > 1 ? `${base}dag ${index + 1}${suffix}` : `${base}route`;
}

function exportSegment(index, segment) {
    const segments = getSegments();
    const points = gpxData.slice(segment.start, segment.end + 1);
    const name = segmentTitle(index, segment, segments.length);

    downloadBlob(
        new Blob([buildGpx([{ name, points }])], { type: 'application/gpx+xml' }),
        `${slugify(name, 'etappe')}.gpx`
    );
    toast(`${name} bewaard.`, 'success');
}

function waypointList() {
    return splitMarkers.map(m => {
        const cfg = markerTypes[m.markerType];
        const point = gpxData[m.pointIndex];
        return {
            lat: point.lat, lon: point.lon, ele: point.ele,
            name: m.markerName || cfg.name,
            symbol: cfg.name
        };
    });
}

function exportAllSeparate() {
    const segments = getSegments();
    segments.forEach((segment, index) => {
        // Browsers blokkeren een reeks downloads die te snel na elkaar komt
        setTimeout(() => exportSegment(index, segment), index * 400);
    });
}

function exportCombined() {
    const segments = getSegments();
    const tracks = segments.map((segment, index) => ({
        name: segmentTitle(index, segment, segments.length),
        points: gpxData.slice(segment.start, segment.end + 1)
    }));

    downloadBlob(
        new Blob([buildGpx(tracks, waypointList())], { type: 'application/gpx+xml' }),
        `${slugify(trackName, 'route')}-dagetappes.gpx`
    );
    toast('Alle etappes in één bestand bewaard.', 'success');
}

function exportWaypoints() {
    if (splitMarkers.length === 0) {
        toast('Er zijn nog geen punten om te exporteren.', 'warn');
        return;
    }
    downloadBlob(
        new Blob([buildGpx([], waypointList())], { type: 'application/gpx+xml' }),
        `${slugify(trackName, 'route')}-punten.gpx`
    );
    toast('Punten bewaard.', 'success');
}

function openExportModal() {
    const host = $('exportChoices');
    host.textContent = '';

    const segments = getSegments();
    const options = [
        { label: `Elke dag apart (${segments.length} bestanden)`, action: exportAllSeparate },
        { label: 'Alles in één GPX (met punten)', action: exportCombined },
        { label: 'Enkel de punten als waypoints', action: exportWaypoints }
    ];

    options.forEach(option => {
        const btn = document.createElement('button');
        btn.className = 'btn';
        btn.textContent = option.label;
        btn.addEventListener('click', () => { option.action(); closeModal('exportModal'); });
        host.appendChild(btn);
    });

    openModal('exportModal');
}

/* ============================================================
   GPS
   ============================================================ */

let watchId = null;
let userMarker = null;
let accuracyCircle = null;
let followMode = false;
let lastPosition = null;

function startLocationTracking() {
    if (!navigator.geolocation) {
        toast('Deze browser kent geen GPS-locatie.', 'error');
        return false;
    }

    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 20000
    });
    return true;
}

function onPosition(position) {
    const { latitude: lat, longitude: lon, accuracy } = position.coords;
    lastPosition = { lat, lon, accuracy };

    if (!userMarker) {
        userMarker = L.marker([lat, lon], {
            icon: L.divIcon({
                className: 'user-location-marker',
                html: '<div class="pulse"></div><div class="dot"></div>',
                iconSize: [26, 26],
                iconAnchor: [13, 13]
            }),
            zIndexOffset: 1000,
            interactive: false
        }).addTo(map);

        accuracyCircle = L.circle([lat, lon], {
            radius: accuracy,
            color: '#2563eb', weight: 1, fillOpacity: 0.08, interactive: false
        }).addTo(map);

        map.setView([lat, lon], Math.max(map.getZoom(), 15));
    } else {
        userMarker.setLatLng([lat, lon]);
        accuracyCircle.setLatLng([lat, lon]).setRadius(accuracy);
        if (followMode) map.panTo([lat, lon], { animate: true });
    }

    updateStatusPill();
}

function onPositionError(error) {
    const messages = {
        1: 'Geen toegang tot je locatie. Sta GPS toe in de browserinstellingen.',
        2: 'Je locatie is nu niet te bepalen (geen signaal?).',
        3: 'Het duurde te lang om je locatie te bepalen.'
    };
    toast(messages[error.code] || 'GPS-fout.', 'error');

    // Bij een geweigerde toestemming heeft verder zoeken geen zin
    if (error.code === 1) stopLocationTracking();
    updateStatusPill();
}

function stopLocationTracking() {
    if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
    if (userMarker) { map.removeLayer(userMarker); userMarker = null; }
    if (accuracyCircle) { map.removeLayer(accuracyCircle); accuracyCircle = null; }

    lastPosition = null;
    followMode = false;

    $('locationBtn').setAttribute('aria-pressed', 'false');
    $('followBtn').hidden = true;
    $('followBtn').setAttribute('aria-pressed', 'false');
    updateStatusPill();
}

function toggleLocationTracking() {
    if (watchId !== null) {
        stopLocationTracking();
        return;
    }
    if (startLocationTracking()) {
        $('locationBtn').setAttribute('aria-pressed', 'true');
        $('followBtn').hidden = false;
        toast('GPS wordt gezocht…');
        updateStatusPill();
    }
}

function toggleFollow() {
    followMode = !followMode;
    $('followBtn').setAttribute('aria-pressed', String(followMode));
    if (followMode && lastPosition) map.panTo([lastPosition.lat, lastPosition.lon]);
}

/** Afstand langs de route tot het eerstvolgende splitpunt. */
function distanceToNextPoint() {
    if (!lastPosition || gpxData.length === 0 || splitMarkers.length === 0) return null;

    const { index } = findClosestPointIndex({ lat: lastPosition.lat, lng: lastPosition.lon });
    const next = splitMarkers.find(m => m.pointIndex > index);
    if (!next) return null;

    let distance = 0;
    for (let i = index + 1; i <= next.pointIndex; i++) {
        distance += calculateDistance(gpxData[i - 1], gpxData[i]);
    }

    const cfg = markerTypes[next.markerType];
    return { distance, label: next.markerName || cfg.name, icon: cfg.icon };
}

function updateStatusPill() {
    const pill = $('statusPill');
    const parts = [];
    const offline = !navigator.onLine;

    if (offline) parts.push('Offline');
    if (lastPosition) parts.push(`GPS ±${Math.round(lastPosition.accuracy)} m`);

    const next = distanceToNextPoint();
    if (next) parts.push(`${next.icon} nog ${nf(next.distance)} km`);

    if (parts.length === 0) {
        pill.hidden = true;
        return;
    }

    pill.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'dot-live';
    pill.appendChild(dot);
    pill.appendChild(document.createTextNode(parts.join('  ·  ')));
    pill.classList.toggle('offline', offline);
    pill.hidden = false;
}

function onConnectionChange() {
    applyOfflineZoomLimit();
    updateStatusPill();
    toast(navigator.onLine ? 'Weer online.' : 'Offline – enkel opgeslagen kaartgebieden zijn zichtbaar.',
          navigator.onLine ? 'success' : 'warn');
}

/* ============================================================
   Opslag (IndexedDB): tegels, gebieden en de lopende sessie
   ============================================================ */

const DB_NAME = 'gpx-offline-maps';
const DB_VERSION = 2;
const STORE_TILES = 'tiles';
const STORE_AREAS = 'areas';
const STORE_SESSION = 'session';

let db = null;

function initOfflineDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('De database is nog in gebruik in een ander venster.'));
        request.onsuccess = () => { db = request.result; resolve(db); };

        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_TILES)) database.createObjectStore(STORE_TILES, { keyPath: 'key' });
            if (!database.objectStoreNames.contains(STORE_AREAS)) database.createObjectStore(STORE_AREAS, { keyPath: 'id', autoIncrement: true });
            if (!database.objectStoreNames.contains(STORE_SESSION)) database.createObjectStore(STORE_SESSION, { keyPath: 'id' });
        };
    });
}

function idbRequest(storeName, mode, work) {
    return new Promise((resolve, reject) => {
        if (!db) { reject(new Error('Database niet beschikbaar')); return; }
        let request;
        try {
            const transaction = db.transaction([storeName], mode);
            request = work(transaction.objectStore(storeName));
        } catch (error) {
            reject(error);
            return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

const tileKey = (z, x, y) => `${z}/${x}/${y}`;

function saveTile(key, blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            idbRequest(STORE_TILES, 'readwrite', store =>
                store.put({ key, data: reader.result, timestamp: Date.now() })
            ).then(resolve, reject);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
    });
}

async function getTile(key) {
    const result = await idbRequest(STORE_TILES, 'readonly', store => store.get(key));
    return result && result.data ? result.data : null;
}

async function hasTile(key) {
    const count = await idbRequest(STORE_TILES, 'readonly', store => store.count(key));
    return count > 0;
}

const saveArea = (area) => idbRequest(STORE_AREAS, 'readwrite', store => store.add(area));
const getAllAreas = () => idbRequest(STORE_AREAS, 'readonly', store => store.getAll()).then(r => r || []);

/** Verwijdert een gebied, maar laat tegels staan die een ander gebied ook gebruikt. */
async function deleteArea(areaId) {
    const areas = await getAllAreas();
    const target = areas.find(a => a.id === areaId);
    if (!target) return 0;

    const keep = new Set();
    areas.filter(a => a.id !== areaId)
         .forEach(a => (a.tileKeys || []).forEach(k => keep.add(k)));

    const removable = (target.tileKeys || []).filter(k => !keep.has(k));

    await new Promise((resolve, reject) => {
        const transaction = db.transaction([STORE_TILES, STORE_AREAS], 'readwrite');
        const tiles = transaction.objectStore(STORE_TILES);
        transaction.objectStore(STORE_AREAS).delete(areaId);
        removable.forEach(key => tiles.delete(key));
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
    });

    return removable.length;
}

/* ---------- Sessie bewaren ---------- */

let sessionTimer = null;

function scheduleSessionSave() {
    if (sessionTimer) clearTimeout(sessionTimer);
    sessionTimer = setTimeout(saveSession, 800);
}

async function saveSession() {
    if (!db) return;
    try {
        if (gpxData.length === 0) { await clearSession(); return; }
        await idbRequest(STORE_SESSION, 'readwrite', store => store.put({
            id: 'current',
            name: trackName,
            gpxData,
            markers: snapshot(),
            savedAt: Date.now()
        }));
    } catch (error) {
        console.warn('Sessie kon niet bewaard worden:', error);
    }
}

async function clearSession() {
    if (!db) return;
    try {
        await idbRequest(STORE_SESSION, 'readwrite', store => store.delete('current'));
    } catch (error) {
        console.warn('Sessie kon niet gewist worden:', error);
    }
}

async function restoreSession() {
    if (!db) return;
    try {
        const session = await idbRequest(STORE_SESSION, 'readonly', store => store.get('current'));
        if (!session || !Array.isArray(session.gpxData) || session.gpxData.length === 0) return;

        gpxData = sanitizePoints(session.gpxData);
        if (gpxData.length === 0) { await clearSession(); return; }

        trackName = session.name || '';
        drawRoute(true);
        usableMarkers(session.markers).forEach(m => createMarker(m));
        markerHistory = [];
        renderTrackList();
        updateControls();

        toast('Je vorige route is hersteld.', 'info', {
            actionLabel: 'Wissen',
            onAction: () => { resetAll(); clearSession(); }
        });
    } catch (error) {
        console.warn('Sessie kon niet hersteld worden:', error);
    }
}

/* ============================================================
   Offline tegels
   ============================================================ */

L.TileLayer.Offline = L.TileLayer.extend({
    createTile: function (coords, done) {
        const tile = document.createElement('img');
        tile.alt = '';
        tile.setAttribute('role', 'presentation');

        const url = this.getTileUrl(coords);
        const key = tileKey(coords.z, coords.x, coords.y);

        const loadFromNetwork = () => {
            tile.onload = () => done(null, tile);
            tile.onerror = () => done(new Error('Tegel niet beschikbaar'), tile);
            if (this.options.crossOrigin || this.options.crossOrigin === '') {
                tile.crossOrigin = this.options.crossOrigin === true ? '' : this.options.crossOrigin;
            }
            tile.src = url;
        };

        getTile(key).then(data => {
            if (!data) { loadFromNetwork(); return; }
            tile.onload = () => done(null, tile);
            tile.onerror = () => loadFromNetwork();   // beschadigde opslag: toch nog proberen
            tile.src = data;
        }).catch(loadFromNetwork);

        return tile;
    }
});

let maxStoredZoom = 0;

/** Offline knippen we de zoom af op wat er effectief bewaard is, online niet. */
function applyOfflineZoomLimit() {
    if (!tileLayer) return;
    const limit = (!navigator.onLine && maxStoredZoom > 0) ? maxStoredZoom : 19;
    if (tileLayer.options.maxNativeZoom === limit) return;

    tileLayer.options.maxNativeZoom = limit;
    map.fire('viewreset');
}

async function refreshStoredZoom() {
    try {
        const areas = await getAllAreas();
        maxStoredZoom = areas.length ? Math.max(...areas.map(a => a.maxZoom || 0)) : 0;
        applyOfflineZoomLimit();
        drawStoredAreas(areas);
    } catch (error) {
        console.warn('Opgeslagen gebieden konden niet gelezen worden:', error);
    }
}

/* ---------- Gebieden op de kaart tonen ---------- */

let storedAreaLayer = null;

function drawStoredAreas(areas) {
    if (storedAreaLayer) { map.removeLayer(storedAreaLayer); storedAreaLayer = null; }
    if (!areas || areas.length === 0) return;

    const shapes = areas
        .filter(area => Array.isArray(area.outline) && area.outline.length >= 3)
        .map(area => L.polygon(area.outline, {
            color: '#0f766e', weight: 1.5, dashArray: '5 4',
            fillOpacity: 0.04, interactive: false
        }));

    if (shapes.length) storedAreaLayer = L.layerGroup(shapes).addTo(map);
}

/* ============================================================
   Tegels berekenen
   ============================================================ */

function latLngToTile(lat, lng, zoom) {
    const n = Math.pow(2, zoom);
    const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
    const x = Math.floor(((lng + 180) / 360) * n);
    const y = Math.floor(
        (1 - Math.log(Math.tan(clampedLat * Math.PI / 180) + 1 / Math.cos(clampedLat * Math.PI / 180)) / Math.PI) / 2 * n
    );
    return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

function tileToLatLng(x, y, zoom) {
    const n = Math.pow(2, zoom);
    const lng = (x / n) * 360 - 180;
    const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / n)));
    return { lat: latRad * 180 / Math.PI, lng };
}

function pointInPolygon(point, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].lng, yi = polygon[i].lat;
        const xj = polygon[j].lng, yj = polygon[j].lat;
        const intersect = ((yi > point.lat) !== (yj > point.lat)) &&
            (point.lng < (xj - xi) * (point.lat - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
}

function segmentsCross(a, b, c, d) {
    const dir = (p, q, r) => (q.lng - p.lng) * (r.lat - p.lat) - (q.lat - p.lat) * (r.lng - p.lng);
    const d1 = dir(c, d, a), d2 = dir(c, d, b), d3 = dir(a, b, c), d4 = dir(a, b, d);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** Overlapt het tegelvakje met de getekende veelhoek? */
function tileOverlapsPolygon(west, south, east, north, polygon) {
    const corners = [
        { lat: north, lng: west }, { lat: north, lng: east },
        { lat: south, lng: east }, { lat: south, lng: west }
    ];

    if (corners.some(c => pointInPolygon(c, polygon))) return true;
    if (polygon.some(p => p.lat >= south && p.lat <= north && p.lng >= west && p.lng <= east)) return true;

    for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        for (let c = 0; c < 4; c++) {
            if (segmentsCross(a, b, corners[c], corners[(c + 1) % 4])) return true;
        }
    }
    return false;
}

/** Tegels binnen de veelhoek (niet binnen de hele omhullende rechthoek). */
function tilesForPolygon(polygon, minZoom, maxZoom) {
    const keys = [];
    const lats = polygon.map(p => p.lat);
    const lngs = polygon.map(p => p.lng);
    const bounds = {
        north: Math.max(...lats), south: Math.min(...lats),
        east: Math.max(...lngs), west: Math.min(...lngs)
    };

    // Eerst goedkoop tellen: anders loopt de browser vast op een gebied van een
    // land groot voor we kunnen zeggen dat het te groot is
    let scan = 0;
    for (let z = minZoom; z <= maxZoom; z++) {
        const nw = latLngToTile(bounds.north, bounds.west, z);
        const se = latLngToTile(bounds.south, bounds.east, z);
        scan += (Math.abs(se.x - nw.x) + 1) * (Math.abs(se.y - nw.y) + 1);
    }
    if (scan > SCAN_MAX) return null;

    for (let z = minZoom; z <= maxZoom; z++) {
        const nw = latLngToTile(bounds.north, bounds.west, z);
        const se = latLngToTile(bounds.south, bounds.east, z);

        for (let x = Math.min(nw.x, se.x); x <= Math.max(nw.x, se.x); x++) {
            for (let y = Math.min(nw.y, se.y); y <= Math.max(nw.y, se.y); y++) {
                const topLeft = tileToLatLng(x, y, z);
                const bottomRight = tileToLatLng(x + 1, y + 1, z);
                if (tileOverlapsPolygon(topLeft.lng, bottomRight.lat, bottomRight.lng, topLeft.lat, polygon)) {
                    keys.push({ z, x, y });
                }
            }
        }
    }
    return keys;
}

/** Breedte van één tegel in meter, op de breedtegraad van de route. */
function tileWidthMeters(zoom, lat) {
    return 40075016.686 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
}

/**
 * Tegels in een strook rond de route: alle tegels die de route raakt plus een
 * rand van ongeveer `bufferMeters` breed, zodat je niet meteen van de kaart
 * valt als je naast het spoor loopt.
 */
function tilesForRoute(points, minZoom, maxZoom, bufferMeters = 1200) {
    const keys = [];
    const midLat = points.length ? points[Math.floor(points.length / 2)].lat : 0;

    for (let z = minZoom; z <= maxZoom; z++) {
        const n = Math.pow(2, z);
        const margin = Math.max(1, Math.min(4, Math.round(bufferMeters / tileWidthMeters(z, midLat))));
        const base = new Set();

        for (const p of points) {
            const t = latLngToTile(p.lat, p.lon, z);
            base.add(`${t.x}/${t.y}`);
        }

        const expanded = new Set();
        for (const entry of base) {
            const [x, y] = entry.split('/').map(Number);
            for (let dx = -margin; dx <= margin; dx++) {
                for (let dy = -margin; dy <= margin; dy++) {
                    const nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
                    expanded.add(`${nx}/${ny}`);
                }
            }
        }

        for (const entry of expanded) {
            const [x, y] = entry.split('/').map(Number);
            keys.push({ z, x, y });
        }
    }
    return keys;
}

/* ============================================================
   Offline gebied kiezen en downloaden
   ============================================================ */

// Een OSM-tegel is ~15 kB, maar wordt als base64 bewaard: ongeveer een derde meer
const TILE_SIZE_KB = 20;
const SCAN_MAX = 150000;     // zoveel tegels onderzoeken we hoogstens voor een schatting
const TILE_WARN = 4000;
const TILE_MAX = 25000;

let pendingTiles = [];        // [{z,x,y}]
let pendingOutline = null;    // veelhoek voor op de kaart
let pendingLabel = '';
let drawing = { active: false, points: [], polygon: null, handles: [] };
let downloadAbort = false;
let downloadBusy = false;

function openOfflineMapModal() {
    openModal('offlineMapModal');
    loadStorageInfo();
    updateEstimate();
}

function closeOfflineMapModal() {
    closeModal('offlineMapModal');
    clearPendingArea();     // ruimt ook de getekende veelhoek en de hoekpunten op
}

function switchTab(tabName) {
    $$('.tab-btn').forEach(btn => {
        const active = btn.dataset.tab === tabName;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
    });
    $$('.tab-content').forEach(content => content.classList.toggle('active', content.id === tabName + 'Tab'));
    if (tabName === 'manage') loadStorageInfo();
}

/* ---------- Veelhoek tekenen (werkt met muis én touch) ---------- */

function selectArea() {
    clearPendingArea();         // oude tekening en oude schatting weg
    setAddMode(false);          // anders plaatst dezelfde klik ook een splitpunt
    closeModal('offlineMapModal');

    drawing.active = true;
    drawing.points = [];
    map.getContainer().classList.add('map-drawing');
    map.doubleClickZoom.disable();           // anders zoomt de kaart bij het afsluiten
    $('drawBar').hidden = false;

    map.on('click', addPolygonPoint);
    map.on('dblclick', finishPolygon);
}

function addPolygonPoint(e) {
    if (!drawing.active) return;
    drawing.points.push(e.latlng);
    redrawDrawing();
}

function redrawDrawing() {
    if (drawing.polygon) { map.removeLayer(drawing.polygon); drawing.polygon = null; }
    drawing.handles.forEach(h => map.removeLayer(h));
    drawing.handles = [];

    if (drawing.points.length >= 2) {
        drawing.polygon = L.polygon(drawing.points, {
            color: cssVar('--accent'), weight: 2, fillOpacity: 0.08
        }).addTo(map);
    }

    drawing.points.forEach((latlng, index) => {
        // L.marker in plaats van circleMarker: die kan Leaflet zelf verslepen, ook op touch
        const handle = L.marker(latlng, {
            draggable: true,
            icon: L.divIcon({ className: 'vertex-handle', iconSize: [22, 22] }),
            keyboard: false
        }).addTo(map);

        handle.on('drag', () => {
            drawing.points[index] = handle.getLatLng();
            if (drawing.polygon) drawing.polygon.setLatLngs(drawing.points);
        });
        handle.on('dragend', () => { if (!drawing.active) updateAreaFromPolygon(); });

        drawing.handles.push(handle);
    });
}

function finishPolygon() {
    if (!drawing.active) return;

    if (drawing.points.length < 3) {
        toast('Een gebied heeft minstens drie hoekpunten nodig.', 'warn');
        return;
    }

    drawing.active = false;
    map.off('click', addPolygonPoint);
    map.off('dblclick', finishPolygon);
    map.getContainer().classList.remove('map-drawing');
    map.doubleClickZoom.enable();

    $('drawBar').hidden = true;

    updateAreaFromPolygon();
    openModal('offlineMapModal');
}

function updateAreaFromPolygon() {
    pendingOutline = drawing.points.map(p => [p.lat, p.lng]);
    pendingLabel = 'Getekend gebied';
    updateEstimate();
}

function cancelDrawing() {
    drawing.active = false;
    map.off('click', addPolygonPoint);
    map.off('dblclick', finishPolygon);
    map.getContainer().classList.remove('map-drawing');
    if (map.doubleClickZoom) map.doubleClickZoom.enable();

    $('drawBar').hidden = true;
    if (drawing.polygon) { map.removeLayer(drawing.polygon); drawing.polygon = null; }
    drawing.handles.forEach(h => map.removeLayer(h));
    drawing.handles = [];
    drawing.points = [];
}

function clearPendingArea() {
    cancelDrawing();
    pendingTiles = [];
    pendingOutline = null;
    pendingLabel = '';
    $('downloadEstimate').hidden = true;
    $('startDownloadBtn').disabled = true;
}

/* ---------- Schatting ---------- */

function useRouteBuffer() {
    if (gpxData.length === 0) return;
    cancelDrawing();
    pendingOutline = null;
    pendingLabel = trackName ? `Strook rond ${trackName}` : 'Strook rond de route';
    updateEstimate();
}

function currentTiles() {
    const minZoom = parseInt($('minZoom').value, 10);
    const maxZoom = parseInt($('maxZoom').value, 10);

    if (pendingOutline && pendingOutline.length >= 3) {
        const polygon = pendingOutline.map(([lat, lng]) => ({ lat, lng }));
        return tilesForPolygon(polygon, minZoom, maxZoom);
    }
    if (pendingLabel && gpxData.length) {
        return tilesForRoute(gpxData, minZoom, maxZoom);
    }
    return [];
}

function updateZoomLabels() {
    const minInput = $('minZoom');
    const maxInput = $('maxZoom');

    if (parseInt(minInput.value, 10) > parseInt(maxInput.value, 10)) {
        maxInput.value = minInput.value;
    }
    $('minZoomDisplay').textContent = `${minInput.value} · ${zoomCaption(+minInput.value)}`;
    $('maxZoomDisplay').textContent = `${maxInput.value} · ${zoomCaption(+maxInput.value)}`;
}

let estimateTimer = null;

/** Schuiven mag niet bij elke tussenstap de volledige tegelberekening doen. */
function scheduleEstimate() {
    updateZoomLabels();
    if (estimateTimer) clearTimeout(estimateTimer);
    estimateTimer = setTimeout(updateEstimate, 180);
}

function updateEstimate() {
    if (estimateTimer) { clearTimeout(estimateTimer); estimateTimer = null; }
    updateZoomLabels();

    if (!pendingLabel) {
        $('downloadEstimate').hidden = true;
        $('startDownloadBtn').disabled = true;
        return;
    }

    const tiles = currentTiles();
    const warningEl = $('estimateWarning');

    if (tiles === null) {
        pendingTiles = [];
        $('tileCount').textContent = 'te veel om te tellen';
        $('sizeEstimate').textContent = '';
        $('timeEstimate').textContent = '';
        $('downloadEstimate').hidden = false;
        warningEl.textContent = 'Dit gebied is te groot. Teken een kleiner gebied of kies een lagere maximumzoom.';
        warningEl.hidden = false;
        $('startDownloadBtn').disabled = true;
        return;
    }

    pendingTiles = tiles;
    const count = pendingTiles.length;
    const sizeMB = count * TILE_SIZE_KB / 1024;

    $('tileCount').textContent = `${count.toLocaleString('nl-BE')} tegels`;
    $('sizeEstimate').textContent = `~${formatBytes(sizeMB)}`;
    $('timeEstimate').textContent = `± ${formatDuration(count / 8)}`;
    $('downloadEstimate').hidden = false;

    const warning = warningEl;
    if (count > TILE_MAX) {
        warning.textContent = `Te groot: maximaal ${TILE_MAX.toLocaleString('nl-BE')} tegels per download. Verklein het gebied of de maximumzoom.`;
        warning.hidden = false;
        $('startDownloadBtn').disabled = true;
    } else if (count > TILE_WARN) {
        warning.textContent = 'Dit is een grote download. OpenStreetMap draait op vrijwilligers: hou het bij wat je echt nodig hebt.';
        warning.hidden = false;
        $('startDownloadBtn').disabled = false;
    } else {
        warning.hidden = true;
        $('startDownloadBtn').disabled = count === 0;
    }
}

function zoomCaption(zoom) {
    if (zoom <= 6) return 'Land';
    if (zoom <= 9) return 'Regio';
    if (zoom <= 11) return 'Stad';
    if (zoom <= 13) return 'Buurt';
    if (zoom === 14) return 'Straten';
    if (zoom === 15) return 'Wandelpaden';
    if (zoom === 16) return 'Veel detail';
    return 'Maximaal detail';
}

/* ---------- Downloaden ---------- */

async function startDownload() {
    if (downloadBusy || pendingTiles.length === 0) return;

    downloadBusy = true;
    downloadAbort = false;

    const minZoom = parseInt($('minZoom').value, 10);
    const maxZoom = parseInt($('maxZoom').value, 10);
    const tiles = pendingTiles.slice();
    // Vastleggen bij de start: de gebruiker kan het venster sluiten of een
    // ander gebied kiezen terwijl de download loopt
    const areaName = pendingLabel || 'Offline gebied';
    const areaOutline = pendingOutline ? pendingOutline.map(punt => punt.slice()) : null;

    $('startDownloadBtn').disabled = true;
    $('selectAreaBtn').disabled = true;
    $('routeBufferBtn').disabled = true;
    $('downloadProgress').hidden = false;
    $('errorLog').textContent = '';
    $('errorDetails').hidden = true;
    setProgress(0, 0, tiles.length);

    // Vraagt de browser om deze opslag niet zomaar weg te gooien
    try {
        if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
    } catch (e) { /* niet erg */ }

    let done = 0, failed = 0, skipped = 0, quotaHit = false;
    const errors = [];
    const savedKeys = [];

    const worker = async (tile) => {
        if (downloadAbort) return;

        const key = tileKey(tile.z, tile.x, tile.y);
        try {
            if (await hasTile(key)) {
                skipped++; done++; savedKeys.push(key);
                return;
            }
            const response = await fetch(`https://tile.openstreetmap.org/${tile.z}/${tile.x}/${tile.y}.png`, {
                mode: 'cors', credentials: 'omit', cache: 'default'
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);

            await saveTile(key, await response.blob());
            savedKeys.push(key);
            done++;
        } catch (error) {
            failed++;
            if (errors.length < 20) errors.push(`${key}: ${error.message || error}`);

            // Opslag vol: verder gaan heeft geen zin, elke volgende tegel faalt ook
            if (error && (error.name === 'QuotaExceededError' || error.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
                quotaHit = true;
                downloadAbort = true;
            }
        } finally {
            setProgress(done, failed, tiles.length);
        }
    };

    try {
        await runPool(tiles, 4, worker, () => downloadAbort);

        if (savedKeys.length === 0) {
            toast(downloadAbort ? 'Download gestopt.' : 'Er kon geen enkele tegel opgehaald worden.', downloadAbort ? 'info' : 'error');
        } else {
            await saveArea({
                name: areaName,
                outline: areaOutline,
                minZoom,
                // reduce in plaats van Math.max(...), dat bij tienduizenden tegels de stack doet overlopen
                maxZoom: savedKeys.reduce((hoogste, key) => Math.max(hoogste, parseInt(key.split('/')[0], 10)), 0),
                tileCount: savedKeys.length,
                tileKeys: savedKeys,
                partial: downloadAbort,
                downloadedAt: Date.now()
            });

            await refreshStoredZoom();
            await loadStorageInfo();

            const message = downloadAbort
                ? `Gestopt na ${savedKeys.length} tegels; die blijven bruikbaar.`
                : `Klaar: ${savedKeys.length} tegels offline beschikbaar${skipped ? ` (${skipped} had je al)` : ''}.`;
            toast(message, downloadAbort ? 'warn' : 'success');
        }

        if (quotaHit) {
            toast('De opslag van je browser zit vol. Verwijder een gebied bij "Opgeslagen gebieden" en probeer opnieuw.', 'error', { duration: 12000 });
        }

        if (failed > 0) {
            $('errorDetails').hidden = false;
            $('errorLog').textContent = errors.join('\n') + (failed > errors.length ? `\n… en ${failed - errors.length} andere` : '');
            toast(`${failed} tegels konden niet opgehaald worden.`, 'warn');
        }
    } catch (error) {
        toast('Download mislukt: ' + (error.message || error), 'error');
    } finally {
        downloadBusy = false;
        $('downloadProgress').hidden = true;
        $('selectAreaBtn').disabled = false;
        $('routeBufferBtn').disabled = gpxData.length === 0;
        clearPendingArea();
    }
}

/** Voert taken uit met een beperkt aantal tegelijk, zodat de tegelserver het aankan. */
async function runPool(items, limit, worker, shouldStop) {
    let cursor = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        while (cursor < items.length) {
            if (shouldStop && shouldStop()) return;
            const item = items[cursor++];
            await worker(item);
            await new Promise(resolve => setTimeout(resolve, 60));
        }
    });

    await Promise.all(runners);
}

function setProgress(done, failed, total) {
    const handled = done + failed;
    const percent = total ? Math.round((handled / total) * 100) : 0;
    $('progressFill').style.width = percent + '%';
    $('progressText').textContent = `${handled.toLocaleString('nl-BE')} / ${total.toLocaleString('nl-BE')} tegels` +
        (failed ? ` · ${failed} mislukt` : '');
}

/* ---------- Opgeslagen gebieden ---------- */

async function loadStorageInfo() {
    const list = $('storageList');
    list.textContent = '';

    let areas = [];
    try {
        areas = await getAllAreas();
    } catch (error) {
        list.textContent = 'De opslag kon niet gelezen worden.';
        return;
    }

    if (areas.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'help';
        empty.textContent = 'Je hebt nog geen kaartgebieden bewaard.';
        list.appendChild(empty);
    }

    areas.forEach(area => {
        const item = document.createElement('div');
        item.className = 'storage-item';

        const info = document.createElement('div');
        info.className = 'storage-item-info';

        const name = document.createElement('div');
        name.className = 'storage-item-name';
        name.textContent = area.name || 'Gebied';

        const details = document.createElement('div');
        details.className = 'storage-item-details';
        const sizeMB = (area.tileCount || 0) * TILE_SIZE_KB / 1024;
        details.textContent = `${(area.tileCount || 0).toLocaleString('nl-BE')} tegels · zoom ${area.minZoom}-${area.maxZoom} · ~${formatBytes(sizeMB)} · ${new Date(area.downloadedAt).toLocaleDateString('nl-BE')}`;

        info.append(name, details);

        const actions = document.createElement('div');
        actions.className = 'btn-group';

        if (Array.isArray(area.outline) && area.outline.length >= 3) {
            const showBtn = document.createElement('button');
            showBtn.className = 'btn btn-sm';
            showBtn.textContent = 'Tonen';
            showBtn.addEventListener('click', () => {
                closeOfflineMapModal();
                map.fitBounds(L.polygon(area.outline).getBounds(), { padding: [40, 40] });
            });
            actions.appendChild(showBtn);
        }

        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-danger-ghost';
        delBtn.textContent = 'Verwijderen';
        delBtn.addEventListener('click', async () => {
            if (downloadBusy) {
                toast('Wacht tot de download klaar is voor je een gebied verwijdert.', 'warn');
                return;
            }
            if (!confirm(`"${area.name}" verwijderen? De tegels die enkel bij dit gebied horen worden gewist.`)) return;
            try {
                const removed = await deleteArea(area.id);
                await refreshStoredZoom();
                await loadStorageInfo();
                toast(`Gebied verwijderd (${removed.toLocaleString('nl-BE')} tegels vrijgemaakt).`, 'success');
            } catch (error) {
                toast('Verwijderen mislukt: ' + (error.message || error), 'error');
            }
        });
        actions.appendChild(delBtn);

        item.append(info, actions);
        list.appendChild(item);
    });

    const quota = $('storageQuota');
    if (navigator.storage && navigator.storage.estimate) {
        try {
            const estimate = await navigator.storage.estimate();
            quota.textContent = `Opslag in gebruik: ${formatBytes(estimate.usage / 1048576)} van ${formatBytes(estimate.quota / 1048576)}`;
        } catch (e) {
            quota.textContent = '';
        }
    }
}

/* ============================================================
   Modals en menu
   ============================================================ */

let focusBeforeModal = null;

function focusableIn(root) {
    return $$('button, input, select, textarea, [tabindex]:not([tabindex="-1"])', root)
        .filter(el => !el.disabled && el.offsetParent !== null);
}

function openModal(id) {
    focusBeforeModal = document.activeElement;
    const modal = $(id);
    modal.classList.add('open');

    const first = focusableIn(modal)[0];
    if (first) first.focus();
}

function closeModal(id) {
    $(id).classList.remove('open');
    if (id === 'markerEditModal') editingMarker = null;

    // Focus terug naar de knop waarmee het venster geopend werd
    if (focusBeforeModal && focusBeforeModal.isConnected) focusBeforeModal.focus();
    focusBeforeModal = null;
}

/** Houdt Tab binnen het open venster. */
function trapFocus(event, modal) {
    const items = focusableIn(modal);
    if (items.length === 0) return;

    const first = items[0];
    const last = items[items.length - 1];

    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function closeTopModal() {
    const open = $$('.modal.open');
    if (open.length === 0) return false;
    open[open.length - 1].classList.remove('open');
    return true;
}

function openMenu() {
    $('slideMenu').classList.add('active');
    $('menuOverlay').classList.add('active');
    $('menuToggle').setAttribute('aria-expanded', 'true');
}

function closeMenu() {
    $('slideMenu').classList.remove('active');
    $('menuOverlay').classList.remove('active');
    $('menuToggle').setAttribute('aria-expanded', 'false');
}

/* ---------- Punt bewerken ---------- */

function buildTypeChips(host, selected, onSelect) {
    host.textContent = '';

    Object.entries(markerTypes).forEach(([key, cfg]) => {
        const chip = document.createElement('button');
        chip.className = 'chip';
        chip.type = 'button';
        chip.setAttribute('role', 'radio');
        chip.setAttribute('aria-checked', String(key === selected));
        chip.tabIndex = key === selected ? 0 : -1;
        chip.innerHTML = `<span aria-hidden="true">${cfg.icon}</span>`;
        chip.append(document.createTextNode(cfg.name));

        chip.addEventListener('click', () => {
            $$('.chip', host).forEach(c => { c.setAttribute('aria-checked', 'false'); c.tabIndex = -1; });
            chip.setAttribute('aria-checked', 'true');
            chip.tabIndex = 0;
            onSelect(key);
        });

        chip.addEventListener('keydown', (e) => {
            if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(e.key)) return;
            e.preventDefault();

            const chips = $$('.chip', host);
            const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : -1;
            const next = chips[(chips.indexOf(chip) + step + chips.length) % chips.length];
            next.focus();
            next.click();
        });

        host.appendChild(chip);
    });

    // Er moet altijd een chip met Tab bereikbaar zijn
    const chips = $$('.chip', host);
    if (chips.length && !chips.some(c => c.tabIndex === 0)) chips[0].tabIndex = 0;
}

function openMarkerEditModal(marker) {
    editingMarker = marker;
    $('editMarkerName').value = marker.markerName || '';
    buildTypeChips($('editTypeChips'), marker.markerType, (type) => { editingMarker.pendingType = type; });
    editingMarker.pendingType = marker.markerType;
    openModal('markerEditModal');
}

function saveMarkerEdit() {
    if (!editingMarker) return;

    const newType = editingMarker.pendingType || editingMarker.markerType;
    const newName = $('editMarkerName').value.trim();

    if (newType !== editingMarker.markerType || newName !== editingMarker.markerName) {
        saveToHistory();
        editingMarker.markerType = newType;
        editingMarker.markerName = newName;
        editingMarker.setIcon(pinIcon(newType));
        afterMarkersChanged();
    }

    closeModal('markerEditModal');
    editingMarker = null;
}

/* ---------- Instellingen ---------- */

function openSettingsModal() {
    $('fitnessLevel').value = settings.fitnessLevel;
    $('backpackWeight').value = settings.backpackWeight;
    $('dayStartDate').value = settings.startDate || '';
    updateSettingsDisplay();
    openModal('settingsModal');
}

function updateSettingsDisplay() {
    const labels = ['', 'Ongetraind', 'Beginnend', 'Gemiddeld', 'Goed getraind', 'Zeer goed getraind'];
    $('fitnessLevelDisplay').textContent = labels[parseInt($('fitnessLevel').value, 10)] || '';
    $('backpackWeightOut').textContent = `${$('backpackWeight').value} kg`;
}

function saveSettingsAndUpdate() {
    settings = sanitizeSettings({
        fitnessLevel: $('fitnessLevel').value,
        backpackWeight: $('backpackWeight').value,
        startDate: $('dayStartDate').value || ''
    });

    saveSettings();
    closeModal('settingsModal');
    if (gpxData.length > 0) renderTrackList();
    toast('Instellingen bewaard.', 'success');
}

/* ---------- Punten plaatsen ---------- */

function setPanelCollapsed(collapsed) {
    $('panel').classList.toggle('collapsed', collapsed);
    $('panelToggle').setAttribute('aria-expanded', String(!collapsed));
}

function setAddMode(active) {
    isAddingPoint = active && gpxData.length > 0;

    // Beide modi luisteren op kaartkliks; samen zouden ze elkaars werk doen
    if (isAddingPoint && drawing.active) cancelDrawing();

    $('addPointBtn').setAttribute('aria-pressed', String(isAddingPoint));
    $('placeBar').hidden = !isAddingPoint;

    if (isAddingPoint) {
        buildTypeChips($('typeChips'), pendingMarkerType, (type) => { pendingMarkerType = type; });
        if (map) map.getContainer().classList.add('map-drawing');
    } else if (map) {
        map.getContainer().classList.remove('map-drawing');
    }

    // Op een smal scherm maakt het paneel plaats voor de balk (zie style.css)
    document.body.classList.toggle('placing', isAddingPoint);
}

/* ============================================================
   Opstarten
   ============================================================ */

function wireEvents() {
    /* Bestanden */
    const openGpx = () => $('gpxFileInput').click();
    const openProject = () => $('projectFileInput').click();

    $('openGpxBtn').addEventListener('click', openGpx);
    $('menuOpenGpx').addEventListener('click', () => { closeMenu(); openGpx(); });
    $('menuLoadProject').addEventListener('click', () => { closeMenu(); openProject(); });

    $('gpxFileInput').addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => loadGpxText(event.target.result, file.name);
        reader.onerror = () => toast('Het bestand kon niet gelezen worden.', 'error');
        reader.readAsText(file);
        e.target.value = '';
    });

    $('projectFileInput').addEventListener('change', function (e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => loadProject(event.target.result);
        reader.onerror = () => toast('Het bestand kon niet gelezen worden.', 'error');
        reader.readAsText(file);
        e.target.value = '';
    });

    /* Bovenbalk */
    $('undoBtn').addEventListener('click', undo);
    $('saveProjectBtn').addEventListener('click', saveProject);
    $('menuSaveProject').addEventListener('click', () => { closeMenu(); saveProject(); });
    $('exportGpxBtn').addEventListener('click', openExportModal);
    $('menuExportGpx').addEventListener('click', () => { closeMenu(); openExportModal(); });
    $('closeExportBtn').addEventListener('click', () => closeModal('exportModal'));

    /* Gereedschap */
    $('addPointBtn').addEventListener('click', () => setAddMode(!isAddingPoint));
    $('locationBtn').addEventListener('click', toggleLocationTracking);
    $('followBtn').addEventListener('click', toggleFollow);
    $('fitRouteBtn').addEventListener('click', () => {
        if (gpxPolyline) map.fitBounds(gpxPolyline.getBounds(), { padding: [40, 40] });
    });
    $('offlineMapBtn').addEventListener('click', openOfflineMapModal);
    $('menuOffline').addEventListener('click', () => { closeMenu(); openOfflineMapModal(); });

    /* Paneel */
    $('panelToggle').addEventListener('click', () => {
        setPanelCollapsed(!$('panel').classList.contains('collapsed'));
    });
    $('clearBtn').addEventListener('click', clearAllWithConfirm);
    $('menuClear').addEventListener('click', () => { closeMenu(); clearAllWithConfirm(); });

    /* Automatisch verdelen */
    $('autoSplitBtn').addEventListener('click', openAutoSplitModal);
    $('menuAutoSplit').addEventListener('click', () => { closeMenu(); openAutoSplitModal(); });
    $('autoSplitDays').addEventListener('input', updateAutoSplitPreview);
    $('autoSplitApply').addEventListener('click', () => {
        if (splitMarkers.length > 0 && !confirm('De bestaande punten worden vervangen. Doorgaan?')) return;
        autoSplit(parseInt($('autoSplitDays').value, 10));
        closeModal('autoSplitModal');
    });

    /* Menu */
    $('menuToggle').addEventListener('click', openMenu);
    $('closeMenu').addEventListener('click', closeMenu);
    $('menuOverlay').addEventListener('click', closeMenu);
    $('menuSettings').addEventListener('click', () => { closeMenu(); openSettingsModal(); });

    /* Modals */
    $$('[data-close]').forEach(btn => btn.addEventListener('click', () => closeModal(btn.dataset.close)));
    $$('.modal').forEach(modal => modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            if (modal.id === 'offlineMapModal') closeOfflineMapModal();
            else closeModal(modal.id);
        }
    }));

    /* Punt bewerken */
    $('markerSaveBtn').addEventListener('click', saveMarkerEdit);
    $('markerDeleteBtn').addEventListener('click', () => {
        if (!editingMarker) return;
        const index = splitMarkers.indexOf(editingMarker);
        closeModal('markerEditModal');
        editingMarker = null;
        if (index >= 0) deleteMarker(index);
    });

    /* Instellingen */
    $('saveSettingsBtn').addEventListener('click', saveSettingsAndUpdate);
    $('resetSettingsBtn').addEventListener('click', () => {
        $('fitnessLevel').value = DEFAULT_SETTINGS.fitnessLevel;
        $('backpackWeight').value = DEFAULT_SETTINGS.backpackWeight;
        $('dayStartDate').value = '';
        updateSettingsDisplay();
    });
    $('fitnessLevel').addEventListener('input', updateSettingsDisplay);
    $('backpackWeight').addEventListener('input', updateSettingsDisplay);

    /* Offline kaart */
    $$('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    $('selectAreaBtn').addEventListener('click', selectArea);
    $('drawFinishBtn').addEventListener('click', finishPolygon);
    $('drawCancelBtn').addEventListener('click', () => { cancelDrawing(); openModal('offlineMapModal'); });
    $('routeBufferBtn').addEventListener('click', useRouteBuffer);
    $('startDownloadBtn').addEventListener('click', startDownload);
    $('abortDownloadBtn').addEventListener('click', () => {
        downloadAbort = true;
        toast('Download wordt gestopt…');
    });
    $('cancelDownloadBtn').addEventListener('click', closeOfflineMapModal);
    $('closeManageBtn').addEventListener('click', closeOfflineMapModal);
    $('minZoom').addEventListener('input', scheduleEstimate);
    $('maxZoom').addEventListener('input', scheduleEstimate);

    /* Sneltoetsen */
    document.addEventListener('keydown', (e) => {
        const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);

        if (e.key === 'Escape') {
            if (drawing.active) { cancelDrawing(); openModal('offlineMapModal'); return; }
            if (closeTopModal()) return;
            if (isAddingPoint) setAddMode(false);
            return;
        }

        const openDialog = document.querySelector('.modal.open');
        if (e.key === 'Tab' && openDialog) { trapFocus(e, openDialog); return; }
        if (typing || openDialog) return;

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
        if (e.key.toLowerCase() === 'a' && gpxData.length) setAddMode(!isAddingPoint);
        if (e.key.toLowerCase() === 'l') toggleLocationTracking();
        if (e.key.toLowerCase() === 'f' && gpxPolyline) map.fitBounds(gpxPolyline.getBounds(), { padding: [40, 40] });
    });

    /* Alleen waarschuwen als de sessie níét automatisch bewaard kan worden */
    window.addEventListener('beforeunload', (e) => {
        if (!db && gpxData.length > 0 && splitMarkers.length > 0) {
            e.preventDefault();
            e.returnValue = '';
        }
    });
}

function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;

    const register = () => {
        // Relatief pad: de app draait onder /GPXTrackSplitter/ op GitHub Pages
        navigator.serviceWorker.register('service-worker.js')
            .then(registration => {
                registration.addEventListener('updatefound', () => {
                    const installing = registration.installing;
                    if (!installing) return;
                    installing.addEventListener('statechange', () => {
                        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
                            toast('Er is een nieuwe versie klaar.', 'info', {
                                actionLabel: 'Herladen',
                                onAction: () => location.reload(),
                                duration: 15000
                            });
                        }
                    });
                });
            })
            .catch(error => console.warn('Service worker niet geregistreerd:', error));
    };

    // init() is async; het load-event kan al voorbij zijn tegen dat we hier komen
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
}

async function init() {
    loadSettings();
    $('menuVersion').textContent = `versie ${APP_VERSION}`;

    // Eerst de opslag openen: de kaart vraagt meteen tegels op, en die moeten
    // offline uit IndexedDB kunnen komen in plaats van uit een leeg netwerk.
    let dbFout = null;
    try {
        await initOfflineDB();
    } catch (error) {
        console.warn('Offline opslag niet beschikbaar:', error);
        dbFout = error;
    }

    // Pas knoppen aankoppelen als de kaart bestaat, anders klikt de gebruiker
    // in dat korte venster op iets dat nog geen kaart heeft om mee te werken
    initMap();
    wireEvents();
    if (dbFout) toast('Offline opslag is niet beschikbaar; opgeslagen kaarten werken nu niet.', 'warn');

    renderTrackList();
    updateControls();
    updateStatusPill();

    if (db) {
        await refreshStoredZoom();
        await restoreSession();
    }

    registerServiceWorker();
}

init();
