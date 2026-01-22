// Global variables
let map;
let gpxData = [];
let splitMarkers = [];
let gpxPolyline;
let segmentPolylines = [];
let isAddingPoint = false;
let editingMarker = null;
let markerHistory = [];

// Default settings
let settings = {
    fitnessLevel: 2,  // 1=ongetraind, 2=beginnend, 3=gemiddeld, 4=goed, 5=zeer goed
    backpackWeight: 15  // in kg
};

// Load settings from localStorage
function loadSettings() {
    const saved = localStorage.getItem('gpxSplitterSettings');
    if (saved) {
        try {
            settings = JSON.parse(saved);
        } catch (e) {
            console.error('Failed to load settings:', e);
        }
    }
}

// Save settings to localStorage
function saveSettings() {
    localStorage.setItem('gpxSplitterSettings', JSON.stringify(settings));
}

// Get backpack weight multiplier
function getBackpackMultiplier() {
    // 15kg = 1.25 (25% extra), 0kg = 1.0 (geen extra)
    // Lineair: 1 + (weight / 60)
    // Dit geeft: 0kg=1.0, 15kg=1.25, 30kg=1.5
    return 1 + (settings.backpackWeight / 75);
}
// Save current marker state to history
function saveToHistory() {
    const state = splitMarkers.map(marker => ({
        pointIndex: marker.pointIndex,
        type: marker.markerType
    }));
    markerHistory.push(state);
    
    // Limit history to last 20 states
    if (markerHistory.length > 20) {
        markerHistory.shift();
    }
    
    updateUndoButton();
}

// Update undo button state
function updateUndoButton() {
    const undoBtn = document.getElementById('undoBtn');
    undoBtn.disabled = markerHistory.length === 0;
}

// Undo last action
function undo() {
    if (markerHistory.length === 0) return;
    
    // Get previous state
    const previousState = markerHistory.pop();
    
    // Clear current markers
    splitMarkers.forEach(marker => map.removeLayer(marker));
    splitMarkers = [];
    
    // Restore previous state
    previousState.forEach(markerData => {
        addSplitMarker(markerData.pointIndex, markerData.type, false);
    });
    
    updateUndoButton();
    updateTrackList();
}
// Marker types configuration
const markerTypes = {
    split: {
        name: 'Splitpunt',
        color: 'red',
        icon: '🚩'
    },
    wildcamp: {
        name: 'Wildcamperen',
        color: 'green',
        icon: '⛺'
    },
    camping: {
        name: 'Camping',
        color: 'blue',
        icon: '🏕️'
    },
    hotel: {
        name: 'Hotel/B&B',
        color: 'violet',
        icon: '🏨'
    },
    rest: {
        name: 'Rustpunt',
        color: 'orange',
        icon: '☕'
    }
};

// Initialize map
function initMap() {
    map = L.map('map').setView([51.0543, 3.7174], 13); // Default: Gent, België
    
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);
    
    map.on('click', onMapClick);
}

// Parse GPX file
function parseGPX(gpxText) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(gpxText, 'text/xml');
    const trackPoints = xmlDoc.getElementsByTagName('trkpt');
    
    const points = [];
    for (let i = 0; i < trackPoints.length; i++) {
        const lat = parseFloat(trackPoints[i].getAttribute('lat'));
        const lon = parseFloat(trackPoints[i].getAttribute('lon'));
        const eleElement = trackPoints[i].getElementsByTagName('ele')[0];
        const ele = eleElement ? parseFloat(eleElement.textContent) : 0;
        
        points.push({ lat, lon, ele });
    }
    
    return points;
}

// Calculate distance between two points (Haversine formula)
function calculateDistance(point1, point2) {
    const R = 6371; // Earth radius in km
    const dLat = (point2.lat - point1.lat) * Math.PI / 180;
    const dLon = (point2.lon - point1.lon) * Math.PI / 180;
    
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(point1.lat * Math.PI / 180) * Math.cos(point2.lat * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    
    return distance;
}

// Calculate elevation gain and loss with smoothing
function calculateElevation(points) {
    if (points.length < 2) return { gain: 0, loss: 0 };
    
    // Apply moving average smoothing to reduce GPS noise
    const smoothWindow = 5; // Average over 5 points
    const smoothedElevations = [];
    
    for (let i = 0; i < points.length; i++) {
        let sum = 0;
        let count = 0;
        
        for (let j = Math.max(0, i - Math.floor(smoothWindow / 2)); 
             j <= Math.min(points.length - 1, i + Math.floor(smoothWindow / 2)); 
             j++) {
            sum += points[j].ele;
            count++;
        }
        
        smoothedElevations.push(sum / count);
    }
    
    // Calculate gain/loss with threshold to ignore small variations
    const threshold = 0.5; // Only count changes > 0.5 meter
    let gain = 0;
    let loss = 0;
    let cumulative = 0;
    
    for (let i = 1; i < smoothedElevations.length; i++) {
        const diff = smoothedElevations[i] - smoothedElevations[i-1];
        cumulative += diff;
        
        // Only register gain/loss when cumulative change exceeds threshold
        if (cumulative > threshold) {
            gain += cumulative;
            cumulative = 0;
        } else if (cumulative < -threshold) {
            loss += Math.abs(cumulative);
            cumulative = 0;
        }
    }
    
    return { gain, loss };
}

// Calculate total distance for a segment
function calculateSegmentStats(points) {
    let distance = 0;
    
    for (let i = 1; i < points.length; i++) {
        distance += calculateDistance(points[i-1], points[i]);
    }
    
    const elevation = calculateElevation(points);
    
    // Equivalente km: (km + hm+ / 80 + hm− / 150) × backpack multiplier
    const backpackMultiplier = getBackpackMultiplier();
    const equivalentKm = (distance + elevation.gain / 80 + elevation.loss / 150) * backpackMultiplier;
    
    // Uren: aanpassen op basis van fitness niveau
    const baseHours = (distance / 4) + (elevation.gain / 500) + (elevation.loss / 2000);
    const hours = baseHours * (0.9 + (3 - settings.fitnessLevel) * 0.1);
    
    return {
        distance,
        elevationGain: elevation.gain,
        elevationLoss: elevation.loss,
        equivalentKm,
        hours
    };
}

// Find closest point on GPX track
function findClosestPointIndex(latlng) {
    let minDistance = Infinity;
    let closestIndex = 0;
    
    for (let i = 0; i < gpxData.length; i++) {
        const distance = calculateDistance(
            { lat: latlng.lat, lon: latlng.lng },
            { lat: gpxData[i].lat, lon: gpxData[i].lon }
        );
        
        if (distance < minDistance) {
            minDistance = distance;
            closestIndex = i;
        }
    }
    
    return closestIndex;
}

// Handle map click
function onMapClick(e) {
    if (!isAddingPoint || gpxData.length === 0) return;
    
    const markerType = document.getElementById('markerTypeSelect').value;
    const closestIndex = findClosestPointIndex(e.latlng);
    addSplitMarker(closestIndex, markerType);
    
    isAddingPoint = false;
    document.getElementById('addPointBtn').classList.remove('active');
    
    updateTrackList();
}

// Add split marker
function addSplitMarker(pointIndex, type = 'split', saveHistory = true) {
    if (saveHistory) {
        saveToHistory();
    }
    
    const point = gpxData[pointIndex];
    const markerConfig = markerTypes[type];
    
    const marker = L.marker([point.lat, point.lon], {
        draggable: true,
        icon: L.icon({
            iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${markerConfig.color}.png`,
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        })
    }).addTo(map);
    
    marker.pointIndex = pointIndex;
    marker.markerType = type;
    
    // Add popup with marker info
    marker.bindPopup(`${markerConfig.icon} ${markerConfig.name}`);
    
    marker.on('dragstart', function(e) {
        saveToHistory();
    });
    
    marker.on('dragend', function(e) {
        const newLatLng = e.target.getLatLng();
        const newIndex = findClosestPointIndex(newLatLng);
        marker.pointIndex = newIndex;
        
        const newPoint = gpxData[newIndex];
        marker.setLatLng([newPoint.lat, newPoint.lon]);
        
        updateTrackList();
    });
    
    // Add click event to edit marker type
    marker.on('click', function(e) {
        L.DomEvent.stopPropagation(e);
        openMarkerEditModal(marker);
    });
    
    splitMarkers.push(marker);
    splitMarkers.sort((a, b) => a.pointIndex - b.pointIndex);
}

// Get difficulty level and color based on equivalent km
function getDifficulty(equivKm) {
    // Thresholds gebaseerd op trainingsniveau
    const thresholds = {
        1: { comfortable: 20, moderate: 28, heavy: 35 },      // Ongetraind
        2: { comfortable: 24, moderate: 32, heavy: 40 },      // Beginnend
        3: { comfortable: 30, moderate: 38, heavy: 45 },      // Gemiddeld (origineel)
        4: { comfortable: 36, moderate: 44, heavy: 52 },      // Goed getraind
        5: { comfortable: 42, moderate: 52, heavy: 60 }       // Zeer goed getraind
    };
    
    const t = thresholds[settings.fitnessLevel] || thresholds[3];
    
    if (equivKm < t.comfortable) {
        return { level: 'Comfortabel', color: '#4CAF50', bgColor: '#e8f5e9' };
    } else if (equivKm < t.moderate) {
        return { level: 'Stevig maar haalbaar', color: '#FF9800', bgColor: '#fff3e0' };
    } else if (equivKm < t.heavy) {
        return { level: 'Zwaar', color: '#FF5722', bgColor: '#fbe9e7' };
    } else {
        return { level: 'Zeer zwaar / enkel voor ervaren wandelaars', color: '#D32F2F', bgColor: '#ffebee' };
    }
}

// Update track list
function updateTrackList() {
    const trackList = document.getElementById('trackList');
    trackList.innerHTML = '';
    
    // Remove old segment polylines
    segmentPolylines.forEach(poly => map.removeLayer(poly));
    segmentPolylines = [];
    
    if (splitMarkers.length === 0) {
        // Show total stats for entire track
        const stats = calculateSegmentStats(gpxData);
        const difficulty = getDifficulty(stats.equivalentKm);
        
        // Draw entire track in base color
        if (gpxPolyline) {
            gpxPolyline.setStyle({ color: '#2196F3', weight: 4, opacity: 0.8 });
        }
        
        trackList.innerHTML = `
            <div class="track-item" style="border-left-color: ${difficulty.color}; background: ${difficulty.bgColor};">
                <h3 style="color: ${difficulty.color};">Volledige track <span style="font-size: 12px; font-weight: normal;">(${difficulty.level})</span></h3>
                <div class="track-stats">
                    <div class="stat">
                        <span class="stat-label">Afstand:</span>
                        <span class="stat-value">${stats.distance.toFixed(2)} km</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Stijging:</span>
                        <span class="stat-value">${stats.elevationGain.toFixed(0)} m</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Daling:</span>
                        <span class="stat-value">${stats.elevationLoss.toFixed(0)} m</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Equiv. km:</span>
                        <span class="stat-value">${stats.equivalentKm.toFixed(2)} km</span>
                    </div>
                    <div class="stat">
                        <span class="stat-label">Tijd:</span>
                        <span class="stat-value">${formatHours(stats.hours)}</span>
                    </div>
                </div>
            </div>
        `;
        return;
    }
    
    // Hide base polyline when we have segments
    if (gpxPolyline) {
        gpxPolyline.setStyle({ opacity: 0 });
    }
    
    // Create segments based on split markers
    const segments = [];
    let startIndex = 0;
    
    for (let i = 0; i < splitMarkers.length; i++) {
        const endIndex = splitMarkers[i].pointIndex;
        segments.push({
            start: startIndex,
            end: endIndex,
            markerIndex: i
        });
        startIndex = endIndex;
    }
    
    // Add final segment
    segments.push({
        start: startIndex,
        end: gpxData.length - 1,
        markerIndex: -1
    });
    
    // Calculate and display stats for each segment
    let cumulativeDistance = 0;
    let cumulativeGain = 0;
    let cumulativeLoss = 0;
    let cumulativeEquivKm = 0;
    let cumulativeHours = 0;
    
    segments.forEach((segment, index) => {
        const points = gpxData.slice(segment.start, segment.end + 1);
        const stats = calculateSegmentStats(points);
        
        cumulativeDistance += stats.distance;
        cumulativeGain += stats.elevationGain;
        cumulativeLoss += stats.elevationLoss;
        cumulativeEquivKm += stats.equivalentKm;
        cumulativeHours += stats.hours;
        
        const difficulty = getDifficulty(stats.equivalentKm);
        
        // Draw segment on map
        const segmentLatLngs = points.map(p => [p.lat, p.lon]);
        const segmentPoly = L.polyline(segmentLatLngs, {
            color: difficulty.color,
            weight: 4,
            opacity: 0.8
        }).addTo(map);
        
        segmentPolylines.push(segmentPoly);
        
        // Add hover effects
        const trackItem = document.createElement('div');
        trackItem.className = 'track-item';
        trackItem.style.borderLeftColor = difficulty.color;
        trackItem.style.background = difficulty.bgColor;
        trackItem.style.cursor = 'pointer';
        
        trackItem.addEventListener('mouseenter', () => {
            segmentPoly.setStyle({ weight: 8, opacity: 1 });
            trackItem.style.transform = 'translateX(-5px)';
            trackItem.style.boxShadow = '0 4px 8px rgba(0,0,0,0.2)';
        });
        
        trackItem.addEventListener('mouseleave', () => {
            segmentPoly.setStyle({ weight: 4, opacity: 0.8 });
            trackItem.style.transform = 'translateX(0)';
            trackItem.style.boxShadow = 'none';
        });
        
        trackItem.addEventListener('click', () => {
            map.fitBounds(segmentPoly.getBounds(), { padding: [50, 50] });
        });
        
        const markerInfo = segment.markerIndex >= 0 ? splitMarkers[segment.markerIndex] : null;
        const markerTypeInfo = markerInfo ? markerTypes[markerInfo.markerType] : null;
        
        trackItem.innerHTML = `
            <h3 style="color: ${difficulty.color};">Track ${index + 1} <span style="font-size: 12px; font-weight: normal;">(${difficulty.level})</span></h3>
            ${markerTypeInfo ? `<div class="marker-type-badge" style="background: ${markerTypeInfo.color}; color: white; padding: 2px 8px; border-radius: 3px; display: inline-block; font-size: 11px; margin-bottom: 8px;">${markerTypeInfo.icon} ${markerTypeInfo.name}</div>` : ''}
            <div class="track-stats">
                <div class="stat">
                    <span class="stat-label">Afstand:</span>
                    <span class="stat-value">${stats.distance.toFixed(2)} km</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Stijging:</span>
                    <span class="stat-value">${stats.elevationGain.toFixed(0)} m</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Daling:</span>
                    <span class="stat-value">${stats.elevationLoss.toFixed(0)} m</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Equiv. km:</span>
                    <span class="stat-value">${stats.equivalentKm.toFixed(2)} km</span>
                </div>
                <div class="stat">
                    <span class="stat-label">Tijd:</span>
                    <span class="stat-value">${formatHours(stats.hours)}</span>
                </div>
            </div>
            ${segment.markerIndex >= 0 ? `<button class="delete-marker-btn" onclick="deleteMarker(${segment.markerIndex})">Verwijder punt</button>` : ''}
        `;
        
        trackList.appendChild(trackItem);
    });
    
    // Add cumulative stats
    const cumulativeItem = document.createElement('div');
    cumulativeItem.className = 'track-item cumulative';
    cumulativeItem.innerHTML = `
        <h3>Totaal (cumulatief)</h3>
        <div class="track-stats">
            <div class="stat">
                <span class="stat-label">Afstand:</span>
                <span class="stat-value">${cumulativeDistance.toFixed(2)} km</span>
            </div>
            <div class="stat">
                <span class="stat-label">Stijging:</span>
                <span class="stat-value">${cumulativeGain.toFixed(0)} m</span>
            </div>
            <div class="stat">
                <span class="stat-label">Daling:</span>
                <span class="stat-value">${cumulativeLoss.toFixed(0)} m</span>
            </div>
            <div class="stat">
                <span class="stat-label">Equiv. km:</span>
                <span class="stat-value">${cumulativeEquivKm.toFixed(2)} km</span>
            </div>
            <div class="stat">
                <span class="stat-label">Tijd:</span>
                <span class="stat-value">${formatHours(cumulativeHours)}</span>
            </div>
        </div>
    `;
    
    trackList.appendChild(cumulativeItem);
}

// Format hours to HH:MM
function formatHours(hours) {
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return `${h}u${m.toString().padStart(2, '0')}m`;
}

// Delete marker
function deleteMarker(index) {
    saveToHistory();
    map.removeLayer(splitMarkers[index]);
    splitMarkers.splice(index, 1);
    updateTrackList();
}

// Open marker edit modal
function openMarkerEditModal(marker) {
    editingMarker = marker;
    const modal = document.getElementById('markerEditModal');
    const select = document.getElementById('editMarkerTypeSelect');
    
    select.value = marker.markerType;
    modal.style.display = 'flex';
}

// Close marker edit modal
function closeMarkerEditModal() {
    const modal = document.getElementById('markerEditModal');
    modal.style.display = 'none';
    editingMarker = null;
}

// Update marker type
function updateMarkerType() {
    if (!editingMarker) return;
    
    saveToHistory();
    
    const newType = document.getElementById('editMarkerTypeSelect').value;
    const markerConfig = markerTypes[newType];
    
    // Update marker type
    editingMarker.markerType = newType;
    
    // Update marker icon
    editingMarker.setIcon(L.icon({
        iconUrl: `https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-${markerConfig.color}.png`,
        shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
        iconSize: [25, 41],
        iconAnchor: [12, 41],
        popupAnchor: [1, -34],
        shadowSize: [41, 41]
    }));
    
    // Update popup
    editingMarker.setPopupContent(`${markerConfig.icon} ${markerConfig.name}`);
    
    closeMarkerEditModal();
    updateTrackList();
}

// Open settings modal
function openSettingsModal() {
    const modal = document.getElementById('settingsModal');
    const slider = document.getElementById('fitnessLevel');
    const backpackInput = document.getElementById('backpackWeight');
    
    slider.value = settings.fitnessLevel;
    backpackInput.value = settings.backpackWeight;
    updateFitnessDisplay();
    modal.style.display = 'flex';
}

// Close settings modal
function closeSettingsModal() {
    const modal = document.getElementById('settingsModal');
    modal.style.display = 'none';
}

// Update fitness level display
function updateFitnessDisplay() {
    const level = parseInt(document.getElementById('fitnessLevel').value);
    const labels = ['', 'Ongetraind', 'Beginnend', 'Gemiddeld', 'Goed getraind', 'Zeer goed getraind'];
    document.getElementById('fitnessLevelDisplay').textContent = labels[level];
}

// Save settings and update display
function saveSettingsAndUpdate() {
    settings.fitnessLevel = parseInt(document.getElementById('fitnessLevel').value);
    settings.backpackWeight = parseFloat(document.getElementById('backpackWeight').value);
    saveSettings();
    closeSettingsModal();
    
    // Recalculate if we have data loaded
    if (gpxData.length > 0) {
        updateTrackList();
    }
}

// Reset settings to default
function resetSettings() {
    settings.fitnessLevel = 2;
    settings.backpackWeight = 15;
    document.getElementById('fitnessLevel').value = 2;
    document.getElementById('backpackWeight').value = 15;
    updateFitnessDisplay();
}

// Save project to JSON
function saveProject() {
    if (gpxData.length === 0) {
        alert('Geen data om op te slaan');
        return;
    }
    
    const markers = splitMarkers.map(marker => ({
        pointIndex: marker.pointIndex,
        type: marker.markerType
    }));
    
    const projectData = {
        version: '2.0',
        gpxData: gpxData,
        markers: markers,
        savedAt: new Date().toISOString()
    };
    
    const jsonString = JSON.stringify(projectData, null, 2);
    const blob = new Blob([jsonString], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `gpx-track-project-${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    
    URL.revokeObjectURL(url);
}

// Load project from JSON
function loadProject(jsonData) {
    try {
        const projectData = JSON.parse(jsonData);
        
        if (!projectData.gpxData || !Array.isArray(projectData.gpxData)) {
            alert('Ongeldig project bestand');
            return;
        }
        
        clearAll();
        
        gpxData = projectData.gpxData;
        
        // Draw GPX track
        const latlngs = gpxData.map(p => [p.lat, p.lon]);
        gpxPolyline = L.polyline(latlngs, {
            color: '#2196F3',
            weight: 4,
            opacity: 0.8
        }).addTo(map);
        
        map.fitBounds(gpxPolyline.getBounds());
        
        // Clear history when loading project
        markerHistory = [];
        
        // Restore markers (support both old and new format)
        if (projectData.markers && Array.isArray(projectData.markers)) {
            // New format (v2.0)
            projectData.markers.forEach(markerData => {
                addSplitMarker(markerData.pointIndex, markerData.type || 'split', false);
            });
        } else if (projectData.markerIndices && Array.isArray(projectData.markerIndices)) {
            // Old format (v1.0) - backwards compatibility
            projectData.markerIndices.forEach(index => {
                addSplitMarker(index, 'split', false);
            });
        }
        
        document.getElementById('markerTypeSelect').disabled = false;
        document.getElementById('addPointBtn').disabled = false;
        document.getElementById('clearBtn').disabled = false;
        document.getElementById('saveProjectBtn').disabled = false;
        document.getElementById('loadProjectBtnTrigger').disabled = false;
        
        updateTrackList();
    } catch (error) {
        alert('Fout bij het laden van project: ' + error.message);
    }
}

// Clear all
function clearAll() {
    // Only show confirmation if there's actually data to clear
    if (gpxData.length > 0 || splitMarkers.length > 0) {
        if (!confirm('Weet je zeker dat je alles wilt wissen? Dit kan niet ongedaan worden gemaakt.')) {
            return;
        }
    }
    
    if (gpxPolyline) {
        map.removeLayer(gpxPolyline);
        gpxPolyline = null;
    }
    
    segmentPolylines.forEach(poly => map.removeLayer(poly));
    segmentPolylines = [];
    
    splitMarkers.forEach(marker => map.removeLayer(marker));
    splitMarkers = [];
    gpxData = [];
    markerHistory = [];
    
    document.getElementById('trackList').innerHTML = '<p class="placeholder">Laad een GPX bestand om te beginnen</p>';
    document.getElementById('addPointBtn').disabled = true;
    document.getElementById('undoBtn').disabled = true;
    document.getElementById('clearBtn').disabled = true;
    document.getElementById('saveProjectBtn').disabled = true;
}

// Event listeners
document.getElementById('gpxFileInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(event) {
        clearAll();
        markerHistory = [];
        
        gpxData = parseGPX(event.target.result);
        
        if (gpxData.length === 0) {
            alert('Geen trackpoints gevonden in GPX bestand');
            return;
        }
        
        // Draw GPX track
        const latlngs = gpxData.map(p => [p.lat, p.lon]);
        gpxPolyline = L.polyline(latlngs, {
            color: '#2196F3',
            weight: 4,
            opacity: 0.8
        }).addTo(map);
        
        map.fitBounds(gpxPolyline.getBounds());
        
        document.getElementById('markerTypeSelect').disabled = false;
        document.getElementById('addPointBtn').disabled = false;
        document.getElementById('clearBtn').disabled = false;
        document.getElementById('saveProjectBtn').disabled = false;
        document.getElementById('loadProjectBtnTrigger').disabled = false;
        updateTrackList();
    };
    
    reader.readAsText(file);
});

document.getElementById('addPointBtn').addEventListener('click', function() {
    isAddingPoint = !isAddingPoint;
    this.classList.toggle('active', isAddingPoint);
    this.textContent = isAddingPoint ? 'Klik op de kaart...' : 'Voeg punt toe (klik op kaart)';
});

document.getElementById('undoBtn').addEventListener('click', undo);

document.getElementById('clearBtn').addEventListener('click', clearAll);

document.getElementById('saveProjectBtn').addEventListener('click', saveProject);

document.getElementById('loadProjectBtnTrigger').addEventListener('click', function() {
    document.getElementById('loadProjectBtn').click();
});

document.getElementById('loadProjectBtn').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(event) {
        loadProject(event.target.result);
    };
    
    reader.readAsText(file);
    
    // Reset file input
    e.target.value = '';
});

// Event listeners for marker edit modal
document.getElementById('editMarkerTypeSelect').addEventListener('change', function() {
    updateMarkerType();
});

// Close modal when clicking outside
document.getElementById('markerEditModal').addEventListener('click', function(e) {
    if (e.target === this) {
        closeMarkerEditModal();
    }
});

// Event listeners for settings
document.getElementById('settingsBtn').addEventListener('click', openSettingsModal);
document.getElementById('saveSettingsBtn').addEventListener('click', saveSettingsAndUpdate);
document.getElementById('cancelSettingsBtn').addEventListener('click', closeSettingsModal);
document.getElementById('resetSettingsBtn').addEventListener('click', resetSettings);
document.getElementById('fitnessLevel').addEventListener('input', updateFitnessDisplay);

// Close settings modal when clicking outside
document.getElementById('settingsModal').addEventListener('click', function(e) {
    if (e.target === this) {
        closeSettingsModal();
    }
});

// Burger menu functionality
document.getElementById('menuToggle').addEventListener('click', function() {
    document.getElementById('slideMenu').classList.add('active');
    document.getElementById('menuOverlay').classList.add('active');
});

document.getElementById('closeMenu').addEventListener('click', function() {
    document.getElementById('slideMenu').classList.remove('active');
    document.getElementById('menuOverlay').classList.remove('active');
});

document.getElementById('menuOverlay').addEventListener('click', function() {
    document.getElementById('slideMenu').classList.remove('active');
    document.getElementById('menuOverlay').classList.remove('active');
});

// Close menu after selecting an option
document.querySelectorAll('.menu-button').forEach(button => {
    button.addEventListener('click', function() {
        if (!this.disabled) {
            setTimeout(() => {
                document.getElementById('slideMenu').classList.remove('active');
                document.getElementById('menuOverlay').classList.remove('active');
            }, 100);
        }
    });
});

// Mobile menu button handlers
document.getElementById('loadProjectBtnMobile').addEventListener('click', function() {
    document.getElementById('loadProjectBtn').click();
});

document.getElementById('saveProjectBtnMobile').addEventListener('click', saveProject);

document.getElementById('settingsBtnMobile').addEventListener('click', openSettingsModal);

// Update mobile save button state when main button changes
const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
        if (mutation.attributeName === 'disabled') {
            const mainBtn = document.getElementById('saveProjectBtn');
            const mobileBtn = document.getElementById('saveProjectBtnMobile');
            if (mainBtn.disabled) {
                mobileBtn.disabled = true;
            } else {
                mobileBtn.disabled = false;
            }
        }
    });
});

observer.observe(document.getElementById('saveProjectBtn'), { attributes: true });

// Sidebar toggle functionality
document.getElementById('toggleSidebar').addEventListener('click', function() {
    const trackList = document.getElementById('trackList');
    const sidebar = document.querySelector('.sidebar');
    const button = this;
    
    trackList.classList.toggle('collapsed');
    button.classList.toggle('collapsed');
    sidebar.classList.toggle('minimized');
    
    // Trigger map resize after animation
    setTimeout(() => {
        map.invalidateSize();
    }, 300);
});

// Initialize
loadSettings();
initMap();
