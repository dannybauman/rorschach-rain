// Rorschach Rain - Decoupled Architecture

const CONFIG = {
    rainViewerApi: 'https://api.rainviewer.com/public/weather-maps.json',
    tileUrlTemplate: 'https://tilecache.rainviewer.com{path}/256/{z}/{x}/{y}/2/1_1.png',
    basemapUrl: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    defaultCenter: [45.5152, -122.6784], // Portland, OR
    defaultZoom: 7
};

/**
 * Global Tile Cache
 * Manages fetching and storing radar tile images.
 */
class TileCache {
    constructor() {
        this.cache = new Map(); // Key: "path-z-x-y", Value: Image
        this.activeRequests = new Set();
    }

    getKey(path, z, x, y) {
        return `${path}-${z}-${x}-${y}`;
    }

    /**
     * Get image if cached, otherwise trigger fetch.
     * Returns Image object (check .complete to see if ready)
     */
    get(path, z, x, y) {
        const key = this.getKey(path, z, x, y);
        if (this.cache.has(key)) {
            return this.cache.get(key);
        }

        if (!this.activeRequests.has(key)) {
            this.fetch(path, z, x, y);
        }
        return null;
    }

    fetch(path, z, x, y) {
        const key = this.getKey(path, z, x, y);
        this.activeRequests.add(key);

        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.src = CONFIG.tileUrlTemplate
            .replace('{path}', path)
            .replace('{z}', z)
            .replace('{x}', x)
            .replace('{y}', y);

        img.onload = () => {
            this.cache.set(key, img);
            this.activeRequests.delete(key);
        };

        img.onerror = () => {
            this.activeRequests.delete(key);
            // Don't cache errors, allow retry
        };
    }

    /**
     * Preload tiles for a list of frames within specific bounds
     */
    preload(frames, map) {
        if (!map) return;

        const zoom = map.getZoom();
        const bounds = map.getBounds();
        const tileSize = 256;
        const nw = map.project(bounds.getNorthWest(), zoom).divideBy(tileSize).floor();
        const se = map.project(bounds.getSouthEast(), zoom).divideBy(tileSize).ceil();

        // Limit preload to avoid network spam
        const maxPreload = 5;

        for (let i = 0; i < Math.min(frames.length, maxPreload); i++) {
            const path = frames[i].path;
            for (let x = nw.x; x < se.x; x++) {
                for (let y = nw.y; y < se.y; y++) {
                    this.get(path, zoom, x, y);
                }
            }
        }
    }
}

const tileCache = new TileCache();

/**
 * L.RorschachLayer
 * Single Canvas Layer driven by a RAF loop.
 * Handles both Radar and Ink Blot rendering modes.
 */
L.RorschachLayer = L.Layer.extend({
    initialize: function(options) {
        this.options = options || {};
        this.timestamp = null;
        this.mode = 'radar'; // 'radar', 'inkblot', 'both'
        this.opacity = 0.8;

        this.canvas = document.createElement('canvas');
        this.canvas.classList.add('rorschach-canvas');

        // Separate canvas for outlines (No Filter, High Z-Index)
        this.outlineCanvas = document.createElement('canvas');
        this.outlineCanvas.style.position = 'absolute';
        this.outlineCanvas.style.top = '0';
        this.outlineCanvas.style.left = '0';
        this.outlineCanvas.style.pointerEvents = 'none';
        this.outlineCanvas.style.zIndex = 600; // Topmost

        this.frame = null;
        this._frameId = null;
        this.outlineSegments = null; // Store segments for rendering
    },

    onAdd: function(map) {
        this.map = map;

        // Create Custom Panes for Layering
        // Rorschach Pane: Below overlays (400) but above tiles (200) -> 250
        if (!map.getPane('rorschachPane')) {
            map.createPane('rorschachPane');
            map.getPane('rorschachPane').style.zIndex = 250;
            map.getPane('rorschachPane').style.pointerEvents = 'none';
        }

        // Outline Pane: Above Rorschach but below markers (600) -> 450
        if (!map.getPane('outlinePane')) {
            map.createPane('outlinePane');
            map.getPane('outlinePane').style.zIndex = 450;
            map.getPane('outlinePane').style.pointerEvents = 'none';
        }

        // Rain Canvas
        this.canvas.style.position = 'absolute';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.pointerEvents = 'none';
        // Append to custom pane
        map.getPane('rorschachPane').appendChild(this.canvas);

        // Outline Canvas
        map.getPane('outlinePane').appendChild(this.outlineCanvas);

        // Offscreen Buffer for composition
        this.buffer = document.createElement('canvas');
        this.bufferCtx = this.buffer.getContext('2d', { willReadFrequently: true });

        // Start Loop
        this._renderLoop();

        // Events
        this.map.on('resize', this._resetCanvas, this);
        this._resetCanvas();
    },

    onRemove: function(map) {
        cancelAnimationFrame(this._frameId);
        if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
        if (this.outlineCanvas.parentNode) this.outlineCanvas.parentNode.removeChild(this.outlineCanvas);
        this.map.off('resize', this._resetCanvas, this);
    },

    setFrame: function(frame) {
        this.frame = frame;
    },

    setMode: function(mode) {
        this.mode = mode;
    },

    setOutlines: function(segments) {
        this.outlineSegments = segments;
    },

    _resetCanvas: function() {
        if (!this.map) return;
        const size = this.map.getSize();

        this.canvas.width = size.x;
        this.canvas.height = size.y;

        this.outlineCanvas.width = size.x;
        this.outlineCanvas.height = size.y;

        this.buffer.width = size.x;
        this.buffer.height = size.y;
    },

    _renderLoop: function() {
        this._render();
        this._frameId = requestAnimationFrame(this._renderLoop.bind(this));
    },

    _render: function() {
        if (!this.map || !this.frame) return;

        // Counter-translate canvases to keep them fixed to the viewport
        // Since they are inside moving panes, we must negate the pane's transform
        const panePos = this.map._getMapPanePos();
        L.DomUtil.setPosition(this.canvas, { x: -panePos.x, y: -panePos.y });
        L.DomUtil.setPosition(this.outlineCanvas, { x: -panePos.x, y: -panePos.y });

        const ctx = this.canvas.getContext('2d');
        const outCtx = this.outlineCanvas.getContext('2d');
        const width = this.canvas.width;
        const height = this.canvas.height;

        // Clear Canvases
        ctx.clearRect(0, 0, width, height);
        outCtx.clearRect(0, 0, width, height);

        // Clear Buffer
        this.bufferCtx.clearRect(0, 0, width, height);

        // 1. Calculate Visible Tiles
        const zoom = this.map.getZoom();
        const bounds = this.map.getBounds();
        const tileSize = 256;
        const nw = this.map.project(bounds.getNorthWest(), zoom).divideBy(tileSize).floor();
        const se = this.map.project(bounds.getSouthEast(), zoom).divideBy(tileSize).ceil();

        let loadedCount = 0;
        let totalCount = 0;

        // 2. Draw Tiles to Buffer
        for (let x = nw.x; x < se.x; x++) {
            for (let y = nw.y; y < se.y; y++) {
                totalCount++;

                const tilePos = this.map.unproject([x * tileSize, y * tileSize], zoom);
                const drawPos = this.map.latLngToContainerPoint(tilePos);

                // Check Cache
                const img = tileCache.get(this.frame.path, zoom, x, y);

                if (img && img.complete && img.naturalWidth > 0) {
                    // Draw Tile
                    this.bufferCtx.drawImage(img, drawPos.x, drawPos.y, tileSize, tileSize);

                    // Draw Coverage Grid (Loaded)
                    ctx.strokeStyle = 'rgba(0, 255, 0, 0.1)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(drawPos.x, drawPos.y, tileSize, tileSize);

                    loadedCount++;
                } else {
                    // Draw Coverage Grid (Loading) - Orange Overlay
                    ctx.fillStyle = 'rgba(255, 165, 0, 0.2)'; // Orange 20%
                    ctx.fillRect(drawPos.x, drawPos.y, tileSize, tileSize);

                    ctx.strokeStyle = 'rgba(255, 165, 0, 0.5)';
                    ctx.lineWidth = 1;
                    ctx.strokeRect(drawPos.x, drawPos.y, tileSize, tileSize);
                }
            }
        }

        // 3. Apply Effects based on Mode
        if (this.mode === 'radar') {
            // Just draw buffer to main
            ctx.globalAlpha = 0.8;
            ctx.drawImage(this.buffer, 0, 0);
        }
        else if (this.mode === 'inkblot') {
            this._applyInkEffect(ctx, width, height);
        }
        else if (this.mode === 'both') {
            // Draw Radar Layer
            ctx.globalAlpha = 0.5;
            ctx.drawImage(this.buffer, 0, 0);

            // Draw Ink Layer on top
            this._applyInkEffect(ctx, width, height);
        }

        // 4. Draw Outlines (if any)
        if (this.outlineSegments && this.outlineSegments.length > 0) {
            outCtx.strokeStyle = '#FF0000';
            outCtx.lineWidth = 5;
            outCtx.lineCap = 'round';
            outCtx.lineJoin = 'round';
            outCtx.shadowColor = '#FF0000';
            outCtx.shadowBlur = 10;

            outCtx.beginPath();
            for (const seg of this.outlineSegments) {
                // seg is [p1, p2] where p1, p2 are LatLngs
                const p1 = this.map.latLngToContainerPoint(seg[0]);
                const p2 = this.map.latLngToContainerPoint(seg[1]);

                outCtx.moveTo(p1.x, p1.y);
                outCtx.lineTo(p2.x, p2.y);
            }
            outCtx.stroke();
        }

        // Update Status via global App (hacky but effective for this scale)
        if (window.app) {
            if (loadedCount === totalCount && totalCount > 0) {
                window.app.updateStatus('ONLINE', false);
            } else {
                window.app.updateStatus('SCANNING...', true);
            }
        }
    },

    _applyInkEffect: function(ctx, width, height) {
        // 1. Get Pixel Data from Buffer (Raw Radar)
        const imgData = this.bufferCtx.getImageData(0, 0, width, height);
        const data = imgData.data;

        // 2. Threshold & Flatten (Isolation)
        // Turn any rain pixel into Pure White
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] > 0) { // If Alpha > 0
                data[i] = 255;     // R
                data[i + 1] = 255; // G
                data[i + 2] = 255; // B
                data[i + 3] = 255; // Full Alpha
            }
        }

        // 3. Put modified data back to buffer (or a temp canvas)
        // We can reuse bufferCtx since we already read from it and won't need raw radar again this frame
        this.bufferCtx.putImageData(imgData, 0, 0);

        // 4. Draw to Main Canvas with Filters (Liquify)
        ctx.save();
        ctx.globalAlpha = this.mode === 'both' ? 0.8 : 0.9;

        // The Magic Combo: Blur + Contrast
        // Blur spreads the white pixels. Contrast chokes the gradient, creating organic blobs.
        ctx.filter = 'blur(3px) contrast(200%)';

        // Draw the white blobs
        ctx.drawImage(this.buffer, 0, 0);

        ctx.restore();
    },

    // New: Extract outlines using Marching Squares
    getOutlines: function(clippingBounds) {
        const width = this.buffer.width;
        const height = this.buffer.height;

        // Higher resolution for better accuracy (0.75 instead of 0.5)
        const scale = 0.75;
        const smWidth = Math.floor(width * scale);
        const smHeight = Math.floor(height * scale);

        const smCanvas = document.createElement('canvas');
        smCanvas.width = smWidth;
        smCanvas.height = smHeight;
        const smCtx = smCanvas.getContext('2d');

        // Draw the buffer with the blur filter applied
        // Increased blur and contrast to merge blobs and catch faint edges
        // Increased blur from 4px to 8px for much looser, organic shapes
        smCtx.filter = 'blur(8px) contrast(400%)';
        smCtx.drawImage(this.buffer, 0, 0, smWidth, smHeight);

        // --- SMART CLIPPING ---
        // If clippingBounds provided (in container pixels), clear everything outside it.
        // This forces the marching squares to see a "cut" edge.
        if (clippingBounds) {
            // clippingBounds: { minX, minY, maxX, maxY }
            // Scale to smCanvas coords
            const minX = clippingBounds.minX * scale;
            const minY = clippingBounds.minY * scale;
            const maxX = clippingBounds.maxX * scale;
            const maxY = clippingBounds.maxY * scale;

            smCtx.globalCompositeOperation = 'destination-in';
            smCtx.fillStyle = '#000';
            smCtx.beginPath();
            smCtx.rect(minX, minY, maxX - minX, maxY - minY);
            smCtx.fill();
            smCtx.globalCompositeOperation = 'source-over'; // Reset
        }

        const imgData = smCtx.getImageData(0, 0, smWidth, smHeight);
        const data = imgData.data;

        // Marching Squares Implementation
        // Lower threshold (60/255 approx 23%) to catch even fainter "ink"
        const threshold = 60;
        const segments = []; // Store line segments [x1, y1, x2, y2]
        let minX = smWidth, minY = smHeight, maxX = 0, maxY = 0;
        let hasShape = false;

        const getState = (x, y) => {
            if (x < 0 || y < 0 || x >= smWidth || y >= smHeight) return 0;
            const idx = (y * smWidth + x) * 4;
            return data[idx + 3] > threshold ? 1 : 0;
        };

        // Lookup table for lines (x1,y1 to x2,y2 relative to cell)
        const lines = [
            [], // 0
            [[0, 0.5], [0.5, 1]], // 1: BL
            [[0.5, 1], [1, 0.5]], // 2: BR
            [[0, 0.5], [1, 0.5]], // 3: BL + BR (Horizontal)
            [[0.5, 0], [1, 0.5]], // 4: TR
            [[0, 0.5], [0.5, 0], [0.5, 1], [1, 0.5]], // 5: BL + TR (Saddle)
            [[0.5, 0], [0.5, 1]], // 6: BR + TR (Vertical)
            [[0, 0.5], [0.5, 0]], // 7: BL + BR + TR (Corner cut)
            [[0, 0.5], [0.5, 0]], // 8: TL
            [[0.5, 0], [0.5, 1]], // 9: TL + BL (Vertical)
            [[0.5, 0], [1, 0.5], [0, 0.5], [0.5, 1]], // 10: TL + BR (Saddle)
            [[0.5, 0], [1, 0.5]], // 11: TL + BL + BR
            [[0, 0.5], [1, 0.5]], // 12: TL + TR (Horizontal)
            [[0.5, 1], [1, 0.5]], // 13: TL + TR + BL
            [[0, 0.5], [0.5, 1]], // 14: TL + TR + BR
            [] // 15
        ];

        for (let y = 0; y < smHeight - 1; y++) {
            for (let x = 0; x < smWidth - 1; x++) {
                const tl = getState(x, y);
                const tr = getState(x + 1, y);
                const br = getState(x + 1, y + 1);
                const bl = getState(x, y + 1);

                const index = (tl * 8) + (tr * 4) + (br * 2) + (bl * 1);

                if (index === 0 || index === 15) continue;

                hasShape = true;
                const segs = lines[index];

                for (let i = 0; i < segs.length; i++) {
                    if (i + 1 < segs.length) {
                         const p1 = segs[i];
                         const p2 = segs[i+1];

                         // Scale up to screen coords
                         const x1 = (x + p1[0]) / scale;
                         const y1 = (y + p1[1]) / scale;
                         const x2 = (x + p2[0]) / scale;
                         const y2 = (y + p2[1]) / scale;

                         segments.push([x1, y1, x2, y2]);
                         i++;

                         // Update bounds
                         minX = Math.min(minX, x1, x2);
                         minY = Math.min(minY, y1, y2);
                         maxX = Math.max(maxX, x1, x2);
                         maxY = Math.max(maxY, y1, y2);
                    }
                }
            }
        }

        if (hasShape) {
            // Convert segments to LatLngs
            // For a Polyline, we ideally want a continuous path, but a "soup of segments"
            // works if we use a MultiPolyline (array of arrays of latlngs).
            // Leaflet handles [ [latlng, latlng], [latlng, latlng] ] fine.

            const latLngSegments = segments.map(seg => {
                const p1 = this.map.containerPointToLatLng([seg[0], seg[1]]);
                const p2 = this.map.containerPointToLatLng([seg[2], seg[3]]);
                return [p1, p2];
            });

            const cx = minX + (maxX - minX) / 2;
            const cy = minY + (maxY - minY) / 2;
            const centerLatLng = this.map.containerPointToLatLng([cx, cy]);

            return {
                segments: latLngSegments,
                center: centerLatLng
            };
        }

        return null;
    }
});

/**
 * Shape Analysis & Heuristics
 * Analyzes geometric properties of a blob to determine what it "looks like".
 */
const RorschachDictionary = {
    // Categories based on shape traits
    round: [
        { label: "MOON", icon: "🌑" },
        { label: "COIN", icon: "🪙" },
        { label: "SHIELD", icon: "🛡️" },
        { label: "FACE", icon: "🙂" },
        { label: "PLANET", icon: "🪐" },
        { label: "EGG", icon: "🥚" },
        { label: "TURTLE", icon: "🐢" },
        { label: "BEETLE", icon: "🪲" },
        { label: "BALLOON", icon: "🎈" },
        { label: "PEARL", icon: "🦪" },
        { label: "BUBBLE", icon: "🫧" },
        { label: "MARBLE", icon: "🔮" },
        { label: "YOLK", icon: "🍳" },
        { label: "DOME", icon: "🏛️" },
        { label: "IGLOO", icon: "🛖" },
        { label: "JELLYFISH", icon: "🪼" }
    ],
    elongated: [
        { label: "SNAKE", icon: "🐍" },
        { label: "RIVER", icon: "🌊" },
        { label: "WORM", icon: "🪱" },
        { label: "SWORD", icon: "⚔️" },
        { label: "LIGHTNING", icon: "⚡" },
        { label: "DNA", icon: "🧬" },
        { label: "GIRAFFE", icon: "🦒" },
        { label: "VINE", icon: "🌿" },
        { label: "COMET", icon: "☄️" },
        { label: "TOWER", icon: "🗼" },
        { label: "CIGAR", icon: "🚬" },
        { label: "FLUTE", icon: "🪈" },
        { label: "ICICLE", icon: "🧊" },
        { label: "NEEDLE", icon: "🪡" },
        { label: "OBELISK", icon: "🗿" },
        { label: "STREAM", icon: "💧" }
    ],
    spiky: [
        { label: "EXPLOSION", icon: "💥" },
        { label: "MONSTER", icon: "👹" },
        { label: "SPLASH", icon: "💦" },
        { label: "TREE", icon: "🌲" },
        { label: "DRAGON", icon: "🐉" },
        { label: "CROWN", icon: "👑" },
        { label: "CACTUS", icon: "🌵" },
        { label: "STAR", icon: "⭐" },
        { label: "DEMON", icon: "👿" },
        { label: "SHARD", icon: "💎" },
        { label: "THORN", icon: "🌹" },
        { label: "SHURIKEN", icon: "💠" },
        { label: "URCHIN", icon: "🦔" },
        { label: "MACE", icon: "🔨" },
        { label: "CRACK", icon: "🏚️" }
    ],
    tiny: [
        { label: "BUG", icon: "🪲" },
        { label: "DOT", icon: "⚫" },
        { label: "PEBBLE", icon: "🪨" },
        { label: "SEED", icon: "🌱" },
        { label: "ANT", icon: "🐜" },
        { label: "BERRY", icon: "🫐" },
        { label: "ATOM", icon: "⚛️" },
        { label: "SPECK", icon: "🌫️" },
        { label: "CRUMB", icon: "🍪" },
        { label: "PIXEL", icon: "👾" },
        { label: "FLEA", icon: "🦗" },
        { label: "SPARK", icon: "✨" },
        { label: "DROPLET", icon: "💧" }
    ],
    huge: [
        { label: "WHALE", icon: "🐋" },
        { label: "MOUNTAIN", icon: "⛰️" },
        { label: "TITAN", icon: "🗿" },
        { label: "FOREST", icon: "🌳" },
        { label: "CITY", icon: "🏙️" },
        { label: "ELEPHANT", icon: "🐘" },
        { label: "GALAXY", icon: "🌌" },
        { label: "LEVIATHAN", icon: "🦑" },
        { label: "KAIJU", icon: "🦖" },
        { label: "ASTEROID", icon: "☄️" },
        { label: "CONTINENT", icon: "🗺️" },
        { label: "GLACIER", icon: "❄️" },
        { label: "MONOLITH", icon: "⬛" }
    ],
    generic: [
        { label: "RABBIT", icon: "🐰" },
        { label: "BUTTERFLY", icon: "🦋" },
        { label: "GHOST", icon: "👻" },
        { label: "SKULL", icon: "💀" },
        { label: "BIRD", icon: "🐦" },
        { label: "FISH", icon: "🐟" },
        { label: "BAT", icon: "🦇" },
        { label: "MASK", icon: "🎭" },
        { label: "INKBLOT", icon: "🎨" },
        { label: "SHADOW", icon: "👤" },
        { label: "STAIN", icon: "☕" },
        { label: "SILHOUETTE", icon: "👥" },
        { label: "PHANTOM", icon: "👻" },
        { label: "MIRAGE", icon: "🏝️" },
        { label: "ECHO", icon: "🔊" }
    ]
};

class ShapeAnalyzer {
    static analyze(blob, viewBounds) {
        if (!blob || !blob.segments || blob.segments.length === 0) return null;

        // 1. Calculate Metrics
        let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
        let perimeter = 0;

        blob.segments.forEach(seg => {
            // seg is [LatLng, LatLng]
            const p1 = seg[0];
            const p2 = seg[1];

            minLat = Math.min(minLat, p1.lat, p2.lat);
            maxLat = Math.max(maxLat, p1.lat, p2.lat);
            minLng = Math.min(minLng, p1.lng, p2.lng);
            maxLng = Math.max(maxLng, p1.lng, p2.lng);

            // Rough Euclidean distance for perimeter (ignoring projection distortion for simplicity)
            const dLat = p2.lat - p1.lat;
            const dLng = p2.lng - p1.lng;
            perimeter += Math.sqrt(dLat*dLat + dLng*dLng);
        });

        const latSpan = maxLat - minLat;
        const lngSpan = maxLng - minLng;
        const boxPerimeter = 2 * (latSpan + lngSpan);

        // Metrics
        const aspectRatio = Math.max(latSpan, lngSpan) / Math.min(latSpan, lngSpan);
        const magnitude = Math.sqrt(latSpan*latSpan + lngSpan*lngSpan);

        // Ruggedness: Ratio of actual path length to bounding box perimeter
        const ruggedness = perimeter / boxPerimeter;

        // Normalize Magnitude against View Bounds
        let normalizedMagnitude = 0.5; // Default if no bounds
        if (viewBounds) {
            const viewLatSpan = viewBounds.getNorth() - viewBounds.getSouth();
            const viewLngSpan = viewBounds.getEast() - viewBounds.getWest();
            const viewDiagonal = Math.sqrt(viewLatSpan*viewLatSpan + viewLngSpan*viewLngSpan);
            normalizedMagnitude = magnitude / viewDiagonal;
        }

        let category = 'generic';
        let adjective = '';

        // Adjective Logic (Scaled)
        // Tiny: < 10% of screen diagonal
        // Huge: > 60% of screen diagonal
        if (normalizedMagnitude < 0.1) {
            category = 'tiny';
            adjective = ['TINY', 'LITTLE', 'SMALL', 'MICRO'][Math.floor(Math.random()*4)];
        } else if (normalizedMagnitude > 0.6) {
            category = 'huge';
            adjective = ['GIANT', 'MASSIVE', 'COLOSSAL', 'MEGA'][Math.floor(Math.random()*4)];
        } else if (aspectRatio > 2.5) {
            category = 'elongated';
            adjective = ['LONG', 'STRETCHED', 'TALL', 'THIN'][Math.floor(Math.random()*4)];
        } else if (ruggedness > 1.5) {
            category = 'spiky';
            adjective = ['JAGGED', 'TWISTED', 'SHARP', 'SPIKY'][Math.floor(Math.random()*4)];
        } else {
            category = 'round';
            adjective = ['ROUND', 'SMOOTH', 'SOFT', 'CURVED'][Math.floor(Math.random()*4)];
        }

        // Select random item from category
        const options = RorschachDictionary[category];
        const result = options[Math.floor(Math.random() * options.length)];

        return {
            ...result,
            adjective: adjective,
            metrics: { magnitude, normalizedMagnitude, aspectRatio, ruggedness, category }
        };
    }
}


/**
 * Main Application Controller
 */
class App {
    constructor() {
        this.map = null;
        this.rorschachLayer = null;
        this.frames = []; // Array of { time, path }
        this.currentFrameIndex = 0;
        this.isPlaying = false;
        this.playInterval = null;

        this.init();
    }

    async init() {
        this.initMap();
        this.initUI();
        await this.loadRadarData();
    }

    initMap() {
        this.map = L.map('map', {
            zoomControl: false,
            attributionControl: false,
            fadeAnimation: false
        }).setView(CONFIG.defaultCenter, CONFIG.defaultZoom);

        L.tileLayer(CONFIG.basemapUrl, {
            subdomains: 'abcd',
            maxZoom: 19
        }).addTo(this.map);

        L.control.zoom({ position: 'topright' }).addTo(this.map);

        // Initialize our single custom layer
        this.rorschachLayer = new L.RorschachLayer();
        this.rorschachLayer.addTo(this.map);
    }

    initUI() {
        document.getElementById('btn-radar').addEventListener('click', () => this.setMode('radar'));
        document.getElementById('btn-inkblot').addEventListener('click', () => this.setMode('inkblot'));
        document.getElementById('btn-both').addEventListener('click', () => this.setMode('both'));

        // Analysis Mode Toggle (Old buttons removed, logic moved to cards)
        // document.getElementById('btn-mode-local').addEventListener('click', () => this.setAnalysisMode('local'));
        // document.getElementById('btn-mode-cloud').addEventListener('click', () => this.setAnalysisMode('cloud'));

        document.getElementById('color-scheme').addEventListener('change', (e) => this.setTheme(e.target.value));
        document.getElementById('crt-intensity').addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            const root = document.documentElement;

            // Map 0-100 to various effect ranges
            const scanlineOpacity = 0.05 + (val / 100) * 0.4; // 0.05 to 0.45
            const glowStrength = (val / 100) * 50; // 0 to 50px
            const textGlow = (val / 100) * 10; // 0 to 10px
            const brightness = 0.8 + (val / 100) * 0.4; // 0.8 to 1.2

            root.style.setProperty('--scanline-opacity', scanlineOpacity);
            root.style.setProperty('--screen-glow', `0 0 ${glowStrength}px`);
            root.style.setProperty('--text-glow', `0 0 ${textGlow}px`);
            root.style.setProperty('--brightness', brightness);
        });

        const scrubber = document.getElementById('time-scrubber');
        scrubber.addEventListener('input', (e) => {
            this.showFrame(parseInt(e.target.value));
            this.stopAnimation();
        });

        document.getElementById('btn-play').addEventListener('click', () => this.toggleAnimation());

        // New Identify Button (Initiate Scan)
        document.getElementById('btn-initiate').addEventListener('click', () => this.identifyObject());

        // Selection Tool
        document.getElementById('btn-select').addEventListener('click', () => this.toggleSelectionMode());
        this.initSelectionTool();

        // New Analysis Cards
        document.getElementById('card-local').addEventListener('click', () => this.selectAnalysisCard('local'));
        document.getElementById('card-cloud').addEventListener('click', () => this.selectAnalysisCard('cloud'));

        // Collapsible Menu Toggle
        const toggleBtn = document.getElementById('btn-toggle-menu');
        const panel = document.querySelector('.controls-panel');
        toggleBtn.addEventListener('click', () => {
            panel.classList.toggle('collapsed');
            toggleBtn.textContent = panel.classList.contains('collapsed') ? '[ MENU ]' : '[ HIDE ]';
        });

        // Lock Selection Button (Mobile)
        document.getElementById('btn-lock-selection').addEventListener('click', () => {
            if (this.isSelectionMode) {
                this.toggleSelectionMode(); // Exit selection mode
            }
        });

        // Escape Key to Cancel Selection
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isSelectionMode) {
                this.toggleSelectionMode();
            }
        });

        // Exit Analysis Button (Panel Close)
        const exitAnalysisBtn = document.getElementById('btn-exit-analysis');
        if (exitAnalysisBtn) {
            exitAnalysisBtn.addEventListener('click', () => {
                // If in selection mode, exit it (which clears selection and hides panel)
                if (this.isSelectionMode) {
                    this.toggleSelectionMode();
                } else {
                    // Just clear selection if for some reason we are not in mode but panel is open
                    this.clearSelection();
                }
            });
        }
    }

    selectAnalysisCard(mode) {
        this.analysisMode = mode;

        // UI Updates
        document.querySelectorAll('.data-card').forEach(c => c.classList.remove('active'));
        document.getElementById(`card-${mode}`).classList.add('active');

        // Show/Hide API Input
        const apiContainer = document.getElementById('api-key-container');
        if (mode === 'cloud') {
            apiContainer.style.display = 'block';
        } else {
            apiContainer.style.display = 'none';
        }

        // Enable Initiate Button
        document.getElementById('btn-initiate').disabled = false;
    }

    initSelectionTool() {
        this.isSelecting = false;
        this.isDraggingSelection = false;
        this.isResizingSelection = false;
        this.resizeHandleIndex = -1; // 0:TL, 1:TR, 2:BR, 3:BL

        this.selectionStartLatLng = null;
        this.selectionBoundsLatLng = null; // L.LatLngBounds

        this.selectionLayer = null; // L.Rectangle
        this.resizeHandles = []; // Array of L.Marker

        // Map Events for Drawing
        this.map.on('mousedown', (e) => this.onMapMouseDown(e));
        this.map.on('mousemove', (e) => this.onMapMouseMove(e));
        this.map.on('mouseup', (e) => this.onMapMouseUp(e));

        // Touch Support (Native DOM Events)
        const mapContainer = this.map.getContainer();
        mapContainer.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        mapContainer.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        mapContainer.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
    }

    toggleSelectionMode() {
        this.isSelectionMode = !this.isSelectionMode;
        const btn = document.getElementById('btn-select');
        const container = document.querySelector('.crt-container');

        if (this.isSelectionMode) {
            btn.classList.add('active');
            // Update text if re-selecting
            if (this.selectionLayer) {
                btn.textContent = 'RE-SELECT AREA';
            } else {
                btn.textContent = 'CANCEL SELECTION';
            }

            this.map.dragging.disable();
            container.style.cursor = 'crosshair';

            // Auto-Hide Menu: Only on Mobile
            const panel = document.querySelector('.controls-panel');
            const toggleBtn = document.getElementById('btn-toggle-menu');
            const lockBtn = document.getElementById('btn-lock-selection');

            if (window.innerWidth <= 768) {
                if (panel) {
                    panel.classList.add('collapsed');
                    if (toggleBtn) toggleBtn.textContent = '[ MENU ]';
                }
                // Show Lock Button on Mobile
                if (lockBtn) lockBtn.style.display = 'block';
            }

            // If we already have a selection, keep it, but enable editing interactions
            if (this.selectionLayer) {
                this.showResizeHandles();
            }

        } else {
            btn.classList.remove('active');

            // Restore text based on state
            if (this.selectionLayer) {
                btn.textContent = 'RE-SELECT AREA';
            } else {
                btn.textContent = 'SELECT TARGET AREA';
            }

            this.map.dragging.enable();
            container.style.cursor = 'default';
            this.hideResizeHandles();

            // Restore Menu on Mobile if it was hidden
            const panel = document.querySelector('.controls-panel');
            const toggleBtn = document.getElementById('btn-toggle-menu');
            const lockBtn = document.getElementById('btn-lock-selection');

            if (window.innerWidth <= 768) {
                if (panel) {
                    panel.classList.remove('collapsed');
                    if (toggleBtn) toggleBtn.textContent = '[ HIDE ]';
                }
                // Hide Lock Button
                if (lockBtn) lockBtn.style.display = 'none';
            }
        }
    }

    // Touch Event Handlers
    onTouchStart(e) {
        if (!this.isSelectionMode || e.touches.length !== 1) return;
        e.preventDefault(); // Stop map panning/zooming

        const touch = e.touches[0];
        const containerPoint = this.map.mouseEventToContainerPoint(touch);
        const latlng = this.map.containerPointToLatLng(containerPoint);

        // Mock Leaflet Event
        this.onMapMouseDown({ latlng: latlng, originalEvent: e });
    }

    onTouchMove(e) {
        if (!this.isSelectionMode || e.touches.length !== 1) return;
        e.preventDefault();

        const touch = e.touches[0];
        const containerPoint = this.map.mouseEventToContainerPoint(touch);
        const latlng = this.map.containerPointToLatLng(containerPoint);

        this.onMapMouseMove({ latlng: latlng, originalEvent: e });
    }

    onTouchEnd(e) {
        if (!this.isSelectionMode) return;
        // e.preventDefault(); // Optional, might block click emulation

        // We don't have coordinates in touchend, but onMapMouseUp doesn't strictly need them
        // unless it's using them for logic. It uses this.selectionLayer.getBounds().
        this.onMapMouseUp({ originalEvent: e });
    }

    onMapMouseDown(e) {
        if (!this.isSelectionMode) return;

        // Check if we clicked a handle (Resize)
        // Note: Handle click events usually fire before map events if we set them up right.
        // But since we are using map events globally, we might need to check target.
        // Actually, let's rely on the handle's own event listeners if possible,
        // but for simplicity in this "God Class", let's check state.

        if (this.isResizingSelection) return; // Already handled by handle event

        // Check if we clicked inside existing selection (Move)
        if (this.selectionLayer && this.selectionLayer.getBounds().contains(e.latlng)) {
            this.isDraggingSelection = true;
            this.selectionDragStart = e.latlng;
            this.selectionDragBoundsStart = this.selectionLayer.getBounds();
            this.map.dragging.disable();
            return;
        }

        // Otherwise, Start Drawing New
        this.isSelecting = true;
        this.selectionStartLatLng = e.latlng;

        // Clear old
        this.clearSelection();

        // Create new rect (initially zero size)
        this.selectionLayer = L.rectangle([e.latlng, e.latlng], {
            color: '#00ff41',
            weight: 1,
            dashArray: '5, 5',
            fillOpacity: 0.1,
            className: 'selection-rect' // We can style this if needed
        }).addTo(this.map);
    }

    onMapMouseMove(e) {
        if (this.isSelecting) {
            // Update Draw
            const bounds = L.latLngBounds(this.selectionStartLatLng, e.latlng);
            this.selectionLayer.setBounds(bounds);
        } else if (this.isDraggingSelection) {
            // Update Move
            const latDiff = e.latlng.lat - this.selectionDragStart.lat;
            const lngDiff = e.latlng.lng - this.selectionDragStart.lng;

            const sw = this.selectionDragBoundsStart.getSouthWest();
            const ne = this.selectionDragBoundsStart.getNorthEast();

            const newBounds = L.latLngBounds(
                [sw.lat + latDiff, sw.lng + lngDiff],
                [ne.lat + latDiff, ne.lng + lngDiff]
            );

            this.selectionLayer.setBounds(newBounds);
            this.updateResizeHandles();
        } else if (this.isResizingSelection) {
            // Update Resize
            this.handleResize(e.latlng);
        }
    }

    onMapMouseUp(e) {
        if (this.isSelecting) {
            this.isSelecting = false;
            this.selectionBoundsLatLng = this.selectionLayer.getBounds();
            this.showResizeHandles();

            // Show Analysis Panel
            document.getElementById('analysis-panel').style.display = 'block';
            document.getElementById('btn-select').textContent = 'RE-SELECT AREA';

            // Auto-exit selection mode? User might want to tweak. Let's stay in mode.
        }

        if (this.isDraggingSelection) {
            this.isDraggingSelection = false;
            this.selectionBoundsLatLng = this.selectionLayer.getBounds();
        }

        if (this.isResizingSelection) {
            this.isResizingSelection = false;
            this.selectionBoundsLatLng = this.selectionLayer.getBounds();
            this.map.dragging.disable(); // Ensure map drag stays off
        }
    }

    clearSelection() {
        if (this.selectionLayer) {
            this.map.removeLayer(this.selectionLayer);
            this.selectionLayer = null;
        }
        this.hideResizeHandles();
        this.selectionBoundsLatLng = null;
        this.selectionBounds = null; // Clear old pixel bounds

        // Reset UI
        document.getElementById('analysis-panel').style.display = 'none';
        document.getElementById('btn-select').textContent = 'SELECT TARGET AREA';

        // Reset Analysis State
        this.analysisMode = null;
        document.querySelectorAll('.data-card').forEach(c => c.classList.remove('active'));
        document.getElementById('btn-initiate').disabled = true;
        document.getElementById('api-key-container').style.display = 'none';
    }

    // --- Resize Handles ---

    createResizeHandle(index) {
        const icon = L.divIcon({
            className: 'resize-handle',
            iconSize: [10, 10],
            iconAnchor: [5, 5]
        });

        const marker = L.marker([0,0], { icon: icon, draggable: false }).addTo(this.map);

        // Handle Interaction
        const element = marker.getElement();
        element.addEventListener('mousedown', (e) => {
            if (!this.isSelectionMode) return;
            L.DomEvent.stopPropagation(e); // Prevent map draw
            this.isResizingSelection = true;
            this.resizeHandleIndex = index;
            this.map.dragging.disable();
        });

        return marker;
    }

    showResizeHandles() {
        this.hideResizeHandles();
        if (!this.selectionLayer) return;

        // Create 4 handles
        for (let i = 0; i < 4; i++) {
            this.resizeHandles.push(this.createResizeHandle(i));
        }
        this.updateResizeHandles();
    }

    hideResizeHandles() {
        this.resizeHandles.forEach(h => this.map.removeLayer(h));
        this.resizeHandles = [];
    }

    updateResizeHandles() {
        if (!this.selectionLayer || this.resizeHandles.length !== 4) return;

        const bounds = this.selectionLayer.getBounds();
        const nw = bounds.getNorthWest();
        const ne = bounds.getNorthEast();
        const se = bounds.getSouthEast();
        const sw = bounds.getSouthWest();

        // 0:TL, 1:TR, 2:BR, 3:BL
        this.resizeHandles[0].setLatLng(nw);
        this.resizeHandles[1].setLatLng(ne);
        this.resizeHandles[2].setLatLng(se);
        this.resizeHandles[3].setLatLng(sw);
    }

    handleResize(cursorLatLng) {
        const bounds = this.selectionLayer.getBounds();
        let nw = bounds.getNorthWest();
        let se = bounds.getSouthEast();

        // 0:TL, 1:TR, 2:BR, 3:BL
        // Simple logic: Update the corner we are dragging, keep opposite corner fixed

        if (this.resizeHandleIndex === 0) { // Dragging TL -> Fix BR (SE)
            this.selectionLayer.setBounds(L.latLngBounds(cursorLatLng, se));
        } else if (this.resizeHandleIndex === 1) { // Dragging TR -> Fix BL
            const bl = bounds.getSouthWest();
            // New TR is cursor. Fixed BL is bl.
            // But LatLngBounds constructor takes corners.
            // We need to construct bounds from (Cursor.lat, Cursor.lng) and (BL.lat, BL.lng)
            // Wait, TR means Lat is North, Lng is East.
            // Cursor is new TR.
            // Fixed point is BL.
            this.selectionLayer.setBounds(L.latLngBounds(cursorLatLng, bl));
        } else if (this.resizeHandleIndex === 2) { // Dragging BR -> Fix TL (NW)
            this.selectionLayer.setBounds(L.latLngBounds(nw, cursorLatLng));
        } else if (this.resizeHandleIndex === 3) { // Dragging BL -> Fix TR
            const tr = bounds.getNorthEast();
            this.selectionLayer.setBounds(L.latLngBounds(cursorLatLng, tr));
        }

        this.updateResizeHandles();
    }

    updateSelectionBox(currentX, currentY) {
        // Deprecated DOM method
    }

    setAnalysisMode(mode) {
        this.analysisMode = mode;
        document.getElementById('btn-mode-local').classList.toggle('active', mode === 'local');
        document.getElementById('btn-mode-cloud').classList.toggle('active', mode === 'cloud');

        // Show/Hide API Key Input
        const apiKeyGroup = document.getElementById('api-key-group');
        apiKeyGroup.style.display = mode === 'cloud' ? 'block' : 'none';
    }

    showLoading(centerLatLng) {
        const overlay = document.getElementById('result-overlay');
        const content = overlay.querySelector('.result-content');
        const iconEl = overlay.querySelector('.result-icon');
        const textEl = overlay.querySelector('.result-text');
        const closeBtn = overlay.querySelector('.close-result');

        // Reset content for loading state
        iconEl.innerHTML = '⚙️'; // Gear or Radar icon
        iconEl.className = 'result-icon spin'; // Add spin class
        textEl.textContent = 'ANALYZING PATTERN...';

        // Smart Positioning (Desktop Only)
        if (centerLatLng && window.innerWidth > 768) {
            const point = this.map.latLngToContainerPoint(centerLatLng);
            const overlayWidth = 320; // Approx width
            const overlayHeight = 200; // Approx height

            // Default: Right of selection
            let left = point.x + 100; // Offset from center
            let top = point.y - (overlayHeight / 2);

            // Check if too far right
            if (left + overlayWidth > window.innerWidth) {
                // Move to Left
                left = point.x - overlayWidth - 100;
            }

            // Check vertical bounds
            if (top < 80) top = 80; // Below header
            if (top + overlayHeight > window.innerHeight) top = window.innerHeight - overlayHeight - 20;

            overlay.style.top = `${top}px`;
            overlay.style.left = `${left}px`;
            overlay.style.right = 'auto'; // Clear default right
            overlay.style.bottom = 'auto';
        } else {
            // Reset to CSS defaults (Mobile or fallback)
            overlay.style.top = '';
            overlay.style.left = '';
            overlay.style.right = '';
            overlay.style.bottom = '';
        }

        overlay.style.display = 'flex';

        // Temporary close handler in case it gets stuck
        const closeHandler = () => {
            overlay.style.display = 'none';
            iconEl.classList.remove('spin');
            closeBtn.removeEventListener('click', closeHandler);
        };
        closeBtn.addEventListener('click', closeHandler);
    }

    identifyObject() {
        if (this.rorschachLayer.mode === 'radar') {
            // Auto-switch to Ink Blot mode
            this.setMode('inkblot');
            document.getElementById('btn-inkblot').click(); // Update UI state visually if needed, or just setMode
            // Actually, clicking the button handles setMode AND UI active state.
            // But we are inside the class. Let's just call the button click to be safe and simple.
        }

        // Determine Center for Loading Positioning
        let center = this.map.getCenter();
        if (this.selectionLayer) {
            center = this.selectionLayer.getBounds().getCenter();
        }

        // Show Loading State Immediately (with positioning)
        this.showLoading(center);

        // Auto-Hide Menu on Mobile (UX Improvement)
        if (window.innerWidth <= 768) {
            const panel = document.querySelector('.controls-panel');
            const toggleBtn = document.getElementById('btn-toggle-menu');
            if (panel) {
                panel.classList.add('collapsed');
                if (toggleBtn) toggleBtn.textContent = '[ MENU ]';
            }
        }

        // Clear previous interpretation
        if (this.outlineLayer) {
            this.map.removeLayer(this.outlineLayer);
            this.outlineLayer = null;
        }
        if (this.labelMarker) {
            this.map.removeLayer(this.labelMarker);
            this.labelMarker = null;
        }
        if (this.sketchLayer) {
            this.map.removeLayer(this.sketchLayer);
            this.sketchLayer = null;
        }

        // Clear canvas outlines
        this.rorschachLayer.setOutlines(null);

        // Small delay to let the UI update before heavy processing
        setTimeout(() => {
            if (this.analysisMode === 'cloud') {
                this.analyzeWithGemini();
            } else {
                this.analyzeLocal();
            }
        }, 100);
    }

    analyzeLocal() {
        this.updateStatus('ANALYZING...', true);

        // 0. Resolve Selection Bounds (Pixels)
        let clippingBounds = null;
        if (this.selectionLayer) {
            const bounds = this.selectionLayer.getBounds();
            const nw = this.map.latLngToContainerPoint(bounds.getNorthWest());
            const se = this.map.latLngToContainerPoint(bounds.getSouthEast());
            clippingBounds = {
                minX: Math.min(nw.x, se.x),
                minY: Math.min(nw.y, se.y),
                maxX: Math.max(nw.x, se.x),
                maxY: Math.max(nw.y, se.y),
                w: Math.abs(nw.x - se.x),
                h: Math.abs(nw.y - se.y)
            };
        }

        // 1. Get Blob Data (Segments + Center) - WITH CLIPPING
        const blob = this.rorschachLayer.getOutlines(clippingBounds);

        if (!blob) {
            this.updateStatus('NO SHAPE DETECTED', false);
            setTimeout(() => this.updateStatus('ONLINE', false), 2000);
            return;
        }

        // 2. Mock AI Delay
        setTimeout(() => {
            // 3. Analyze Shape using Heuristics
            // Pass current map bounds for normalization
            const viewBounds = this.map.getBounds();
            let result = ShapeAnalyzer.analyze(blob, viewBounds);

            if (!result) {
                // Fallback if analysis fails
                result = { label: "UNKNOWN", icon: "❓" };
            }

            // 4. Show Overlay (Leaflet Layers)
            this.showInterpretation(blob, result);
            this.updateStatus('ANALYSIS COMPLETE', false);
        }, 800); // Faster than 1500ms since it's local
    }

    // Helper not needed anymore if we clip in getOutlines
    // filterBlobBySelection(blob, bounds) { ... }

    async analyzeWithGemini() {
        const apiKey = document.getElementById('api-key-input').value.trim();
        if (!apiKey) {
            alert("Please enter a valid Gemini API Key for Cloud Analysis.");
            return;
        }

        // 0. Resolve Selection Bounds (Pixels)
        let clippingBounds = null;
        if (this.selectionLayer) {
            const bounds = this.selectionLayer.getBounds();
            const nw = this.map.latLngToContainerPoint(bounds.getNorthWest());
            const se = this.map.latLngToContainerPoint(bounds.getSouthEast());
            clippingBounds = {
                minX: Math.min(nw.x, se.x),
                minY: Math.min(nw.y, se.y),
                maxX: Math.max(nw.x, se.x),
                maxY: Math.max(nw.y, se.y),
                w: Math.abs(nw.x - se.x),
                h: Math.abs(nw.y - se.y)
            };
        }

        // 1. Capture View - WITH CLIPPING
        const blob = this.rorschachLayer.getOutlines(clippingBounds);

        if ((!blob || !blob.segments || blob.segments.length === 0) && !clippingBounds) {
            this.updateStatus('NO SHAPE DETECTED', false);
            setTimeout(() => this.updateStatus('ONLINE', false), 2000);
            return;
        }

        this.updateStatus('GEMINI VISION...', true);

        try {
            // Capture & Downscale Canvas
            const sourceCanvas = this.rorschachLayer.canvas;

            // Determine Crop Area
            let sx = 0, sy = 0, sw = sourceCanvas.width, sh = sourceCanvas.height;

            if (clippingBounds) {
                sx = clippingBounds.minX;
                sy = clippingBounds.minY;
                sw = clippingBounds.w;
                sh = clippingBounds.h;
            }

            const tempCanvas = document.createElement('canvas');
            const scale = Math.min(1, 800 / Math.max(sw, sh));

            tempCanvas.width = sw * scale;
            tempCanvas.height = sh * scale;
            const ctx = tempCanvas.getContext('2d');

            ctx.drawImage(sourceCanvas, sx, sy, sw, sh, 0, 0, tempCanvas.width, tempCanvas.height);

            // Apply Mask to Image (so Gemini doesn't see outside stuff if we just cropped rect)
            // Actually, drawImage crops rect. But if we want to be strict, we might want to mask.
            // But cropping is usually enough for Vision API.

            let base64Image;
            try {
                base64Image = tempCanvas.toDataURL('image/jpeg', 0.8).split(',')[1];
            } catch (e) {
                console.error("Canvas Tainted:", e);
                throw new Error("Security Error: Canvas Tainted. CORS missing?");
            }

            // 2. Prompt Engineering
            const categories = ['Monster', 'Sci-Fi Vehicle', 'Animal', 'Food', 'Tool', 'Human Face', 'Mythical Creature'];
            const category = categories[Math.floor(Math.random() * categories.length)];

            const prompt = `Look at this Rorschach inkblot. The image shows WHITE shapes on a BLACK background.
            Focus on the WHITE organic shapes. IMPORTANT: Look at the internal black negative space (holes) within the white shapes—they often form eyes, mouths, or facial features.
            It is NOT a map, island, archipelago, or cloud.
            Use your imagination. If this shape (including its internal details) were a ${category}, what specific one would it be?
            Answer with just the noun (e.g. "Dragon", "Spaceship", "Pizza"). Do not add period.`;

            // 3. Call Gemini Vision (Identify)
            const visionResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{
                        parts: [
                            { text: prompt },
                            { inline_data: { mime_type: "image/jpeg", data: base64Image } }
                        ]
                    }]
                })
            });

            const visionData = await visionResponse.json();

            if (visionData.error) {
                throw new Error(visionData.error.message || "API Error");
            }

            if (!visionData.candidates || !visionData.candidates[0].content) {
                throw new Error("Vision API returned no content");
            }

            const identifiedNoun = visionData.candidates[0].content.parts[0].text.trim().toUpperCase();
            console.log("Gemini Identified:", identifiedNoun);

            this.updateStatus(`GENERATING IMAGE...`, true);

            // 4. Attempt Real Image Generation (Imagen)
            let generatedImage = null;

            try {
                // Simulate network delay for "Generation"
                // In a real app, we'd hit the Imagen endpoint here.
                await new Promise(r => setTimeout(r, 1500));

                // Asset matching fallback
                if (identifiedNoun.includes("RABBIT") || identifiedNoun.includes("BUNNY")) {
                    generatedImage = "assets/sketch_rabbit.png";
                } else if (identifiedNoun.includes("SKULL") || identifiedNoun.includes("HEAD")) {
                    generatedImage = "assets/sketch_skull.png";
                } else if (identifiedNoun.includes("BUTTERFLY") || identifiedNoun.includes("MOTH")) {
                    generatedImage = "assets/sketch_butterfly.png";
                }

            } catch (genError) {
                console.warn("Image Generation Failed:", genError);
            }

            const result = {
                label: identifiedNoun,
                icon: "✨",
                img: generatedImage // Can be null
            };

            // Use the (potentially filtered) blob
            // If selection was used, blob is already filtered and centered correctly.
            // If no blob (empty space selected), we might have an issue, but we checked earlier.

            // If we have a selection but NO segments found inside it (rare if we sent image),
            // we should at least show the label at the center.
            if (!blob && this.selectionBounds) {
                 const cx = this.selectionBounds.x + this.selectionBounds.w / 2;
                 const cy = this.selectionBounds.y + this.selectionBounds.h / 2;
                 blob = {
                     center: this.map.containerPointToLatLng([cx, cy]),
                     segments: []
                 };
            }

            this.showCloudInterpretation(blob, result);
            this.updateStatus('ANALYSIS COMPLETE', false);

        } catch (error) {
            console.error("Gemini Integration Error:", error);
            this.showError(`API ERROR: ${error.message}`);
            // Fallback to local
            setTimeout(() => this.analyzeLocal(), 3000);
        }
    }

    showCloudInterpretation(blob, result) {
        // 1. ALWAYS Show Red Outline (if segments exist)
        if (blob && blob.segments && blob.segments.length > 0) {
            // Use the new Canvas-based rendering for outlines
            this.rorschachLayer.setOutlines(blob.segments);
        } else if (this.selectionBounds) {
            // If no blob but selection, maybe show a red box?
            // Let's rely on the user's green box or just the label.
        }

        const center = blob.center;

        // 2. Show Image Overlay ONLY if we have a valid image
        if (result.img) {
            const latOffset = 2.0;
            const lngOffset = 3.0;

            const bounds = [
                [center.lat - latOffset, center.lng - lngOffset],
                [center.lat + latOffset, center.lng + lngOffset]
            ];

            this.sketchLayer = L.imageOverlay(result.img, bounds, {
                opacity: 0.9,
                className: 'sketch-overlay'
            }).addTo(this.map);
        }

    // 3. (Removed) Map Marker
    /*
    const iconHtml = `
        <div class="interpretation-label" style="padding: 5px; border-radius: 50%; width: 50px; height: 50px;">
            <div class="icon" style="font-size: 2rem; margin: 0;">${result.icon}</div>
        </div>
    `;

    const customIcon = L.divIcon({
        html: iconHtml,
        className: 'custom-div-icon',
        iconSize: [50, 50],
        iconAnchor: [25, 25]
    });

    // Create Result Pane if needed (Topmost)
    if (!this.map.getPane('resultPane')) {
        this.map.createPane('resultPane');
        this.map.getPane('resultPane').style.zIndex = 2000;
        this.map.getPane('resultPane').style.pointerEvents = 'none';
    }

    this.labelMarker = L.marker(center, {
        icon: customIcon,
        pane: 'resultPane'
    }).addTo(this.map);
    */

    // 4. Show Result Overlay
    const overlay = document.getElementById('result-overlay');
    const content = overlay.querySelector('.result-content');
    const iconEl = overlay.querySelector('.result-icon');
    const textEl = overlay.querySelector('.result-text');
    const closeBtn = overlay.querySelector('.close-result');

    iconEl.textContent = result.icon;
    textEl.textContent = `GEMINI SEES A ${result.label}`;
    iconEl.classList.remove('spin'); // Stop spinning
    overlay.style.display = 'flex';

    // Close Handler
    const closeHandler = () => {
        overlay.style.display = 'none';
        if (this.sketchLayer) this.map.removeLayer(this.sketchLayer);
        if (this.labelMarker) this.map.removeLayer(this.labelMarker);

        // Clear outlines
        this.rorschachLayer.setOutlines(null);

        this.sketchLayer = null;
        this.labelMarker = null;
        this.outlineLayer = null;
        closeBtn.removeEventListener('click', closeHandler);
    };
    closeBtn.addEventListener('click', closeHandler);

    // Remove after a while
    setTimeout(() => {
        if (overlay.style.display !== 'none') closeHandler();
    }, 15000); // Longer timeout for Cloud Vision
}
    showInterpretation(blob, result) {
        // 1. Draw Red Outline (Polyline)
        this.outlineLayer = L.polyline(blob.segments, {
            color: 'red',
            weight: 3,
            opacity: 0.8,
            lineCap: 'round'
        }).addTo(this.map);

        // 2. (Removed) Map Marker
        // User requested to remove the emoji from the map as it covers the rain.
        // The result is already shown in the overlay.

        /*
        const iconHtml = `
            <div class="interpretation-label" style="padding: 5px; border-radius: 50%; width: 50px; height: 50px;">
                <div class="icon" style="font-size: 2rem; margin: 0;">${result.icon}</div>
            </div>
        `;

        const customIcon = L.divIcon({
            html: iconHtml,
            className: 'custom-div-icon',
            iconSize: [50, 50],
            iconAnchor: [25, 25]
        });

        // Create Result Pane if needed (Topmost)
        if (!this.map.getPane('resultPane')) {
            this.map.createPane('resultPane');
            this.map.getPane('resultPane').style.zIndex = 2000;
            this.map.getPane('resultPane').style.pointerEvents = 'none';
        }

        this.labelMarker = L.marker(blob.center, {
            icon: customIcon,
            pane: 'resultPane'
        }).addTo(this.map);
        */

        // 3. Show Result Overlay
        const overlay = document.getElementById('result-overlay');
        const content = overlay.querySelector('.result-content');
        const iconEl = overlay.querySelector('.result-icon');
        const textEl = overlay.querySelector('.result-text');
        const closeBtn = overlay.querySelector('.close-result');

        // Construct text
        const article = (result.adjective && /^[AEIOU]/.test(result.adjective)) ? 'AN' : 'A';
        const text = result.adjective
            ? `I SEE ${article} ${result.adjective} ${result.label}`
            : `I SEE A ${result.label}`;

        iconEl.textContent = result.icon;
        textEl.textContent = text;
        iconEl.classList.remove('spin'); // Stop spinning

        // Ensure display is flex (it should be already from showLoading)
        overlay.style.display = 'flex';

        // Close Handler
        const closeHandler = () => {
            overlay.style.display = 'none';
            if (this.outlineLayer) this.map.removeLayer(this.outlineLayer);
            if (this.labelMarker) this.map.removeLayer(this.labelMarker);
            this.outlineLayer = null;
            this.labelMarker = null;
            closeBtn.removeEventListener('click', closeHandler);
        };
        closeBtn.addEventListener('click', closeHandler);

        // Auto-close after 10 seconds
        setTimeout(() => {
            if (overlay.style.display !== 'none') closeHandler();
        }, 10000);
    }

    async loadRadarData() {
        this.updateStatus('CONNECTING...', true);
        try {
            const response = await fetch(CONFIG.rainViewerApi);
            const data = await response.json();

            if (data.radar && data.radar.past) {
                this.frames = [...data.radar.past, ...data.radar.nowcast];
            } else {
                this.frames = [];
            }

            if (this.frames.length > 0) {
                // Fix: Start at the last "Past" frame to ensure data exists
                // Nowcast frames often return 404 or empty images initially
                if (data.radar && data.radar.past) {
                    this.currentFrameIndex = data.radar.past.length - 1;
                } else {
                    this.currentFrameIndex = this.frames.length - 1;
                }

                this.updateScrubber();

                // Set initial frame
                const frame = this.frames[this.currentFrameIndex];
                this.rorschachLayer.setFrame(frame);
                this.updateTimestampDisplay(frame.time);

                this.updateStatus('ONLINE', false);
            } else {
                this.showError('NO DATA');
            }

        } catch (error) {
            console.error(error);
            this.showError('CONNECTION FAIL');
            this.loadFallbackMode();
        }
    }

    loadFallbackMode() {
        // For fallback, we might just load a static image into the map
        // But our RorschachLayer expects tiles.
        // We could just let it fail and show the grid, or add a static image overlay.
        const bounds = [[20, -130], [50, -60]];
        L.imageOverlay('assets/fallback_radar.png', bounds, { opacity: 0.8 }).addTo(this.map);
        this.map.fitBounds(bounds);
        this.updateStatus('OFFLINE MODE', false);
    }

    updateScrubber() {
        const scrubber = document.getElementById('time-scrubber');
        scrubber.max = this.frames.length - 1;
        scrubber.value = this.currentFrameIndex;
        scrubber.disabled = false;
    }

    showFrame(index) {
        if (index >= 0 && index < this.frames.length) {
            this.currentFrameIndex = index;
            const frame = this.frames[index];

            // Update Layer
            this.rorschachLayer.setFrame(frame);
            this.updateTimestampDisplay(frame.time);
            this.updateScrubber();

            // Trigger Preload of next few frames
            // We slice from current index
            const futureFrames = this.frames.slice(index, index + 5);
            tileCache.preload(futureFrames, this.map);
        }
    }

    toggleAnimation() {
        if (this.isPlaying) {
            this.stopAnimation();
        } else {
            this.startAnimation();
        }
    }

    startAnimation() {
        this.isPlaying = true;
        document.getElementById('btn-play').textContent = '⏸';
        this.updateStatus('PLAYING', false);

        this.playInterval = setInterval(() => {
            let nextIndex = this.currentFrameIndex + 1;
            if (nextIndex >= this.frames.length) {
                nextIndex = 0;
            }
            this.showFrame(nextIndex);
        }, 200); // Fast 200ms updates because RAF handles smoothing!
    }

    stopAnimation() {
        this.isPlaying = false;
        document.getElementById('btn-play').textContent = '▶';
        clearInterval(this.playInterval);
        this.updateStatus('ONLINE', false);
    }

    updateTimestampDisplay(ts) {
        const date = new Date(ts * 1000);
        document.getElementById('timestamp-display').textContent = date.toLocaleTimeString() + ' ' + date.toLocaleDateString();
    }

    setMode(mode) {
        document.querySelectorAll('.toggle-group button').forEach(b => b.classList.remove('active'));
        document.getElementById(`btn-${mode}`).classList.add('active');
        this.rorschachLayer.setMode(mode);
    }

    setTheme(theme) {
        document.body.className = `theme-${theme}`;
    }

    showError(msg) {
        this.updateStatus('ERROR', true);
        document.getElementById('timestamp-display').textContent = `ERR: ${msg}`;
        document.getElementById('timestamp-display').style.color = 'red';
    }

    updateStatus(text, blink) {
        const el = document.getElementById('status-indicator');
        if (el) {
            el.textContent = text;
            if (blink) {
                el.classList.add('blink');
                el.style.color = 'var(--phosphor-primary)';
            } else {
                el.classList.remove('blink');
                el.style.color = 'var(--phosphor-primary)';
            }
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new App();
});
