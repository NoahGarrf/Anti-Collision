// a mod I, the oh so wise and awesome and vaguely sexy Noah, made so I could place a specific track in a build
(function () {
    var TAG = "[Anticollision]";
    var MOD_VERSION = "1.0.0";
    var STORAGE_KEY = "anticollision:state";
    var RADIUS_METERS = 350;
    var PANEL_ID = "anticollision-panel";
    var MAX_PANEL_HEIGHT = 480;

    var api = window.SubwayBuilderAPI;
    if (!api) {
        console.error(TAG + " SubwayBuilderAPI not found!");
        return;
    }
    console.log(TAG + " v" + MOD_VERSION + " | API v" + api.version);

    var storage = api.storage && api.storage.scoped ? api.storage.scoped() : null;
    var React = api.utils.React;
    var h = React.createElement;

    // ---------- Scoped scrollbar style ----------

    (function ensureScrollbarStyle() {
        if (typeof document === "undefined") return;
        var STYLE_ID = "anticollision-scrollbar-style";
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement("style");
        style.id = STYLE_ID;
        style.textContent = `
            .anticollision-scroll {
                scrollbar-width: thin;
                scrollbar-color: rgba(128,128,128,0.35) transparent;
            }
            .anticollision-scroll::-webkit-scrollbar {
                width: 6px;
                height: 6px;
            }
            .anticollision-scroll::-webkit-scrollbar-track {
                background: transparent;
            }
            .anticollision-scroll::-webkit-scrollbar-thumb {
                background-color: rgba(128,128,128,0.30);
                border-radius: 6px;
                transition: background-color 0.15s ease;
            }
            .anticollision-scroll:hover::-webkit-scrollbar-thumb {
                background-color: rgba(128,128,128,0.55);
            }
            .anticollision-scroll::-webkit-scrollbar-corner {
                background: transparent;
            }
        `;
        document.head.appendChild(style);
    })();

    // ---------- State ----------

    var globalEnabled = false;
    var zones = [];
    var pickMode = false;
    var zonesVisible = true;

    function makeZoneId() {
        return "zone-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
    }

    function persist() {
        if (!storage) return;
        try {
            storage.set(STORAGE_KEY, {
                global: globalEnabled,
                zones: zones.map(function (z) {
                    return { lng: z.lng, lat: z.lat, id: z.id };
                }),
                zonesVisible: zonesVisible
            });
        } catch (e) {
            console.error(TAG + " persist failed:", e);
        }
    }

    function loadPersisted() {
        if (!storage) return Promise.resolve();
        return storage.get(STORAGE_KEY, null).then(function (saved) {
            if (!saved) return;
            if (saved.global === true) globalEnabled = true;
            if (saved.zonesVisible === false) zonesVisible = false;
            if (Array.isArray(saved.zones)) {
                zones = saved.zones.map(function (z) {
                    if (Array.isArray(z) && z.length === 2) {
                        return { lng: z[0], lat: z[1], id: makeZoneId() };
                    }
                    return {
                        lng: Number(z.lng),
                        lat: Number(z.lat),
                        id: z.id || makeZoneId()
                    };
                }).filter(function (z) {
                    return Number.isFinite(z.lng) && Number.isFinite(z.lat);
                });
            }
        }).catch(function () {});
    }

    // ---------- Detector bridge ----------

    function bridge() {
        try { return window.__subwayBuilder_storeCallbacks__?.getState?.() ?? null; }
        catch (e) { return null; }
    }

    function getDetector() {
        var st = bridge();
        return st && st.buildingDetector ? st.buildingDetector : null;
    }

    function metersBetween(a, b) {
        var latRad = ((a[1] + b[1]) * 0.5) * Math.PI / 180;
        var dy = (b[1] - a[1]) * 111320;
        var dx = (b[0] - a[0]) * 111320 * Math.cos(latRad);
        return Math.sqrt(dx * dx + dy * dy);
    }

    function cellInZone(bd, cellX, cellY) {
        if (zones.length === 0) return false;
        var lng = bd.minLon + (cellX + 0.5) * bd.cellSizeLon;
        var lat = bd.minLat + (cellY + 0.5) * bd.cellSize;
        var cell = [lng, lat];
        for (var i = 0; i < zones.length; i++) {
            var z = zones[i];
            if (metersBetween(cell, [z.lng, z.lat]) <= RADIUS_METERS) return true;
        }
        return false;
    }

    // ---------- Patch ----------

    var patchedDetector = null;
    var originalForEach = null;

    function installPatch() {
        var bd = getDetector();
        if (!bd || typeof bd.forEachBuildingInCell !== "function") return false;
        if (patchedDetector === bd && bd.forEachBuildingInCell.__rcPatch) return true;

        if (patchedDetector && patchedDetector !== bd && originalForEach) {
            try { patchedDetector.forEachBuildingInCell = originalForEach; } catch (e) {}
        }

        originalForEach = bd.forEachBuildingInCell;
        var orig = originalForEach;
        var replacement = function (cellX, cellY, cb) {
            if (globalEnabled) return;
            if (cellInZone(bd, cellX, cellY)) return;
            return orig.call(this, cellX, cellY, cb);
        };
        replacement.__rcPatch = true;
        bd.forEachBuildingInCell = replacement;
        patchedDetector = bd;
        console.log(TAG + " patch installed.");
        return true;
    }

    // ---------- Map zone highlight layer ----------

    var HIGHLIGHT = {
        SOURCE_ID: "anticollision-source",
        LAYER_ID: "anticollision-layer",
        FILL_COLOR: "#f59e0b",
        FILL_OPACITY: 0.12,
        STROKE_COLOR: "#f59e0b",
        STROKE_OPACITY: 0.85,
        STROKE_WIDTH: 2
    };

    var highlightRegistered = false;

    function getMap() {
        try { return api.utils.getMap ? api.utils.getMap() : null; }
        catch (e) { return null; }
    }

    function circlePolygon(lng, lat, meters, segments) {
        segments = segments || 48;
        var coords = [];
        var dLat = meters / 111320;
        var dLng = meters / (111320 * Math.cos(lat * Math.PI / 180));
        for (var i = 0; i <= segments; i++) {
            var t = (i / segments) * Math.PI * 2;
            coords.push([
                lng + Math.cos(t) * dLng,
                lat + Math.sin(t) * dLat
            ]);
        }
        return coords;
    }

    function buildZoneFeatureCollection() {
        var features = [];
        for (var i = 0; i < zones.length; i++) {
            var z = zones[i];
            features.push({
                type: "Feature",
                properties: { id: z.id, index: i },
                geometry: {
                    type: "Polygon",
                    coordinates: [circlePolygon(z.lng, z.lat, RADIUS_METERS)]
                }
            });
        }
        return { type: "FeatureCollection", features: features };
    }

    function pushHighlightData() {
        var map = getMap();
        if (!map) return;
        try {
            var src = map.getSource && map.getSource(HIGHLIGHT.SOURCE_ID);
            if (src && typeof src.setData === "function") {
                src.setData(buildZoneFeatureCollection());
            }
            var hasLayer = map.getLayer && map.getLayer(HIGHLIGHT.LAYER_ID);
            if (hasLayer) {
                try {
                    map.setLayoutProperty(
                        HIGHLIGHT.LAYER_ID,
                        "visibility",
                        zonesVisible ? "visible" : "none"
                    );
                } catch (e) {}
            }
            var hasStroke = map.getLayer && map.getLayer(HIGHLIGHT.LAYER_ID + "-stroke");
            if (hasStroke) {
                try {
                    map.setLayoutProperty(
                        HIGHLIGHT.LAYER_ID + "-stroke",
                        "visibility",
                        zonesVisible ? "visible" : "none"
                    );
                } catch (e) {}
            }
        } catch (e) {
            console.warn(TAG + " push highlight failed:", e);
        }
    }

    function registerHighlightLayer() {
        if (highlightRegistered) {
            pushHighlightData();
            return true;
        }
        try {
            if (!api.map || typeof api.map.registerSource !== "function" ||
                typeof api.map.registerLayer !== "function") {
                return false;
            }
            api.map.registerSource(HIGHLIGHT.SOURCE_ID, {
                type: "geojson",
                data: buildZoneFeatureCollection()
            });
            api.map.registerLayer({
                id: HIGHLIGHT.LAYER_ID,
                type: "fill",
                source: HIGHLIGHT.SOURCE_ID,
                paint: {
                    "fill-color": HIGHLIGHT.FILL_COLOR,
                    "fill-opacity": HIGHLIGHT.FILL_OPACITY
                }
            });
            api.map.registerLayer({
                id: HIGHLIGHT.LAYER_ID + "-stroke",
                type: "line",
                source: HIGHLIGHT.SOURCE_ID,
                paint: {
                    "line-color": HIGHLIGHT.STROKE_COLOR,
                    "line-opacity": HIGHLIGHT.STROKE_OPACITY,
                    "line-width": HIGHLIGHT.STROKE_WIDTH
                }
            });
            highlightRegistered = true;
            pushHighlightData();
            return true;
        } catch (e) {
            console.warn(TAG + " highlight registration failed:", e);
            return false;
        }
    }

    function setZonesVisible(v) {
        zonesVisible = !!v;
        persist();
        if (!highlightRegistered) registerHighlightLayer();
        pushHighlightData();
        try { api.ui.forceUpdate && api.ui.forceUpdate(); } catch (e) {}
    }

    // ---------- Map picker ----------

    var mapClickHandler = null;

    function enterPickMode() {
        pickMode = true;
        rerenderPanel();
        var map = getMap();
        if (map && !mapClickHandler) {
            mapClickHandler = function (e) {
                if (!pickMode) return;
                addZone(e.lngLat.lng, e.lngLat.lat);
                exitPickMode();
            };
            map.on("click", mapClickHandler);
        }
    }

    function exitPickMode() {
        pickMode = false;
        rerenderPanel();
    }

    function addZone(lng, lat) {
        zones.push({ lng: lng, lat: lat, id: makeZoneId() });
        persist();
        registerHighlightLayer();
        pushHighlightData();
        rerenderPanel();
        try {
            api.ui.showNotification(
                "Zone added (" + zones.length + " active)",
                "success",
                "Anticollision"
            );
        } catch (e) {}
    }

    function removeZone(id) {
        var idx = -1;
        for (var i = 0; i < zones.length; i++) {
            if (zones[i].id === id) { idx = i; break; }
        }
        if (idx === -1) return;
        zones.splice(idx, 1);
        persist();
        pushHighlightData();
        rerenderPanel();
    }

    function clearAllZones() {
        zones = [];
        persist();
        pushHighlightData();
        rerenderPanel();
    }

    // ---------- Panel UI ----------

    var panelRerender = null;

    function renderPanel() {
        var rows = [];

        rows.push(h("button", {
            key: "global",
            onClick: function () {
                globalEnabled = !globalEnabled;
                persist();
                rerenderPanel();
            },
            style: buttonStyle(globalEnabled)
        }, globalEnabled ? "Global collision cancel: ON" : "Global collision cancel"));

        rows.push(h("button", {
            key: "pick",
            onClick: function () {
                if (pickMode) exitPickMode(); else enterPickMode();
            },
            style: pickButtonStyle(pickMode)
        }, pickMode
            ? "Zone Selector — click map to place"
            : "Specific Zone Selector"));

        rows.push(h("button", {
            key: "vis",
            onClick: function () { setZonesVisible(!zonesVisible); },
            style: buttonStyle(!zonesVisible)
        }, zonesVisible ? "Hide zone highlights" : "Show zone highlights"));

        rows.push(h("div", {
            key: "header",
            style: {
                marginTop: 12,
                fontWeight: 600,
                fontSize: 12,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center"
            }
        }, [
            h("span", { key: "t" }, "Collision Nonfactor Zones (" + zones.length + ")"),
            zones.length > 0 ? h("button", {
                key: "clear",
                onClick: function () { clearAllZones(); },
                style: {
                    fontSize: 11,
                    padding: "2px 6px",
                    cursor: "pointer",
                    background: "transparent",
                    border: "1px solid #334155",
                    color: "#94a3b8",
                    borderRadius: 3
                }
            }, "Clear all") : null
        ].filter(Boolean)));

        if (zones.length === 0) {
            rows.push(h("div", {
                key: "empty",
                style: { fontSize: 11, color: "#94a3b8", padding: "4px 0" }
            }, "No nonfactor zones yet. Use the selector to add one."));
        } else {
            zones.forEach(function (z, i) {
                rows.push(h("div", {
                    key: z.id,
                    style: {
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        fontSize: 11,
                        padding: "3px 0",
                        gap: 8
                    }
                },
                    h("span", {
                        style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
                    }, "#" + (i + 1) + "  " + z.lng.toFixed(5) + ", " + z.lat.toFixed(5)),
                    h("button", {
                        onClick: function () { removeZone(z.id); },
                        style: {
                            fontSize: 11,
                            padding: "2px 7px",
                            cursor: "pointer",
                            background: "transparent",
                            border: "1px solid rgba(220,38,38,0.5)",
                            color: "#f87171",
                            borderRadius: 3
                        }
                    }, "Remove")
                ));
            });
        }

        return h("div", {
            style: {
                display: "flex",
                flexDirection: "column",
                maxHeight: MAX_PANEL_HEIGHT,
                boxSizing: "border-box",
                overflow: "hidden"
            }
        },
            h("div", {
                className: "anticollision-scroll",
                style: {
                    flex: 1,
                    minHeight: 0,
                    maxHeight: MAX_PANEL_HEIGHT,
                    overflowY: "auto",
                    overflowX: "hidden",
                    padding: "10px 12px",
                    paddingRight: 8
                }
            }, rows)
        );
    }

    function buttonStyle(active) {
        return {
            display: "block",
            width: "100%",
            margin: "6px 0",
            padding: "8px 10px",
            fontSize: 13,
            cursor: "pointer",
            borderRadius: 4,
            border: "1px solid " + (active ? "#f59e0b" : "#334155"),
            background: active ? "#78350f" : "transparent",
            color: "#e2e8f0",
            textAlign: "left"
        };
    }

    function pickButtonStyle(active) {
        return {
            display: "block",
            width: "100%",
            margin: "6px 0",
            padding: "8px 10px",
            fontSize: 13,
            cursor: "pointer",
            borderRadius: 4,
            border: "2px solid " + (active ? "#fbbf24" : "#334155"),
            background: active ? "rgba(251,191,36,0.18)" : "transparent",
            color: active ? "#fde68a" : "#e2e8f0",
            textAlign: "left",
            fontWeight: active ? 600 : 400,
            boxShadow: active ? "0 0 0 2px rgba(251,191,36,0.25) inset" : "none"
        };
    } // Oh you found this random line? Congrats on your dilligence ig? well anyways hi!!!! I like reading ReZero

    function rerenderPanel() {
        if (panelRerender) panelRerender(function (n) { return n + 1; });
    }

    // ---------- Toolbar panel ----------

    var panelOpen = false;

    function registerToolbarPanel() {
        try {
            api.ui.addToolbarPanel({
                id: PANEL_ID,
                icon: "ShieldOff",
                tooltip: "Anticollision",
                title: "Anticollision",
                width: 320,
                render: function () {
                    var _a = React.useState(0);
                    panelRerender = _a[1];
                    return renderPanel();
                }
            });
            panelOpen = true;
        } catch (e) {
            console.error(TAG + " toolbar panel failed:", e);
        }
    }

    // ---------- Init / lifecycle ----------

    function init() {
        registerToolbarPanel();
        loadPersisted().then(function () {
            var tries = 0;
            var wait = function () {
                if (getDetector()) {
                    installPatch();
                    registerHighlightLayer();
                } else if (++tries < 60) {
                    setTimeout(wait, 500);
                } else {
                    console.warn(TAG + " buildingDetector never appeared.");
                }
            };
            wait();
        });
    }

    init();

    var syncPatch = function () {
        if (!patchedDetector) installPatch();
        else {
            var bd = getDetector();
            if (bd && bd !== patchedDetector) installPatch();
        }
        registerHighlightLayer();
        pushHighlightData();
    };
    try { api.hooks.onGameInit(syncPatch); } catch (e) {}
    try { api.hooks.onGameLoaded(syncPatch); } catch (e) {}
    try { api.hooks.onCityLoad(syncPatch); } catch (e) {}
    try { api.hooks.onMapReady(function () {
        registerHighlightLayer();
        pushHighlightData();
    }); } catch (e) {}
    try { api.hooks.onGameEnd(function () {
        panelOpen = false;
        registerToolbarPanel();
        setTimeout(function () { panelOpen = false; registerToolbarPanel(); }, 400);
        highlightRegistered = false;
        pushHighlightData();
    }); } catch (e) {}
})();