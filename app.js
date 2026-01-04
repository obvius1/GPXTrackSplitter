// Global variables
let map;
let gpxData = [];
let splitMarkers = [];
let gpxPolyline;
let segmentPolylines = [];
let isAddingPoint = false;

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

// Calculate elevation gain and loss
function calculateElevation(points) {
    let gain = 0;
    let loss = 0;
    
    for (let i = 1; i < points.length; i++) {
        const diff = points[i].ele - points[i-1].ele;
        if (diff > 0) {
            gain += diff;
        } else {
            loss += Math.abs(diff);
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
    
    // Equivalente km: (km + hm+ / 80 + hm− / 150) × 1.2 × 1.1 (10% extra)
    const equivalentKm = (distance + elevation.gain / 80 + elevation.loss / 150) * 1.32;
    
    // Uren: (afstand / 4) + (hm+ / 500) + (hm- / 2000) × 1.1 (10% extra)
    const hours = ((distance / 4) + (elevation.gain / 500) + (elevation.loss / 2000)) * 1.1;
    
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
    
    const closestIndex = findClosestPointIndex(e.latlng);
    addSplitMarker(closestIndex);
    
    isAddingPoint = false;
    document.getElementById('addPointBtn').classList.remove('active');
    
    updateTrackList();
}

// Add split marker
function addSplitMarker(pointIndex) {
    const point = gpxData[pointIndex];
    
    const marker = L.marker([point.lat, point.lon], {
        draggable: true,
        icon: L.icon({
            iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-red.png',
            shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/images/marker-shadow.png',
            iconSize: [25, 41],
            iconAnchor: [12, 41],
            popupAnchor: [1, -34],
            shadowSize: [41, 41]
        })
    }).addTo(map);
    
    marker.pointIndex = pointIndex;
    
    marker.on('dragend', function(e) {
        const newLatLng = e.target.getLatLng();
        const newIndex = findClosestPointIndex(newLatLng);
        marker.pointIndex = newIndex;
        
        const newPoint = gpxData[newIndex];
        marker.setLatLng([newPoint.lat, newPoint.lon]);
        
        updateTrackList();
    });
    
    splitMarkers.push(marker);
    splitMarkers.sort((a, b) => a.pointIndex - b.pointIndex);
}

// Get difficulty level and color based on equivalent km
function getDifficulty(equivKm) {
    if (equivKm < 30) {
        return { level: 'Comfortabel', color: '#4CAF50', bgColor: '#e8f5e9' };
    } else if (equivKm < 38) {
        return { level: 'Stevig maar haalbaar', color: '#FF9800', bgColor: '#fff3e0' };
    } else if (equivKm < 45) {
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
        
        trackItem.innerHTML = `
            <h3 style="color: ${difficulty.color};">Track ${index + 1} <span style="font-size: 12px; font-weight: normal;">(${difficulty.level})</span></h3>
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
            ${segment.markerIndex >= 0 ? `<button class="delete-marker-btn" onclick="deleteMarker(${segment.markerIndex})">Verwijder splitpunt</button>` : ''}
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
    map.removeLayer(splitMarkers[index]);
    splitMarkers.splice(index, 1);
    updateTrackList();
}

// Clear all
function clearAll() {
    if (gpxPolyline) {
        map.removeLayer(gpxPolyline);
        gpxPolyline = null;
    }
    
    segmentPolylines.forEach(poly => map.removeLayer(poly));
    segmentPolylines = [];
    
    splitMarkers.forEach(marker => map.removeLayer(marker));
    splitMarkers = [];
    gpxData = [];
    
    document.getElementById('trackList').innerHTML = '<p class="placeholder">Laad een GPX bestand om te beginnen</p>';
    document.getElementById('addPointBtn').disabled = true;
    document.getElementById('clearBtn').disabled = true;
}

// Event listeners
document.getElementById('gpxFileInput').addEventListener('change', function(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(event) {
        clearAll();
        
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
        
        document.getElementById('addPointBtn').disabled = false;
        document.getElementById('clearBtn').disabled = false;
        
        updateTrackList();
    };
    
    reader.readAsText(file);
});

document.getElementById('addPointBtn').addEventListener('click', function() {
    isAddingPoint = !isAddingPoint;
    this.classList.toggle('active', isAddingPoint);
    this.textContent = isAddingPoint ? 'Klik op de kaart...' : 'Voeg splitpunt toe (klik op kaart)';
});

document.getElementById('clearBtn').addEventListener('click', clearAll);

// Initialize
initMap();
