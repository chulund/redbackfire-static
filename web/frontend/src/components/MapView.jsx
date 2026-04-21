import { useRef, useEffect, useState } from 'react';
import mapboxgl from 'mapbox-gl';
import { BASEMAPS } from './LayerPanel';
import { SimulationLegend } from './SimulationPanel';
import { getDisplayHotspotId, getSourceHotspotId } from '../utils/hotspots';
import { normaliseRoadsGeoJson } from '../utils/roads';
import {
  HOTSPOT_ACTIVE_COLOR,
  HOTSPOT_OLD_COLOR,
  getHotspotAgeColor,
  getHotspotMarkerIconName,
  getHotspotMarkerShape,
  isHotspotOlderThanThreshold,
} from '../utils/hotspotSymbology';

const MAPBOX_TOKEN = (import.meta.env.VITE_MAPBOX_TOKEN || '').trim();

mapboxgl.accessToken = MAPBOX_TOKEN;

const EMPTY_FC = { type: 'FeatureCollection', features: [] };
const DEFAULT_CENTER = [147.5, -33.0];
const DEFAULT_ZOOM = 5.5;
const NSW_BOUNDS = [[139.5, -38.5], [154.5, -27.5]];

const FIRE_LAYERS = [
  'fire-events-fill', 'fire-events-outline', 'fire-events-labels',
  'hotspots-fill', 'hotspots-outline', 'hotspots-circle', 'hotspots-triangle',
  'ignitions-circle', 'ignitions-core', 'selected-event-outline',
];

const NPWS_FIRE_TYPE_LABELS = {
  1: 'Wildfire',
  2: 'Prescribed Burn',
};

const PRODUCT_LABELS = {
  bright_s3: 'BRIGHT AHI v2.0',
  bright_ahi: 'BRIGHT AHI v1.86',
};

const HOTSPOT_TRIANGLE_ICON_IDS = {
  red: 'hotspot-triangle-red',
  grey: 'hotspot-triangle-grey',
  selectedRed: 'selected-hotspot-triangle-red',
  selectedGrey: 'selected-hotspot-triangle-grey',
};

function getValidFrp(props = {}) {
  const value = props.frp_mw ?? props.power ?? props.frp ?? null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

function getEventFeatureId(props = {}) {
  return props.stable_id ?? props.cluster_id ?? props.event_id ?? props.fire_id ?? null;
}

function formatAest(value) {
  if (!value) return 'Unknown';
  const numeric = typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())
    ? Number(value)
    : (typeof value === 'number' ? value : null);
  const timestamp = numeric != null
    ? new Date(numeric > 1e11 ? numeric : numeric * 1000)
    : new Date(value);
  if (Number.isNaN(timestamp.getTime())) return String(value);
  return timestamp.toLocaleString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Australia/Sydney',
    timeZoneName: 'short',
  });
}

function formatLatLon(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return 'Unknown';
  return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
}

function getProductDisplayName(productId) {
  return PRODUCT_LABELS[productId] || productId || 'Unknown';
}

function getHotspotId(feature) {
  return getDisplayHotspotId(feature?.properties || {}, feature) || 'Unknown';
}

function getEventMaxFrp(props = {}) {
  const value = props.frp_max_mw ?? props.max_frp_mw ?? props.peak_frp_mw ?? null;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function getEventDurationHours(props = {}) {
  const duration = props.duration_hours ?? props.duration_h ?? props.duration_hr ?? props.duration ?? null;
  const direct = Number(duration);
  if (Number.isFinite(direct) && direct >= 0) return direct;
  const start = props.first_hotspot_time ?? props.start_dt ?? props.datetime ?? null;
  const end = props.last_hotspot_time ?? props.end_dt ?? props.datetime ?? null;
  if (!start || !end) return null;
  const hours = (new Date(end).getTime() - new Date(start).getTime()) / 3600000;
  return Number.isFinite(hours) && hours >= 0 ? hours : null;
}

function formatDuration(hours) {
  if (hours == null) return 'Unknown';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 24) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
}

function getNpwsFireTypeLabel(value) {
  const numeric = Number(value);
  return NPWS_FIRE_TYPE_LABELS[numeric] || 'Unknown';
}

const IMPACTED_ROAD_EXPR = ['!=', ['get', 'obsdateepoch'], null];
const DEA_SOURCE_PREFIX = 'dea-overlay-';
const DEA_READY_THRESHOLD = 1;
const DEA_READY_STABLE_PASSES = 2;
const DEA_MAX_VIEWPORT_RETRIES = 2;
const DEA_RETRY_COOLDOWN_MS = 1500;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function tileCoordToKey(coord) {
  const canonical = coord?.canonical || coord;
  const z = canonical?.z ?? coord?.overscaledZ;
  const x = canonical?.x;
  const y = canonical?.y;
  if (![z, x, y].every(Number.isInteger)) return null;
  return `${z}/${x}/${y}`;
}

function normaliseLngLatBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) return null;
  const [west, south, east, north] = bounds.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

function intersectLngLatBounds(a, b) {
  if (!a || !b) return null;
  const west = Math.max(a.west, b.west);
  const south = Math.max(a.south, b.south);
  const east = Math.min(a.east, b.east);
  const north = Math.min(a.north, b.north);
  if (west >= east || south >= north) return null;
  return { west, south, east, north };
}

function lonLatToTileXY(lon, lat, z) {
  const n = 2 ** z;
  const clampedLon = clamp(lon, -180, 180);
  const clampedLat = clamp(lat, -85.05112878, 85.05112878);
  const x = clamp(Math.floor(((clampedLon + 180) / 360) * n), 0, n - 1);
  const latRad = (clampedLat * Math.PI) / 180;
  const y = clamp(
    Math.floor((1 - Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI) * n / 2),
    0,
    n - 1,
  );
  return { x, y };
}

function getExpectedDeaTileKeys(map, layerDef) {
  if (!map || !layerDef) return new Set();
  const mapBounds = map.getBounds();
  if (!mapBounds) return new Set();
  const viewportBounds = {
    west: mapBounds.getWest(),
    south: mapBounds.getSouth(),
    east: mapBounds.getEast(),
    north: mapBounds.getNorth(),
  };
  const sourceBounds = normaliseLngLatBounds(layerDef.bounds);
  const effectiveBounds = sourceBounds
    ? intersectLngLatBounds(viewportBounds, sourceBounds)
    : viewportBounds;
  if (!effectiveBounds) return new Set();

  const z = Math.max(0, Math.round(map.getZoom()));
  const topLeft = lonLatToTileXY(effectiveBounds.west, effectiveBounds.north, z);
  const bottomRight = lonLatToTileXY(effectiveBounds.east, effectiveBounds.south, z);
  const keys = new Set();

  for (let x = Math.min(topLeft.x, bottomRight.x); x <= Math.max(topLeft.x, bottomRight.x); x += 1) {
    for (let y = Math.min(topLeft.y, bottomRight.y); y <= Math.max(topLeft.y, bottomRight.y); y += 1) {
      keys.add(`${z}/${x}/${y}`);
    }
  }

  return keys;
}

function countMatchingTileKeys(tileKeys, expectedKeys) {
  let count = 0;
  for (const key of tileKeys) {
    if (expectedKeys.has(key)) count += 1;
  }
  return count;
}

function buildDeaTileUrl(layerDef, wmsBase) {
  return layerDef.tile_url || (() => {
    let url = `${wmsBase}?service=WMS&version=1.1.1&request=GetMap`
      + `&layers=${layerDef.wms_layer}`
      + '&bbox={bbox-epsg-3857}'
      + '&width=256&height=256'
      + '&srs=EPSG:3857'
      + '&format=image/png'
      + '&transparent=true';

    if (layerDef.wms_style) {
      url += `&styles=${layerDef.wms_style}`;
    }
    if (layerDef.wms_time) {
      url += `&time=${layerDef.wms_time}`;
    }
    return url;
  })();
}

function mountDeaOverlaySource(map, layerDef, beforeId, onOverlayLoadingChange, wmsBase) {
  const sourceId = `${DEA_SOURCE_PREFIX}${layerDef.id}`;
  const mapLayerId = `${DEA_SOURCE_PREFIX}${layerDef.id}-raster`;
  const paint = {
    'raster-opacity': layerDef.opacity || 0.5,
    ...(layerDef.paint || {}),
  };

  if (!map.getSource(sourceId)) {
    onOverlayLoadingChange?.(layerDef.id, true, null);
    map.addSource(sourceId, {
      type: 'raster',
      tiles: [buildDeaTileUrl(layerDef, wmsBase)],
      tileSize: 256,
      bounds: layerDef.bounds || undefined,
    });
  }

  if (!map.getLayer(mapLayerId)) {
    map.addLayer({
      id: mapLayerId,
      type: 'raster',
      source: sourceId,
      paint,
    }, beforeId);
    return;
  }

  Object.entries(paint).forEach(([key, value]) => {
    map.setPaintProperty(mapLayerId, key, value);
  });
}

function removeDeaOverlaySource(map, layerDef, onOverlayLoadingChange) {
  const sourceId = `${DEA_SOURCE_PREFIX}${layerDef.id}`;
  const mapLayerId = `${DEA_SOURCE_PREFIX}${layerDef.id}-raster`;
  if (map.getLayer(mapLayerId)) map.removeLayer(mapLayerId);
  if (map.getSource(sourceId)) map.removeSource(sourceId);
  onOverlayLoadingChange?.(layerDef.id, false, null);
}

function getFeatureCenter(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return null;
  if (geometry.type === 'Point') {
    const [lng, lat] = geometry.coordinates || [];
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
  }
  const ring = geometry.type === 'Polygon'
    ? geometry.coordinates?.[0]
    : geometry.type === 'MultiPolygon'
      ? geometry.coordinates?.[0]?.[0]
      : null;
  if (!Array.isArray(ring) || ring.length === 0) return null;
  const lng = ring.reduce((sum, coord) => sum + coord[0], 0) / ring.length;
  const lat = ring.reduce((sum, coord) => sum + coord[1], 0) / ring.length;
  return { lat, lng };
}

function makeCoordKey(lat, lng) {
  return `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
}

function summariseHotspotFeature(feature) {
  const center = getFeatureCenter(feature);
  if (!center) return null;
  const props = feature.properties || {};
  const frp = getValidFrp(props);
  return {
    id: getSourceHotspotId(props, feature),
    displayId: getDisplayHotspotId(props, feature),
    idx: props._feature_index != null ? Number(props._feature_index) : null,
    lat: center.lat,
    lng: center.lng,
    coordKey: props._coord_key || makeCoordKey(center.lat, center.lng),
    datetime: props.datetime || props.dt || props.hotspot_datetime || '',
    frp,
    frpKnown: frp != null,
    product_id: props.product_id || 'unknown',
    confidence: props.confidence || '',
    properties: props,
  };
}

function dedupeHotspotSummaries(features) {
  const summaries = [];
  const seen = new Set();
  for (const feature of features) {
    const summary = summariseHotspotFeature(feature);
    if (!summary) continue;
    const key = summary.idx != null
      ? `idx:${summary.idx}`
      : `${summary.coordKey}|${summary.product_id}|${summary.datetime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    summaries.push(summary);
  }
  return summaries;
}

function createTriangleMarkerImage(fillColor, strokeColor, size = 48, strokeWidth = 5) {
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (!context) return null;

  const padding = strokeWidth + 4;
  const half = size / 2;
  const baseY = size - padding;

  context.beginPath();
  context.moveTo(half, padding);
  context.lineTo(size - padding, baseY);
  context.lineTo(padding, baseY);
  context.closePath();
  context.fillStyle = fillColor;
  context.strokeStyle = strokeColor;
  context.lineWidth = strokeWidth;
  context.lineJoin = 'round';
  context.fill();
  context.stroke();

  return context.getImageData(0, 0, size, size);
}

function ensureHotspotMarkerImages(map) {
  const imageDefs = [
    { id: HOTSPOT_TRIANGLE_ICON_IDS.red, fillColor: HOTSPOT_ACTIVE_COLOR, strokeColor: '#fff7cc', size: 48, strokeWidth: 5 },
    { id: HOTSPOT_TRIANGLE_ICON_IDS.grey, fillColor: HOTSPOT_OLD_COLOR, strokeColor: '#fff7cc', size: 48, strokeWidth: 5 },
    { id: HOTSPOT_TRIANGLE_ICON_IDS.selectedRed, fillColor: HOTSPOT_ACTIVE_COLOR, strokeColor: '#ffffff', size: 58, strokeWidth: 7 },
    { id: HOTSPOT_TRIANGLE_ICON_IDS.selectedGrey, fillColor: HOTSPOT_OLD_COLOR, strokeColor: '#ffffff', size: 58, strokeWidth: 7 },
  ];

  for (const { id, fillColor, strokeColor, size, strokeWidth } of imageDefs) {
    if (map.hasImage(id)) continue;

    const imageData = createTriangleMarkerImage(fillColor, strokeColor, size, strokeWidth);
    if (!imageData) continue;

    map.addImage(id, imageData);
  }
}

export default function MapView({
  events, hotspots, selectedEventId,
  onSelectEvent, layers, eventColors, flyTo, mode,
  activeProducts,
  sidebarOpen, layerPanelOpen, deaLayerConfig, activeOverlays,
  lgaData, showLga,
  npwsFireHistoryData, showNpwsFireHistory,
  bushfireExtentsData, showBushfireExtents,
  rfsFacilitiesData, showRfsFacilities,
  ignitions,
  simulationResult, activeSimLayers, simGroupFeatures,
  selectedSimHotspot, checkedSimulationHotspots, selectedRealtimeHotspots, customSimPoint, onMapClickSimPoint,
  onSelectRealtimeHotspots, onSelectRealtimeHotspot, onSelectSimulationHotspot, onClearSimulationHotspotSelection,
  onOverlayLoadingChange,
  simulationLegendTitle,
  simulationLayerLoadState,
  bboxDrawMode,
  onBboxDrawn,
  drawnBbox,
  highlightedLga,
  historicalHighlightedLgas,
  targetAreas,
  selectedTargetLga,
  frpSelectionMode = false,
  onFrpHotspotPick,
  onFrpAreaSelect,
  frpSelectedPoints,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const mapLoadedRef = useRef(false);
  const basemapReadyRef = useRef(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [basemapRev, setBasemapRev] = useState(0);
  const [hotspotChooser, setHotspotChooser] = useState(null);

  const applySelectedHotspotData = (map, hotspotData) => {
    const source = map.getSource('selected-hotspots');
    if (!source) return;

    const selectedIndices = new Set(
      modeRef.current === 'simulation'
        ? ([
          ...(selectedSimHotspot ? [selectedSimHotspot] : []),
          ...(checkedSimulationHotspots || []),
        ]
          .map(hs => hs?.idx)
          .filter(idx => idx != null))
        : (selectedRealtimeHotspots || []).map(hs => hs?.idx).filter(idx => idx != null)
    );

    if (selectedIndices.size === 0 || !hotspotData?.features?.length) {
      source.setData(EMPTY_FC);
      return;
    }

    source.setData({
      type: 'FeatureCollection',
      features: hotspotData.features.filter(
        feature => selectedIndices.has(feature.properties?._feature_index)
      ),
    });
  };

  // Persistent data refs — survive style (basemap) changes
  const dataRefs = useRef({
    events: EMPTY_FC,
    hotspots: EMPTY_FC,
    ignitions: EMPTY_FC,
    selected: EMPTY_FC,
  });
  const callbackRef = useRef(onSelectEvent);
  const layersRef = useRef(layers);
  const modeRef = useRef(mode);
  const activeOverlaysRef = useRef([]);
  const deaLayerConfigRef = useRef(null);
  const lgaDataRef = useRef(lgaData);
  const showLgaRef = useRef(showLga);
  const npwsFireHistoryDataRef = useRef(npwsFireHistoryData);
  const showNpwsFireHistoryRef = useRef(showNpwsFireHistory);
  const bushfireExtentsDataRef = useRef(bushfireExtentsData);
  const showBushfireExtentsRef = useRef(showBushfireExtents);
  const rfsFacilitiesDataRef = useRef(rfsFacilitiesData);
  const showRfsFacilitiesRef = useRef(showRfsFacilities);
  const simulationResultRef = useRef(null);
  const activeSimLayersRef = useRef({ isochrones: true, arrival_time: true, intensity: true, roads: true });
  const customSimPointRef = useRef(null);
  const onMapClickSimPointRef = useRef(null);
  const onSelectRealtimeHotspotsRef = useRef(onSelectRealtimeHotspots);
  const onSelectRealtimeHotspotRef = useRef(onSelectRealtimeHotspot);
  const frpSelectionModeRef = useRef(frpSelectionMode);
  const onFrpHotspotPickRef = useRef(onFrpHotspotPick);
  const onFrpAreaSelectRef = useRef(onFrpAreaSelect);
  const onSelectSimulationHotspotRef = useRef(onSelectSimulationHotspot);
  const onClearSimulationHotspotSelectionRef = useRef(onClearSimulationHotspotSelection);
  const onOverlayLoadingChangeRef = useRef(onOverlayLoadingChange);
  const deaOverlayTrackersRef = useRef({});

  useEffect(() => { callbackRef.current = onSelectEvent; }, [onSelectEvent]);
  useEffect(() => { layersRef.current = layers; }, [layers]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { activeOverlaysRef.current = activeOverlays || []; }, [activeOverlays]);
  useEffect(() => { deaLayerConfigRef.current = deaLayerConfig; }, [deaLayerConfig]);
  useEffect(() => { lgaDataRef.current = lgaData; }, [lgaData]);
  useEffect(() => { showLgaRef.current = showLga; }, [showLga]);
  useEffect(() => { npwsFireHistoryDataRef.current = npwsFireHistoryData; }, [npwsFireHistoryData]);
  useEffect(() => { showNpwsFireHistoryRef.current = showNpwsFireHistory; }, [showNpwsFireHistory]);
  useEffect(() => { bushfireExtentsDataRef.current = bushfireExtentsData; }, [bushfireExtentsData]);
  useEffect(() => { showBushfireExtentsRef.current = showBushfireExtents; }, [showBushfireExtents]);
  useEffect(() => { rfsFacilitiesDataRef.current = rfsFacilitiesData; }, [rfsFacilitiesData]);
  useEffect(() => { showRfsFacilitiesRef.current = showRfsFacilities; }, [showRfsFacilities]);
  useEffect(() => { mapLoadedRef.current = mapLoaded; }, [mapLoaded]);
  useEffect(() => { onOverlayLoadingChangeRef.current = onOverlayLoadingChange; }, [onOverlayLoadingChange]);

  const getDeaLayerDefinition = (layerId) => (
    deaLayerConfigRef.current?.layers?.find((layer) => layer.id === layerId) || null
  );

  const ensureDeaOverlayTracker = (layerId) => {
    if (!deaOverlayTrackersRef.current[layerId]) {
      deaOverlayTrackersRef.current[layerId] = {
        loadedKeys: new Set(),
        pendingKeys: new Set(),
        errorKeys: new Set(),
        retries: 0,
        lastRetryAt: 0,
        lastExpectedSignature: '',
        stableReadyPasses: 0,
        lastPublished: { isLoading: null, errorMessage: null },
        genericError: null,
        retryTimer: null,
        stabilityCheckQueued: false,
        readyAnnounced: false,
      };
    }
    return deaOverlayTrackersRef.current[layerId];
  };

  const clearDeaOverlayTracker = (layerId) => {
    const tracker = deaOverlayTrackersRef.current[layerId];
    if (tracker?.retryTimer) {
      clearTimeout(tracker.retryTimer);
    }
    delete deaOverlayTrackersRef.current[layerId];
  };

  const resetDeaOverlayTracker = (layerId, { resetRetries = false } = {}) => {
    const tracker = ensureDeaOverlayTracker(layerId);
    tracker.loadedKeys.clear();
    tracker.pendingKeys.clear();
    tracker.errorKeys.clear();
    tracker.genericError = null;
    tracker.lastExpectedSignature = '';
    tracker.stableReadyPasses = 0;
    tracker.readyAnnounced = false;
    tracker.stabilityCheckQueued = false;
    if (tracker.retryTimer) {
      clearTimeout(tracker.retryTimer);
      tracker.retryTimer = null;
    }
    if (resetRetries) {
      tracker.retries = 0;
      tracker.lastRetryAt = 0;
    }
  };

  const publishDeaOverlayStatus = (layerId, isLoading, errorMessage = null) => {
    const tracker = ensureDeaOverlayTracker(layerId);
    const previous = tracker.lastPublished || {};
    if (previous.isLoading === isLoading && previous.errorMessage === errorMessage) return;
    tracker.lastPublished = { isLoading, errorMessage };
    onOverlayLoadingChangeRef.current?.(layerId, isLoading, errorMessage);
  };

  const scheduleDeaOverlayRetry = (map, layerDef, tracker) => {
    const now = Date.now();
    if (tracker.retryTimer) return false;
    if (tracker.retries >= DEA_MAX_VIEWPORT_RETRIES) return false;
    if ((now - tracker.lastRetryAt) < DEA_RETRY_COOLDOWN_MS) return false;

    tracker.retries += 1;
    tracker.lastRetryAt = now;
    publishDeaOverlayStatus(layerDef.id, true, null);

    tracker.retryTimer = setTimeout(() => {
      tracker.retryTimer = null;
      if (!mapRef.current || !activeOverlaysRef.current.includes(layerDef.id)) return;
      const currentMap = mapRef.current;
      const beforeId = currentMap.getLayer('fire-events-fill') ? 'fire-events-fill' : undefined;
      const sourceId = `${DEA_SOURCE_PREFIX}${layerDef.id}`;

      resetDeaOverlayTracker(layerDef.id);
      if (currentMap.getLayer(`${sourceId}-raster`)) currentMap.removeLayer(`${sourceId}-raster`);
      if (currentMap.getSource(sourceId)) currentMap.removeSource(sourceId);

      mountDeaOverlaySource(
        currentMap,
        layerDef,
        beforeId,
        onOverlayLoadingChangeRef.current,
        deaLayerConfigRef.current?.wms_base || 'https://ows.dea.ga.gov.au/',
      );
      currentMap.triggerRepaint();
      requestAnimationFrame(() => {
        currentMap.resize();
        currentMap.triggerRepaint();
      });
    }, 120);
    return true;
  };

  const syncDeaOverlayTracker = (map, layerDef, reason = 'event') => {
    if (!map || !layerDef || !activeOverlaysRef.current.includes(layerDef.id)) return;

    const tracker = ensureDeaOverlayTracker(layerDef.id);
    const expectedKeys = getExpectedDeaTileKeys(map, layerDef);
    const expectedSignature = Array.from(expectedKeys).sort().join('|');
    if (tracker.lastExpectedSignature !== expectedSignature) {
      tracker.lastExpectedSignature = expectedSignature;
      tracker.stableReadyPasses = 0;
      tracker.readyAnnounced = false;
    }

    const expectedCount = expectedKeys.size;
    const loadedCount = countMatchingTileKeys(tracker.loadedKeys, expectedKeys);
    const pendingCount = countMatchingTileKeys(tracker.pendingKeys, expectedKeys);
    const errorCount = countMatchingTileKeys(tracker.errorKeys, expectedKeys);
    const unknownCount = Math.max(0, expectedCount - loadedCount - pendingCount - errorCount);
    const completeness = expectedCount === 0 ? 1 : (loadedCount / expectedCount);
    const readyCondition = completeness >= DEA_READY_THRESHOLD && pendingCount === 0 && errorCount === 0 && unknownCount === 0;

    if (readyCondition) {
      tracker.stableReadyPasses += 1;
      if (!tracker.stabilityCheckQueued && tracker.stableReadyPasses < DEA_READY_STABLE_PASSES) {
        tracker.stabilityCheckQueued = true;
        requestAnimationFrame(() => {
          tracker.stabilityCheckQueued = false;
          const latestLayerDef = getDeaLayerDefinition(layerDef.id);
          if (mapRef.current && latestLayerDef) {
            syncDeaOverlayTracker(mapRef.current, latestLayerDef, 'stability-check');
          }
        });
      }
    } else {
      tracker.stableReadyPasses = 0;
      tracker.readyAnnounced = false;
    }

    if (tracker.stableReadyPasses >= DEA_READY_STABLE_PASSES) {
      tracker.genericError = null;
      publishDeaOverlayStatus(layerDef.id, false, null);
      if (!tracker.readyAnnounced) {
        tracker.readyAnnounced = true;
        map.triggerRepaint();
        requestAnimationFrame(() => map.triggerRepaint());
      }
      return;
    }

    const hasVisibleGaps = errorCount > 0 || unknownCount > 0;
    if (reason === 'idle' && pendingCount === 0 && hasVisibleGaps) {
      const retryScheduled = scheduleDeaOverlayRetry(map, layerDef, tracker);
      if (!retryScheduled && tracker.retries >= DEA_MAX_VIEWPORT_RETRIES) {
        const summary = `${loadedCount}/${expectedCount} visible tiles loaded`;
        publishDeaOverlayStatus(
          layerDef.id,
          false,
          tracker.genericError || `Raster overlay incomplete in current view (${summary})`,
        );
        return;
      }
    }

    publishDeaOverlayStatus(layerDef.id, true, null);
  };

  const syncActiveDeaOverlayTrackers = (map, reason = 'event') => {
    if (!map || !deaLayerConfigRef.current?.layers) return;
    const activeSet = new Set(activeOverlaysRef.current || []);

    Object.keys(deaOverlayTrackersRef.current).forEach((layerId) => {
      if (!activeSet.has(layerId)) {
        clearDeaOverlayTracker(layerId);
      }
    });

    for (const layerDef of deaLayerConfigRef.current.layers) {
      if (layerDef.tile_mode === 'vector_query' || !activeSet.has(layerDef.id)) continue;
      syncDeaOverlayTracker(map, layerDef, reason);
    }
  };

  const updateTrackedDeaTileState = (layerId, coord, state, errorMessage = null) => {
    const tileKey = tileCoordToKey(coord);
    const tracker = ensureDeaOverlayTracker(layerId);
    if (errorMessage) {
      tracker.genericError = errorMessage;
    }
    if (!tileKey) return;

    if (state === 'loading') {
      tracker.loadedKeys.delete(tileKey);
      tracker.errorKeys.delete(tileKey);
      tracker.pendingKeys.add(tileKey);
      return;
    }
    if (state === 'loaded') {
      tracker.pendingKeys.delete(tileKey);
      tracker.errorKeys.delete(tileKey);
      tracker.loadedKeys.add(tileKey);
      return;
    }
    if (state === 'error') {
      tracker.pendingKeys.delete(tileKey);
      tracker.loadedKeys.delete(tileKey);
      tracker.errorKeys.add(tileKey);
    }
  };

  const syncMapPresentation = (map) => {
    if (!map) return;
    map.getSource('fire-events')?.setData(dataRefs.current.events);
    map.getSource('hotspots')?.setData(dataRefs.current.hotspots);
    map.getSource('ignitions')?.setData(dataRefs.current.ignitions);
    map.getSource('selected-event')?.setData(dataRefs.current.selected);
    applyVisibility(map, layersRef.current, modeRef.current);
    applyWeather(map, layersRef.current.weather);
    applyDeaOverlays(map, activeOverlaysRef.current, deaLayerConfigRef.current, onOverlayLoadingChangeRef.current);
    applyLgaLayer(map, lgaDataRef.current, showLgaRef.current);
    applyNpwsFireHistoryLayer(map, npwsFireHistoryDataRef.current, showNpwsFireHistoryRef.current);
    applyBushfireExtentsLayer(map, bushfireExtentsDataRef.current, showBushfireExtentsRef.current);
    applyRfsFacilitiesLayer(map, rfsFacilitiesDataRef.current, showRfsFacilitiesRef.current);
  };

  const applyLgaLayer = (map, geojson, visible) => {
    const SRC = 'lga-boundaries';
    const FILL = 'lga-boundaries-fill';
    const LINE = 'lga-boundaries-line';
    const LABEL = 'lga-boundaries-label';

    if (!map?.getStyle()) return;

    if (!geojson) {
      if (map.getLayer(FILL)) map.removeLayer(FILL);
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getLayer(LABEL)) map.removeLayer(LABEL);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }

    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: geojson });
      const beforeId = map.getLayer('fire-events-fill') ? 'fire-events-fill' : undefined;
      map.addLayer({
        id: FILL, type: 'fill', source: SRC,
        paint: { 'fill-color': '#fbbf24', 'fill-opacity': visible ? 0.04 : 0 },
        layout: { visibility: visible ? 'visible' : 'none' },
      }, beforeId);
      map.addLayer({
        id: LINE, type: 'line', source: SRC,
        paint: { 'line-color': '#fff3b0', 'line-width': 2.25, 'line-opacity': 0.95 },
        layout: { visibility: visible ? 'visible' : 'none' },
      }, beforeId);
      map.addLayer({
        id: LABEL, type: 'symbol', source: SRC,
        layout: {
          visibility: visible ? 'visible' : 'none',
          'text-field': ['get', 'abb_name'],
          'text-size': 11,
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#fff7cc',
          'text-halo-color': 'rgba(0,0,0,0.7)',
          'text-halo-width': 1.5,
          'text-opacity': 0.92,
        },
      });
      return;
    }

    map.getSource(SRC).setData(geojson);
    if (map.getLayer(FILL)) map.setLayoutProperty(FILL, 'visibility', visible ? 'visible' : 'none');
    if (map.getLayer(FILL)) map.setPaintProperty(FILL, 'fill-opacity', visible ? 0.04 : 0);
    if (map.getLayer(LINE)) map.setLayoutProperty(LINE, 'visibility', visible ? 'visible' : 'none');
    if (map.getLayer(LABEL)) map.setLayoutProperty(LABEL, 'visibility', visible ? 'visible' : 'none');
  };

  const applyNpwsFireHistoryLayer = (map, geojson, visible) => {
    const SRC = 'npws-fire-history';
    const WILDFIRE_FILL = 'npws-fire-history-wildfire-fill';
    const WILDFIRE_LINE = 'npws-fire-history-wildfire-line';
    const PRESCRIBED_FILL = 'npws-fire-history-prescribed-fill';
    const PRESCRIBED_LINE = 'npws-fire-history-prescribed-line';
    if (!map?.getStyle()) return;
    if (!geojson || !geojson.features?.length) {
      if (map.getLayer(PRESCRIBED_LINE)) map.removeLayer(PRESCRIBED_LINE);
      if (map.getLayer(PRESCRIBED_FILL)) map.removeLayer(PRESCRIBED_FILL);
      if (map.getLayer(WILDFIRE_LINE)) map.removeLayer(WILDFIRE_LINE);
      if (map.getLayer(WILDFIRE_FILL)) map.removeLayer(WILDFIRE_FILL);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: geojson });
      const beforeId = map.getLayer('fire-events-fill') ? 'fire-events-fill' : undefined;
      map.addLayer({
        id: WILDFIRE_FILL, type: 'fill', source: SRC,
        filter: ['==', ['to-number', ['get', 'FireType']], 1],
        paint: {
          'fill-color': '#dc2626',
          'fill-opacity': visible ? 0.05 : 0,
        },
        layout: { visibility: visible ? 'visible' : 'none' },
      }, beforeId);
      map.addLayer({
        id: WILDFIRE_LINE, type: 'line', source: SRC,
        filter: ['==', ['to-number', ['get', 'FireType']], 1],
        paint: {
          'line-color': '#dc2626',
          'line-width': 2,
          'line-opacity': 0.9,
        },
        layout: { visibility: visible ? 'visible' : 'none' },
      }, beforeId);
      map.addLayer({
        id: PRESCRIBED_FILL, type: 'fill', source: SRC,
        filter: ['==', ['to-number', ['get', 'FireType']], 2],
        paint: {
          'fill-color': '#facc15',
          'fill-opacity': visible ? 0.08 : 0,
        },
        layout: { visibility: visible ? 'visible' : 'none' },
      }, beforeId);
      map.addLayer({
        id: PRESCRIBED_LINE, type: 'line', source: SRC,
        filter: ['==', ['to-number', ['get', 'FireType']], 2],
        paint: {
          'line-color': '#f59e0b',
          'line-width': 1.6,
          'line-opacity': 0.92,
        },
        layout: { visibility: visible ? 'visible' : 'none', 'line-cap': 'round', 'line-join': 'round' },
      }, beforeId);
      map.setPaintProperty(PRESCRIBED_LINE, 'line-dasharray', [2, 1.4]);
      return;
    }
    map.getSource(SRC).setData(geojson);
    if (map.getLayer(WILDFIRE_FILL)) {
      map.setLayoutProperty(WILDFIRE_FILL, 'visibility', visible ? 'visible' : 'none');
      map.setPaintProperty(WILDFIRE_FILL, 'fill-opacity', visible ? 0.05 : 0);
    }
    if (map.getLayer(WILDFIRE_LINE)) map.setLayoutProperty(WILDFIRE_LINE, 'visibility', visible ? 'visible' : 'none');
    if (map.getLayer(PRESCRIBED_FILL)) {
      map.setLayoutProperty(PRESCRIBED_FILL, 'visibility', visible ? 'visible' : 'none');
      map.setPaintProperty(PRESCRIBED_FILL, 'fill-opacity', visible ? 0.08 : 0);
    }
    if (map.getLayer(PRESCRIBED_LINE)) map.setLayoutProperty(PRESCRIBED_LINE, 'visibility', visible ? 'visible' : 'none');
  };

  const applyBushfireExtentsLayer = (map, geojson, visible) => {
    const SRC = 'bushfire-extents';
    const FILL = 'bushfire-extents-fill';
    const LINE = 'bushfire-extents-line';
    if (!map?.getStyle()) return;
    if (!geojson || !geojson.features?.length) {
      if (map.getLayer(FILL)) map.removeLayer(FILL);
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: geojson });
      const beforeId = map.getLayer('fire-events-fill') ? 'fire-events-fill' : undefined;
      map.addLayer({
        id: FILL, type: 'fill', source: SRC,
        paint: { 'fill-color': '#e67e22', 'fill-opacity': visible ? 0.18 : 0 },
        layout: { visibility: visible ? 'visible' : 'none' },
      }, beforeId);
      map.addLayer({
        id: LINE, type: 'line', source: SRC,
        paint: { 'line-color': '#d35400', 'line-width': 1.5, 'line-opacity': 0.8 },
        layout: { visibility: visible ? 'visible' : 'none' },
      }, beforeId);
      return;
    }
    map.getSource(SRC).setData(geojson);
    if (map.getLayer(FILL)) {
      map.setLayoutProperty(FILL, 'visibility', visible ? 'visible' : 'none');
      map.setPaintProperty(FILL, 'fill-opacity', visible ? 0.18 : 0);
    }
    if (map.getLayer(LINE)) map.setLayoutProperty(LINE, 'visibility', visible ? 'visible' : 'none');
  };

  const applyRfsFacilitiesLayer = (map, geojson, visible) => {
    const SRC = 'rfs-facilities';
    const CIRCLE = 'rfs-facilities-circle';
    const ICON = 'rfs-facilities-icon';
    const LABEL = 'rfs-facilities-label';
    if (!map?.getStyle()) return;
    if (!geojson || !geojson.features?.length) {
      if (map.getLayer(LABEL)) map.removeLayer(LABEL);
      if (map.getLayer(ICON)) map.removeLayer(ICON);
      if (map.getLayer(CIRCLE)) map.removeLayer(CIRCLE);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }
    if (!map.getSource(SRC)) {
      map.addSource(SRC, { type: 'geojson', data: geojson });
      map.addLayer({
        id: CIRCLE, type: 'circle', source: SRC,
        paint: {
          'circle-radius': 3.5,
          'circle-color': '#e74c3c',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-opacity': visible ? 0.9 : 0,
          'circle-stroke-opacity': visible ? 0.9 : 0,
        },
        layout: { visibility: visible ? 'visible' : 'none' },
      });
      map.addLayer({
        id: ICON, type: 'symbol', source: SRC,
        layout: {
          visibility: visible ? 'visible' : 'none',
          'text-field': '🚒',
          'text-size': 12,
          'text-allow-overlap': true,
        },
        paint: {
          'text-opacity': visible ? 0.95 : 0,
        },
      });
      map.addLayer({
        id: LABEL, type: 'symbol', source: SRC,
        layout: {
          visibility: visible ? 'visible' : 'none',
          'text-field': ['coalesce', ['get', 'FACILITY_NAME'], ['get', 'name'], ''],
          'text-size': 10,
          'text-offset': [0, 1.2],
          'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
          'text-allow-overlap': false,
        },
        paint: {
          'text-color': '#ffeedd',
          'text-halo-color': 'rgba(0,0,0,0.7)',
          'text-halo-width': 1,
          'text-opacity': 0.85,
        },
      });
      return;
    }
    map.getSource(SRC).setData(geojson);
    if (map.getLayer(CIRCLE)) {
      map.setLayoutProperty(CIRCLE, 'visibility', visible ? 'visible' : 'none');
      map.setPaintProperty(CIRCLE, 'circle-opacity', visible ? 0.9 : 0);
      map.setPaintProperty(CIRCLE, 'circle-stroke-opacity', visible ? 0.9 : 0);
    }
    if (map.getLayer(ICON)) {
      map.setLayoutProperty(ICON, 'visibility', visible ? 'visible' : 'none');
      map.setPaintProperty(ICON, 'text-opacity', visible ? 0.95 : 0);
    }
    if (map.getLayer(LABEL)) map.setLayoutProperty(LABEL, 'visibility', visible ? 'visible' : 'none');
  };
  useEffect(() => { simulationResultRef.current = simulationResult; }, [simulationResult]);
  useEffect(() => { activeSimLayersRef.current = activeSimLayers || {}; }, [activeSimLayers]);
  useEffect(() => { customSimPointRef.current = customSimPoint; }, [customSimPoint]);
  useEffect(() => { onMapClickSimPointRef.current = onMapClickSimPoint; }, [onMapClickSimPoint]);
  useEffect(() => { onSelectRealtimeHotspotsRef.current = onSelectRealtimeHotspots; }, [onSelectRealtimeHotspots]);
  useEffect(() => { onSelectRealtimeHotspotRef.current = onSelectRealtimeHotspot; }, [onSelectRealtimeHotspot]);
  useEffect(() => { frpSelectionModeRef.current = frpSelectionMode; }, [frpSelectionMode]);
  useEffect(() => { onFrpHotspotPickRef.current = onFrpHotspotPick; }, [onFrpHotspotPick]);
  useEffect(() => { onFrpAreaSelectRef.current = onFrpAreaSelect; }, [onFrpAreaSelect]);
  useEffect(() => { onSelectSimulationHotspotRef.current = onSelectSimulationHotspot; }, [onSelectSimulationHotspot]);
  useEffect(() => { onClearSimulationHotspotSelectionRef.current = onClearSimulationHotspotSelection; }, [onClearSimulationHotspotSelection]);

  // ---- Sim group boundary layer (shows all hotspots in selected location) ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    const SRC = 'sim-group-boundary';
    const FILL = 'sim-group-boundary-fill';
    const LINE = 'sim-group-boundary-outline';

    if (!simGroupFeatures) {
      if (map.getLayer(FILL)) map.removeLayer(FILL);
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }

    if (map.getSource(SRC)) {
      map.getSource(SRC).setData(simGroupFeatures);
    } else {
      map.addSource(SRC, { type: 'geojson', data: simGroupFeatures });
      map.addLayer({
        id: FILL, type: 'fill', source: SRC,
        paint: { 'fill-color': '#00ffff', 'fill-opacity': 0.2 },
      });
      map.addLayer({
        id: LINE, type: 'line', source: SRC,
        paint: { 'line-color': '#00ffff', 'line-width': 2, 'line-dasharray': [3, 2], 'line-opacity': 0.8 },
      });
    }
  }, [simGroupFeatures, mapLoaded]);

  // ---- Selected hotspot highlight based on exact hotspot geometries ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    applySelectedHotspotData(map, dataRefs.current.hotspots);
  }, [mapLoaded, mode, selectedRealtimeHotspots, selectedSimHotspot, checkedSimulationHotspots, hotspots, basemapRev]);

  useEffect(() => {
    if (!hotspotChooser?.candidates?.length) return;
    const selectedHotspot = hotspotChooser.mode === 'simulation' ? selectedSimHotspot : selectedRealtimeHotspots?.[0];
    if (!selectedHotspot) return;
    const stillPresent = hotspotChooser.candidates.some(candidate => candidate.idx === selectedHotspot.idx);
    if (!stillPresent) {
      setHotspotChooser(null);
    }
  }, [hotspotChooser, selectedSimHotspot, selectedRealtimeHotspots]);

  useEffect(() => {
    if (mode !== 'simulation' && mode !== 'realtime') {
      setHotspotChooser(null);
    }
  }, [mode]);

  // ---- FRP selection highlight ring ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    const SRC = 'frp-selection';
    const LAYER = 'frp-selection-ring';

    const points = Array.isArray(frpSelectedPoints) ? frpSelectedPoints : [];
    const data = {
      type: 'FeatureCollection',
      features: points.map((p) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
        properties: { key: p.key },
      })),
    };

    if (map.getSource(SRC)) {
      map.getSource(SRC).setData(data);
    } else {
      map.addSource(SRC, { type: 'geojson', data });
    }
    if (!map.getLayer(LAYER)) {
      map.addLayer({
        id: LAYER, type: 'circle', source: SRC,
        paint: {
          'circle-radius': 14,
          'circle-color': 'transparent',
          'circle-stroke-color': '#ffe066',
          'circle-stroke-width': 3,
          'circle-stroke-opacity': 0.95,
        },
      });
    }
  }, [frpSelectedPoints, mapLoaded, basemapRev]);

  // ---- FRP area-select drag rectangle ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    if (!frpSelectionMode) return;
    const map = mapRef.current;
    const container = containerRef.current;
    if (!container) return;
    const canvas = map.getCanvas();

    canvas.style.cursor = 'crosshair';
    const hadDragPan = map.dragPan?.isEnabled?.();
    const hadBoxZoom = map.boxZoom?.isEnabled?.();
    map.dragPan?.disable?.();
    map.boxZoom?.disable?.();

    let startPx = null;
    let rectEl = null;

    const ensureRect = () => {
      if (rectEl) return;
      rectEl = document.createElement('div');
      rectEl.className = 'frp-drag-rect';
      container.appendChild(rectEl);
    };

    const clearRect = () => {
      if (rectEl && rectEl.parentNode) rectEl.parentNode.removeChild(rectEl);
      rectEl = null;
    };

    const updateRect = (x1, y1, x2, y2) => {
      if (!rectEl) return;
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const w = Math.abs(x2 - x1);
      const h = Math.abs(y2 - y1);
      rectEl.style.left = `${left}px`;
      rectEl.style.top = `${top}px`;
      rectEl.style.width = `${w}px`;
      rectEl.style.height = `${h}px`;
    };

    const collectHotspotSummaries = (geom) => {
      const hotspotLayerIds = FIRE_LAYERS.filter(
        (id) => id.startsWith('hotspots') && map.getLayer(id)
      );
      if (hotspotLayerIds.length === 0) return [];
      const features = map.queryRenderedFeatures(geom, { layers: hotspotLayerIds });
      return dedupeHotspotSummaries(features);
    };

    const onMouseDown = (e) => {
      if (e.originalEvent && e.originalEvent.button !== 0) return;
      startPx = { x: e.point.x, y: e.point.y };
      ensureRect();
      updateRect(startPx.x, startPx.y, startPx.x, startPx.y);
      e.preventDefault();
    };

    const onMouseMove = (e) => {
      if (!startPx) return;
      updateRect(startPx.x, startPx.y, e.point.x, e.point.y);
    };

    const onMouseUp = (e) => {
      if (!startPx) return;
      const endPx = { x: e.point.x, y: e.point.y };
      const dx = Math.abs(endPx.x - startPx.x);
      const dy = Math.abs(endPx.y - startPx.y);
      const startSnapshot = startPx;
      startPx = null;
      clearRect();

      if (dx < 4 && dy < 4) {
        // Treat as single click — toggle top hotspot.
        const summaries = collectHotspotSummaries(endPx);
        if (summaries.length > 0) {
          onFrpHotspotPickRef.current?.(summaries[0]);
        }
        return;
      }

      const x1 = Math.min(startSnapshot.x, endPx.x);
      const y1 = Math.min(startSnapshot.y, endPx.y);
      const x2 = Math.max(startSnapshot.x, endPx.x);
      const y2 = Math.max(startSnapshot.y, endPx.y);
      const summaries = collectHotspotSummaries([[x1, y1], [x2, y2]]);
      if (summaries.length > 0) {
        onFrpAreaSelectRef.current?.(summaries);
      }
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);

    return () => {
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
      clearRect();
      canvas.style.cursor = '';
      if (hadDragPan) map.dragPan?.enable?.();
      if (hadBoxZoom) map.boxZoom?.enable?.();
    };
  }, [frpSelectionMode, mapLoaded]);

  // ---- Custom point marker (simulation) ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;
    const SRC = 'sim-custom-point';
    const LAYER = 'sim-custom-point-marker';

    if (!customSimPoint) {
      if (map.getLayer(LAYER)) map.removeLayer(LAYER);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }

    const data = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [customSimPoint.lng, customSimPoint.lat] },
        properties: {},
      }],
    };

    if (map.getSource(SRC)) {
      map.getSource(SRC).setData(data);
    } else {
      map.addSource(SRC, { type: 'geojson', data });
      map.addLayer({
        id: LAYER, type: 'circle', source: SRC,
        paint: {
          'circle-radius': 10, 'circle-color': '#ff00ff', 'circle-opacity': 0.8,
          'circle-stroke-color': '#ffffff', 'circle-stroke-width': 3,
        },
      });
    }
  }, [customSimPoint, mapLoaded]);

  // ---- Map click for custom simulation point ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;

    const handler = (e) => {
      if (modeRef.current !== 'simulation' || !onMapClickSimPointRef.current) return;
      // Don't place custom point if clicking on fire features
      const clickLayers = FIRE_LAYERS.filter(id => map.getLayer(id));
      if (clickLayers.length > 0) {
        const features = map.queryRenderedFeatures(e.point, { layers: clickLayers });
        if (features.length > 0) return;
      }
      onMapClickSimPointRef.current({ lat: e.lngLat.lat, lng: e.lngLat.lng });
    };

    map.on('click', handler);
    return () => map.off('click', handler);
  }, [mapLoaded]);

  // ---- Initialise map ----
  useEffect(() => {
    if (mapRef.current || !MAPBOX_TOKEN) return;

    const basemap = BASEMAPS.find(b => b.id === layers.basemap) || BASEMAPS[0];

    const map = new mapboxgl.Map({
      container: containerRef.current,
      style: basemap.style,
      center: DEFAULT_CENTER,
      zoom: DEFAULT_ZOOM,
      attributionControl: true,
      antialias: true,
    });

    map.addControl(new mapboxgl.NavigationControl(), 'bottom-right');
    map.addControl(new mapboxgl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    // ---- Persistent event handlers (survive style changes) ----
    const popup = new mapboxgl.Popup({
      closeButton: false, closeOnClick: false, offset: 10, className: 'fire-popup',
    });

    map.on('click', (e) => {
      const clickLayers = FIRE_LAYERS.filter(id => map.getLayer(id));
      if (clickLayers.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers: clickLayers });
      const hotspotFeatures = features.filter(f => (f.layer?.id || '').startsWith('hotspots'));
      const hotspotSummaries = dedupeHotspotSummaries(hotspotFeatures)
        .sort((left, right) => {
          const leftTime = left.datetime ? new Date(left.datetime).getTime() : 0;
          const rightTime = right.datetime ? new Date(right.datetime).getTime() : 0;
          return rightTime - leftTime;
        });

      // FRP area-select mode owns the click; suppress default realtime selection flow.
      if (frpSelectionModeRef.current && modeRef.current === 'realtime') {
        setHotspotChooser(null);
        return;
      }

      if (modeRef.current === 'realtime') {
        if (hotspotSummaries.length > 1) {
          setHotspotChooser({
            mode: 'realtime',
            candidates: hotspotSummaries,
            point: { x: e.point.x, y: e.point.y },
          });
          onSelectRealtimeHotspotRef.current?.(hotspotSummaries[0], { flyTo: false, contextHotspots: hotspotSummaries });
          return;
        }
        if (hotspotSummaries.length === 1) {
          setHotspotChooser(null);
          onSelectRealtimeHotspotRef.current?.(hotspotSummaries[0], { flyTo: false, contextHotspots: hotspotSummaries });
          return;
        }
        setHotspotChooser(null);
        onSelectRealtimeHotspotsRef.current?.([]);
      }

      if (modeRef.current === 'simulation') {
        if (hotspotSummaries.length > 1) {
          setHotspotChooser({
            mode: 'simulation',
            candidates: hotspotSummaries,
            point: { x: e.point.x, y: e.point.y },
          });
          onSelectSimulationHotspotRef.current?.(hotspotSummaries[0], { flyTo: false });
          return;
        }
        if (hotspotSummaries.length === 1) {
          setHotspotChooser(null);
          onSelectSimulationHotspotRef.current?.(hotspotSummaries[0], { flyTo: false });
          return;
        }
        setHotspotChooser(null);
        onClearSimulationHotspotSelectionRef.current?.({ collapseGroup: true });
      }

      if (features.length === 0) {
        callbackRef.current?.(null);
        return;
      }

      const eventFeature = features.find((feature) => {
        const layerId = feature.layer?.id || '';
        return layerId.startsWith('fire-events') || layerId.startsWith('ignitions');
      });
      const eventId = getEventFeatureId(eventFeature?.properties || {});
      if (eventId != null) {
        callbackRef.current?.(eventId);
      } else {
        callbackRef.current?.(null);
      }
    });

    map.on('mousemove', (e) => {
      const hoverLayers = FIRE_LAYERS.filter(id => map.getLayer(id));
      if (hoverLayers.length === 0) return;
      const features = map.queryRenderedFeatures(e.point, { layers: hoverLayers });
      if (features.length > 0) {
        map.getCanvas().style.cursor = 'pointer';
        const f = features[0];
        const p = f.properties;
        const layerId = f.layer?.id || '';
        let html = '';
        if (layerId.startsWith('fire-events')) {
          const id = getEventFeatureId(p) ?? '?';
          const area = p.area_km2 ? `${Number(p.area_km2).toFixed(1)} km²` : 'Unknown area';
          const frpValue = getEventMaxFrp(p);
          const durationHours = getEventDurationHours(p);
          const frp = frpValue != null ? `${Number(frpValue).toFixed(0)} MW` : 'Unknown';
          const detections = p.n_detections ?? p.hotspot_count ?? '';
          const firstTime = formatAest(p.first_hotspot_time || p.start_dt || p.datetime);
          const lastTime = formatAest(p.last_hotspot_time || p.end_dt || p.datetime);
          const ignitionText = (p.ignition_lat != null && p.ignition_lon != null)
            ? formatLatLon(Number(p.ignition_lat), Number(p.ignition_lon))
            : 'Unknown';
          const lga = p.LGA || 'Unknown';
          const detectionText = detections !== '' ? Number(detections).toFixed(0) : 'Unknown';
          html = `<strong>Fire Complex ${id}</strong><br/>Ignition: ${ignitionText}<br/>First: ${firstTime}<br/>Last: ${lastTime}<br/>Duration: ${formatDuration(durationHours)}<br/>Hotspots: ${detectionText}<br/>Area: ${area}<br/>Max FRP: ${frp}<br/>LGA: ${lga}`;
        } else if (layerId.startsWith('hotspots')) {
          const frpValue = getValidFrp(p);
          const frp = frpValue != null ? `FRP: ${frpValue.toFixed(1)} MW` : 'FRP: Unknown';
          const dt = formatAest(p.datetime || p.dt || p.hotspot_datetime);
          const product = getProductDisplayName(p.product_id);
          const hotspotId = getHotspotId(f);
          const center = (p._orig_lat != null && p._orig_lng != null)
            ? { lat: Number(p._orig_lat), lng: Number(p._orig_lng) }
            : getFeatureCenter(f);
          html = `<strong>Hotspot</strong><br/>Hotspot ID: ${hotspotId}<br/><em>${product}</em><br/>${frp}<br/>Time: ${dt}<br/>Lat/Lon: ${formatLatLon(center?.lat, center?.lng)}`;
        } else if (layerId.startsWith('ignitions')) {
          const stableId = getEventFeatureId(p) || p.ignition_id || 'Unknown';
          const dt = formatAest(p.datetime || p.ignition_datetime);
          const lga = p.LGA || 'Unknown';
          html = `<strong>Ignition Point</strong><br/>Ignition ID: ${p.ignition_id || stableId}<br/>Fire Complex: ${stableId}<br/>Time: ${dt}<br/>LGA: ${lga}`;
        }
        if (html) popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
      } else {
        // Check overlay layers (NPWS fire history, bushfire extents, RFS facilities)
        const overlayLayers = ['npws-fire-history-wildfire-fill', 'npws-fire-history-prescribed-fill', 'bushfire-extents-fill', 'rfs-facilities-circle', 'rfs-facilities-icon'].filter(id => map.getLayer(id));
        const overlayFeatures = overlayLayers.length > 0 ? map.queryRenderedFeatures(e.point, { layers: overlayLayers }) : [];
        if (overlayFeatures.length > 0) {
          map.getCanvas().style.cursor = 'pointer';
          const f = overlayFeatures[0];
          const p = f.properties;
          const layerId = f.layer?.id || '';
          let html = '';
          if (layerId.startsWith('npws-fire-history')) {
            const name = p.FireName || p.Label || 'Unnamed NPWS burn';
            const fireType = getNpwsFireTypeLabel(p.FireType);
            const fireNumber = p.FireNo || '—';
            const area = p.AreaHa != null && p.AreaHa !== '' ? `${Number(p.AreaHa).toLocaleString()} ha` : '—';
            const perimeter = p.PerimeterM != null && p.PerimeterM !== '' ? `${(Number(p.PerimeterM) / 1000).toFixed(1)} km` : '—';
            const start = formatAest(p.StartDate);
            const end = p.EndDate ? formatAest(p.EndDate) : 'Ongoing / unknown';
            const branch = p.NPWSBranch || '—';
            const areaOffice = p.NPWSArea || '—';
            html = `<strong>${name}</strong><br/>Type: ${fireType}<br/>Fire No: ${fireNumber}<br/>Start: ${start}<br/>End: ${end}<br/>Area: ${area}<br/>Perimeter: ${perimeter}<br/>Branch: ${branch}<br/>Area Office: ${areaOffice}`;
          } else if (layerId.startsWith('bushfire-extents')) {
            const name = p.fire_name || 'Unknown';
            const type = p.fire_type || '—';
            const area = p.area_ha != null ? `${Number(p.area_ha).toLocaleString()} ha` : '—';
            const perim = p.perim_km != null ? `${Number(p.perim_km).toFixed(1)} km` : '—';
            const agency = p.agency || '—';
            const ignition = p.ignition_date ? formatAest(p.ignition_date) : '—';
            const captured = p.capt_date ? formatAest(p.capt_date) : '—';
            html = `<strong>${name}</strong><br/>Type: ${type}<br/>Area: ${area}<br/>Perimeter: ${perim}<br/>Agency: ${agency}<br/>Ignition: ${ignition}<br/>Captured: ${captured}`;
          } else if (layerId.startsWith('rfs-facilities')) {
            const name = p.FACILITY_NAME || p.name || 'Unknown';
            const suburb = p.ABS_SUBURB || p.suburb || '—';
            const postcode = p.ABS_POSTCODE || '—';
            const status = p.FACILITY_OPERATIONALSTATUS || p.status || '—';
            const address = p.FACILITY_ADDRESS || '—';
            html = `<strong>${name}</strong><br/>Suburb: ${suburb}<br/>Postcode: ${postcode}<br/>Status: ${status}<br/>Address: ${address}`;
          }
          if (html) popup.setLngLat(e.lngLat).setHTML(html).addTo(map);
        } else {
          map.getCanvas().style.cursor = '';
          popup.remove();
        }
      }
    });

    map.on('style.load', () => {
      addDataSources(map);
      syncMapPresentation(map);
      setBasemapRev(r => r + 1);
      if (mapLoadedRef.current) {
        requestAnimationFrame(() => map.resize());
      }
    });

    map.on('load', () => {
      setMapLoaded(true);
      requestAnimationFrame(() => {
        syncMapPresentation(map);
        map.resize();
      });
    });

    mapRef.current = map;
    return () => {
      Object.keys(deaOverlayTrackersRef.current).forEach((layerId) => clearDeaOverlayTracker(layerId));
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // ---- Basemap switching (FIXED: re-applies data after style change) ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    if (!basemapReadyRef.current) {
      basemapReadyRef.current = true;
      return;
    }
    const map = mapRef.current;
    const basemap = BASEMAPS.find(b => b.id === layers.basemap);
    if (!basemap) return;

    map.setStyle(basemap.style);
  }, [layers.basemap, mapLoaded]);

  // ---- Full sync pass for initial load and late-arriving data ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const timer = setTimeout(() => {
      syncMapPresentation(mapRef.current);
    }, 0);
    return () => clearTimeout(timer);
  }, [mapLoaded, hotspots, events, ignitions, lgaData, showLga, layers.fireEvents, layers.ignitions, layers.hotspots, layers.weather, activeOverlays, deaLayerConfig]);

  // ---- Resize map when sidebar / layer panel toggles ----
  useEffect(() => {
    if (!mapRef.current) return;
    // Small delay so the flex layout settles before Mapbox measures
    const timer = setTimeout(() => {
      mapRef.current?.resize();
      if (mapLoadedRef.current && mapRef.current) {
        syncActiveDeaOverlayTrackers(mapRef.current, 'viewport-change');
      }
    }, 50);
    return () => clearTimeout(timer);
  }, [sidebarOpen, layerPanelOpen]);

  // ---- Update fire events data ----
  useEffect(() => {
    if (!events?.features) {
      dataRefs.current.events = EMPTY_FC;
      if (!ignitions?.features) {
        dataRefs.current.ignitions = EMPTY_FC;
      }
      const map = mapRef.current;
      if (mapLoaded && map) {
        map.getSource('fire-events')?.setData(EMPTY_FC);
        if (!ignitions?.features) {
          map.getSource('ignitions')?.setData(EMPTY_FC);
        }
      }
      return;
    }

    const coloured = {
      ...events,
      features: events.features.map((f, i) => ({
        ...f,
        properties: {
          ...f.properties,
          _color: eventColors[i % eventColors.length],
          _label: (() => {
            const stableId = f.properties?.stable_id ?? f.properties?.cluster_id ?? f.properties?.event_id ?? f.properties?.fire_id;
            const detections = f.properties?.n_detections ?? f.properties?.hotspot_count ?? f.properties?.n_unique_locations;
            if (stableId == null && detections == null) return '';
            if (detections == null || detections === '') return String(stableId);
            const det = Number(detections);
            return `${stableId} · ${Number.isFinite(det) ? det.toFixed(0) : detections}`;
          })(),
        },
      })),
    };

    dataRefs.current.events = coloured;
    const map = mapRef.current;
    if (mapLoaded && map) {
      map.getSource('fire-events')?.setData(coloured);
    }

    if (!ignitions?.features) {
      const derivedIgnitions = {
        type: 'FeatureCollection',
        features: events.features
          .filter(f => f.properties.ignition_lat && f.properties.ignition_lon)
          .map((f, i) => ({
            type: 'Feature',
            geometry: {
              type: 'Point',
              coordinates: [Number(f.properties.ignition_lon), Number(f.properties.ignition_lat)],
            },
            properties: { ...f.properties, _color: eventColors[i % eventColors.length] },
          })),
      };
      dataRefs.current.ignitions = derivedIgnitions;
      if (mapLoaded && map) {
        map.getSource('ignitions')?.setData(derivedIgnitions);
      }
    }
  }, [events, ignitions, mapLoaded, eventColors]);

  // ---- Update explicit ignition data (real-time) ----
  useEffect(() => {
    const data = ignitions?.features ? ignitions : EMPTY_FC;
    dataRefs.current.ignitions = data;
    const map = mapRef.current;
    if (mapLoaded && map) {
      map.getSource('ignitions')?.setData(data);
    }
  }, [ignitions, mapLoaded]);

  // ---- Update hotspots data with product shape + age colour symbology ----
  useEffect(() => {
    const data = hotspots || EMPTY_FC;

    let coloured = data;
    if (data.features?.length > 0) {
      const now = Date.now();
      coloured = {
        ...data,
        features: data.features.flatMap((f, featureIndex) => {
          const props = f.properties || {};
          const productId = props.product_id;
          const markerShape = getHotspotMarkerShape(productId);
          const isOld = isHotspotOlderThanThreshold(props, now);
          const hotspotColor = getHotspotAgeColor(props, now);
          // Use preserved original detection coordinates when available (pixel footprint mode)
          const center = (props._orig_lat != null && props._orig_lng != null)
            ? { lat: Number(props._orig_lat), lng: Number(props._orig_lng) }
            : getFeatureCenter(f);
          const sourceFeature = {
            ...f,
            properties: {
              ...props,
              _hs_color: hotspotColor,
              _is_old: isOld ? 1 : 0,
              _hs_shape: markerShape,
              _marker_icon: markerShape === 'triangle' ? getHotspotMarkerIconName(props, now) : null,
              _selected_marker_icon: markerShape === 'triangle' ? getHotspotMarkerIconName(props, now, 'selected-hotspot-triangle') : null,
              _feature_index: featureIndex,
              _coord_key: center ? makeCoordKey(center.lat, center.lng) : undefined,
            },
          };
          if (!center || f.geometry?.type === 'Point') {
            return [sourceFeature];
          }
          return [
            sourceFeature,
            {
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [center.lng, center.lat] },
              properties: {
                ...sourceFeature.properties,
                _derived_point: 1,
              },
            },
          ];
        }),
      };
    }

    dataRefs.current.hotspots = coloured;
    const map = mapRef.current;
    if (mapLoaded && map) {
      map.getSource('hotspots')?.setData(coloured);
      applySelectedHotspotData(map, coloured);
    }
  }, [hotspots, mapLoaded]);

  // ---- Update selected event highlight ----
  useEffect(() => {
    if (selectedEventId == null || !events?.features) {
      dataRefs.current.selected = EMPTY_FC;
      if (mapLoaded && mapRef.current) {
        mapRef.current.getSource('selected-event')?.setData(EMPTY_FC);
      }
      return;
    }

    const feat = events.features.find(f => {
      const p = f.properties;
      return getEventFeatureId(p) == selectedEventId;
    });

    const data = feat ? { type: 'FeatureCollection', features: [feat] } : EMPTY_FC;
    dataRefs.current.selected = data;
    if (mapLoaded && mapRef.current) {
      mapRef.current.getSource('selected-event')?.setData(data);
    }
  }, [selectedEventId, events, mapLoaded]);

  // ---- Layer visibility (mode-aware) ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    applyVisibility(mapRef.current, layers, mode);
  }, [layers.fireEvents, layers.hotspots, layers.ignitions, mapLoaded, mode]);

  // ---- Weather layer toggle ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    applyWeather(mapRef.current, layers.weather);
  }, [layers.weather, mapLoaded]);

  // ---- DEA WMS overlay layers toggle ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const layerDefs = deaLayerConfig?.layers || [];
    for (const layerDef of layerDefs) {
      if (layerDef.tile_mode === 'vector_query' || !activeOverlays?.includes(layerDef.id)) continue;
      const sourceId = `${DEA_SOURCE_PREFIX}${layerDef.id}`;
      if (!mapRef.current.getSource(sourceId)) {
        resetDeaOverlayTracker(layerDef.id, { resetRetries: true });
      }
    }
    applyDeaOverlays(mapRef.current, activeOverlays || [], deaLayerConfig, onOverlayLoadingChangeRef.current);
    syncActiveDeaOverlayTrackers(mapRef.current, 'overlay-toggle');
  }, [activeOverlays, deaLayerConfig, mapLoaded]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return undefined;
    const map = mapRef.current;
    const handleSourceDataLoading = (event) => {
      const sourceId = event.sourceId || '';
      if (!sourceId.startsWith(DEA_SOURCE_PREFIX)) return;
      const layerId = sourceId.replace(DEA_SOURCE_PREFIX, '');
      updateTrackedDeaTileState(layerId, event.coord, 'loading');
      const layerDef = getDeaLayerDefinition(layerId);
      if (layerDef) {
        syncDeaOverlayTracker(map, layerDef, 'tile-loading');
      }
    };
    const handleSourceData = (event) => {
      const sourceId = event.sourceId || '';
      if (!sourceId.startsWith(DEA_SOURCE_PREFIX)) return;
      const layerId = sourceId.replace(DEA_SOURCE_PREFIX, '');
      updateTrackedDeaTileState(layerId, event.coord, 'loaded');
      const layerDef = getDeaLayerDefinition(layerId);
      if (layerDef) {
        syncDeaOverlayTracker(map, layerDef, 'tile-loaded');
      }
    };
    const handleError = (event) => {
      const sourceId = event?.sourceId || event?.source?.id || '';
      if (!String(sourceId).startsWith(DEA_SOURCE_PREFIX)) return;
      const layerId = String(sourceId).replace(DEA_SOURCE_PREFIX, '');
      const message = event?.error?.message || `${layerId} tiles failed to load`;
      updateTrackedDeaTileState(layerId, event?.coord, 'error', message);
      const layerDef = getDeaLayerDefinition(layerId);
      if (layerDef) {
        syncDeaOverlayTracker(map, layerDef, 'tile-error');
      }
    };
    const handleViewportSettled = () => {
      syncActiveDeaOverlayTrackers(map, 'idle');
    };
    const handleViewportChanged = () => {
      syncActiveDeaOverlayTrackers(map, 'viewport-change');
    };
    map.on('sourcedataloading', handleSourceDataLoading);
    map.on('sourcedata', handleSourceData);
    map.on('error', handleError);
    map.on('idle', handleViewportSettled);
    map.on('moveend', handleViewportChanged);
    map.on('zoomend', handleViewportChanged);
    return () => {
      map.off('sourcedataloading', handleSourceDataLoading);
      map.off('sourcedata', handleSourceData);
      map.off('error', handleError);
      map.off('idle', handleViewportSettled);
      map.off('moveend', handleViewportChanged);
      map.off('zoomend', handleViewportChanged);
    };
  }, [mapLoaded]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    applyLgaLayer(mapRef.current, lgaData, showLga);
  }, [showLga, lgaData, mapLoaded]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    applyNpwsFireHistoryLayer(mapRef.current, npwsFireHistoryData, showNpwsFireHistory);
  }, [showNpwsFireHistory, npwsFireHistoryData, mapLoaded]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    applyBushfireExtentsLayer(mapRef.current, bushfireExtentsData, showBushfireExtents);
  }, [showBushfireExtents, bushfireExtentsData, mapLoaded]);

  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    applyRfsFacilitiesLayer(mapRef.current, rfsFacilitiesData, showRfsFacilities);
  }, [showRfsFacilities, rfsFacilitiesData, mapLoaded]);

  // ---- Simulation result layers ----
  useEffect(() => {
    if (!mapRef.current || !mapLoaded) return;
    const map = mapRef.current;

    const removeLayerGroup = (layerIds, sourceId) => {
      layerIds.forEach((id) => {
        if (map.getLayer(id)) map.removeLayer(id);
      });
      if (sourceId && map.getSource(sourceId)) {
        map.removeSource(sourceId);
      }
    };

    const removeAllSimulationLayers = () => {
      removeLayerGroup(['sim-isochrones-fill', 'sim-isochrones-outline', 'sim-isochrones-labels'], 'sim-isochrones');
      removeLayerGroup(['sim-roads-line', 'sim-roads-labels'], 'sim-roads');
      removeLayerGroup(['sim-arrival-time'], 'sim-arrival-time');
      removeLayerGroup(['sim-max-intensity'], 'sim-max-intensity');
      removeLayerGroup(['sim-ignition-point'], 'sim-ignition-point');
    };

    if (!simulationResult?.results) {
      removeAllSimulationLayers();
      return;
    }

    const results = simulationResult.results;

    /** Convert Inferno bounds to Mapbox image source coordinates */
    const toCoords = (bounds) => {
      if (!bounds) return null;
      if (Array.isArray(bounds) && bounds.length === 4 && Array.isArray(bounds[0])) {
        return bounds; // already [[w,n],[e,n],[e,s],[w,s]]
      }
      if (Array.isArray(bounds) && bounds.length === 4 && typeof bounds[0] === 'number') {
        const [west, south, east, north] = bounds;
        return [[west, north], [east, north], [east, south], [west, south]];
      }
      return bounds;
    };

    // Isochrones (GeoJSON vector) — inferno color palette
    if (results.isochrones?.json && activeSimLayers?.isochrones) {
      const isoGeoJson = typeof results.isochrones.json === 'string'
        ? JSON.parse(results.isochrones.json)
        : results.isochrones.json;

      if (isoGeoJson.features) {
        for (const f of isoGeoJson.features) {
          const p = f.properties || {};
          let hours = p.hours ?? p.hour ?? null;
          if (hours == null && p.time != null) {
            hours = Math.round((p.time / 3600) * 10) / 10;
          }
          if (hours == null && p.contour != null) hours = p.contour;
          if (hours == null && p.value != null) {
            hours = Math.round((p.value / 3600) * 10) / 10;
          }
          f.properties._hour_label = hours != null ? `${hours}h` : '';
          f.properties._hour_value = hours ?? 0;
          f.properties._draw_order = hours != null ? 1000 - hours : 0;
        }
      }

      const existingIsochrones = map.getSource('sim-isochrones');
      if (existingIsochrones) {
        existingIsochrones.setData(isoGeoJson);
      } else {
        map.addSource('sim-isochrones', { type: 'geojson', data: isoGeoJson });
      }

      // Inferno palette: black → purple → red → orange → yellow
      const infernoColorExpr = [
        'interpolate', ['linear'], ['get', '_hour_value'],
        0, '#000004',
        1, '#420a68',
        2, '#932667',
        3, '#dd513a',
        4, '#fca50a',
        6, '#fcffa4',
      ];

      if (!map.getLayer('sim-isochrones-fill')) {
        map.addLayer({
          id: 'sim-isochrones-fill',
          type: 'fill',
          source: 'sim-isochrones',
          layout: {
            'fill-sort-key': ['get', '_draw_order'],
          },
          paint: {
            'fill-color': infernoColorExpr,
            'fill-opacity': 0.25,
          },
        });
      }
      if (!map.getLayer('sim-isochrones-outline')) {
        map.addLayer({
          id: 'sim-isochrones-outline',
          type: 'line',
          source: 'sim-isochrones',
          layout: {
            'line-sort-key': ['get', '_draw_order'],
          },
          paint: {
            'line-color': infernoColorExpr,
            'line-width': 2.5,
            'line-opacity': 0.9,
          },
        });
      }
      if (!map.getLayer('sim-isochrones-labels')) {
        map.addLayer({
          id: 'sim-isochrones-labels',
          type: 'symbol',
          source: 'sim-isochrones',
          layout: {
            'symbol-sort-key': ['get', '_draw_order'],
            'symbol-placement': 'line',
            'text-field': ['get', '_hour_label'],
            'text-size': 12,
            'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
            'text-offset': [0, -0.8],
            'text-allow-overlap': false,
            'symbol-spacing': 200,
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.7)',
            'text-halo-width': 1.5,
          },
        });
      }
    } else {
      removeLayerGroup(['sim-isochrones-fill', 'sim-isochrones-outline', 'sim-isochrones-labels'], 'sim-isochrones');
    }

    // Roads (GeoJSON vector) — impacted roads colored by time
    if (results.roads?.json && activeSimLayers?.roads) {
      const roadsGeoJson = normaliseRoadsGeoJson(typeof results.roads.json === 'string'
        ? JSON.parse(results.roads.json)
        : results.roads.json);

      const existingRoads = map.getSource('sim-roads');
      if (existingRoads) {
        existingRoads.setData(roadsGeoJson);
      } else {
        map.addSource('sim-roads', { type: 'geojson', data: roadsGeoJson });
      }
      if (!map.getLayer('sim-roads-line')) {
        map.addLayer({
          id: 'sim-roads-line',
          type: 'line',
          source: 'sim-roads',
          paint: {
            'line-color': [
              'case',
              IMPACTED_ROAD_EXPR,
              '#ef4444',
              '#666666',
            ],
            'line-width': [
              'case',
              IMPACTED_ROAD_EXPR,
              3.5,
              1.5,
            ],
            'line-opacity': [
              'case',
              IMPACTED_ROAD_EXPR,
              0.95,
              0.4,
            ],
          },
        });
      }
      if (!map.getLayer('sim-roads-labels')) {
        map.addLayer({
          id: 'sim-roads-labels',
          type: 'symbol',
          source: 'sim-roads',
          layout: {
            'symbol-placement': 'line',
            'text-field': ['coalesce', ['get', 'name'], ['get', 'road_name'], ['get', 'NAME'], ''],
            'text-size': 10,
            'text-font': ['DIN Pro Regular', 'Arial Unicode MS Regular'],
            'text-offset': [0, -0.8],
            'text-allow-overlap': false,
            'symbol-spacing': 300,
          },
          paint: {
            'text-color': '#ffffff',
            'text-halo-color': 'rgba(0,0,0,0.6)',
            'text-halo-width': 1,
          },
        });
      }
    } else {
      removeLayerGroup(['sim-roads-line', 'sim-roads-labels'], 'sim-roads');
    }

    // Min arrival time (raster PNG — viridis palette from server)
    if (results.min_arrival_time?.b64 && results.min_arrival_time?.bounds && activeSimLayers?.arrival_time) {
      const coordinates = toCoords(results.min_arrival_time.bounds);
      if (coordinates) {
        const image = {
          url: 'data:image/png;base64,' + results.min_arrival_time.b64,
          coordinates,
        };
        const existingArrival = map.getSource('sim-arrival-time');
        if (existingArrival?.updateImage) {
          existingArrival.updateImage(image);
        } else if (existingArrival) {
          removeLayerGroup(['sim-arrival-time'], 'sim-arrival-time');
          map.addSource('sim-arrival-time', {
            type: 'image',
            ...image,
          });
        } else if (!existingArrival) {
          map.addSource('sim-arrival-time', {
            type: 'image',
            ...image,
          });
        }
        if (!map.getLayer('sim-arrival-time')) {
          map.addLayer({
            id: 'sim-arrival-time',
            type: 'raster',
            source: 'sim-arrival-time',
            paint: { 'raster-opacity': 0.7 },
          });
        }
      }
    } else {
      removeLayerGroup(['sim-arrival-time'], 'sim-arrival-time');
    }

    // Max intensity (raster PNG)
    if (results.max_intensity?.b64 && results.max_intensity?.bounds && activeSimLayers?.intensity) {
      const coordinates = toCoords(results.max_intensity.bounds);
      if (coordinates) {
        const image = {
          url: 'data:image/png;base64,' + results.max_intensity.b64,
          coordinates,
        };
        const existingIntensity = map.getSource('sim-max-intensity');
        if (existingIntensity?.updateImage) {
          existingIntensity.updateImage(image);
        } else if (existingIntensity) {
          removeLayerGroup(['sim-max-intensity'], 'sim-max-intensity');
          map.addSource('sim-max-intensity', {
            type: 'image',
            ...image,
          });
        } else if (!existingIntensity) {
          map.addSource('sim-max-intensity', {
            type: 'image',
            ...image,
          });
        }
        if (!map.getLayer('sim-max-intensity')) {
          map.addLayer({
            id: 'sim-max-intensity',
            type: 'raster',
            source: 'sim-max-intensity',
            paint: { 'raster-opacity': 0.7 },
          });
        }
      }
    } else {
      removeLayerGroup(['sim-max-intensity'], 'sim-max-intensity');
    }

    // Ignition point marker
    if (activeSimLayers?.ignition) {
      const ignitionPoints = simulationResult.ignition_points?.length
        ? simulationResult.ignition_points
        : (simulationResult.lat != null && simulationResult.lng != null
          ? [{ lat: simulationResult.lat, lng: simulationResult.lng, id: 'detection1' }]
          : []);
      if (ignitionPoints.length === 0) {
        removeLayerGroup(['sim-ignition-point'], 'sim-ignition-point');
      } else {
        const ignitionGeoJson = {
          type: 'FeatureCollection',
          features: ignitionPoints.map((point, index) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [point.lng, point.lat] },
            properties: { label: point.id || `Ignition ${index + 1}` },
          })),
        };
        const existingIgnition = map.getSource('sim-ignition-point');
        if (existingIgnition) {
          existingIgnition.setData(ignitionGeoJson);
        } else {
          map.addSource('sim-ignition-point', {
            type: 'geojson',
            data: ignitionGeoJson,
          });
        }
        if (!map.getLayer('sim-ignition-point')) {
          map.addLayer({
            id: 'sim-ignition-point',
            type: 'circle',
            source: 'sim-ignition-point',
            paint: {
              'circle-radius': 10,
              'circle-color': '#ff0000',
              'circle-stroke-color': '#ffffff',
              'circle-stroke-width': 3,
              'circle-opacity': 0.9,
            },
          });
        }
      }
    } else {
      removeLayerGroup(['sim-ignition-point'], 'sim-ignition-point');
    }
  }, [simulationResult, activeSimLayers, mapLoaded, basemapRev]);

  // ---- Fly to ----
  useEffect(() => {
    if (!mapRef.current || !flyTo) return;
    if (flyTo.bounds) {
      mapRef.current.fitBounds(flyTo.bounds, { padding: flyTo.padding || 60, duration: 1500 });
    } else if (flyTo.center) {
      mapRef.current.flyTo({ center: flyTo.center, zoom: flyTo.zoom || 10, duration: 1500 });
    }
  }, [flyTo]);

  const handleResetNSW = () => {
    if (mapRef.current) {
      mapRef.current.fitBounds(NSW_BOUNDS, { padding: 40, duration: 1000 });
    }
  };

  const chooserSelectedHotspot = hotspotChooser?.mode === 'simulation'
    ? selectedSimHotspot
    : selectedRealtimeHotspots?.[0];
  const chooserSelectedIndex = hotspotChooser?.candidates?.findIndex(candidate => candidate.idx === chooserSelectedHotspot?.idx) ?? -1;
  const hotspotChooserPosition = (() => {
    if (!hotspotChooser?.point || !containerRef.current) return null;
    const width = containerRef.current.clientWidth || 0;
    const height = containerRef.current.clientHeight || 0;
    const popoverWidth = 280;
    const popoverHeight = 220;
    return {
      left: Math.max(12, Math.min(hotspotChooser.point.x + 12, width - popoverWidth - 12)),
      top: Math.max(12, Math.min(hotspotChooser.point.y + 12, height - popoverHeight - 12)),
    };
  })();

  // ---- Bbox drawing mode ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    if (!bboxDrawMode) {
      map.getCanvas().style.cursor = '';
      return;
    }

    map.getCanvas().style.cursor = 'crosshair';
    let startPoint = null;

    const onMouseDown = (e) => {
      startPoint = [e.lngLat.lng, e.lngLat.lat];
      e.preventDefault();
    };

    const onMouseUp = (e) => {
      if (!startPoint) return;
      const endPoint = [e.lngLat.lng, e.lngLat.lat];
      const west = Math.min(startPoint[0], endPoint[0]);
      const south = Math.min(startPoint[1], endPoint[1]);
      const east = Math.max(startPoint[0], endPoint[0]);
      const north = Math.max(startPoint[1], endPoint[1]);
      startPoint = null;
      map.getCanvas().style.cursor = '';
      if (onBboxDrawn) onBboxDrawn([west, south, east, north]);
    };

    map.on('mousedown', onMouseDown);
    map.on('mouseup', onMouseUp);

    return () => {
      map.off('mousedown', onMouseDown);
      map.off('mouseup', onMouseUp);
      map.getCanvas().style.cursor = '';
    };
  }, [bboxDrawMode, mapLoaded, onBboxDrawn]);

  // ---- Drawn bbox overlay ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC = 'search-bbox';
    const FILL = 'search-bbox-fill';
    const LINE = 'search-bbox-line';

    if (!drawnBbox) {
      if (map.getLayer(FILL)) map.removeLayer(FILL);
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }

    const [west, south, east, north] = drawnBbox;
    const geojson = {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        },
        properties: {},
      }],
    };

    if (map.getSource(SRC)) {
      map.getSource(SRC).setData(geojson);
    } else {
      map.addSource(SRC, { type: 'geojson', data: geojson });
      map.addLayer({ id: FILL, type: 'fill', source: SRC, paint: { 'fill-color': '#3b82f6', 'fill-opacity': 0.15 } });
      map.addLayer({ id: LINE, type: 'line', source: SRC, paint: { 'line-color': '#3b82f6', 'line-width': 2, 'line-dasharray': [3, 2] } });
    }
  }, [drawnBbox, mapLoaded]);

  // ---- Highlighted LGA overlay ----
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC = 'highlighted-lga';
    const FILL = 'highlighted-lga-fill';
    const LINE = 'highlighted-lga-line';

    if (!highlightedLga || !lgaData?.features?.length) {
      if (map.getLayer(FILL)) map.removeLayer(FILL);
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getSource(SRC)) map.removeSource(SRC);
      return;
    }

    const getName = (f) => {
      const p = f.properties || {};
      return p.abb_name || p.LGA_NAME || p.lga_name || p.name || p.NAME || '';
    };
    const match = lgaData.features.find(f => getName(f).toLowerCase() === highlightedLga.toLowerCase());
    if (!match) return;

    const geojson = { type: 'FeatureCollection', features: [match] };

    if (map.getSource(SRC)) {
      map.getSource(SRC).setData(geojson);
    } else {
      map.addSource(SRC, { type: 'geojson', data: geojson });
      map.addLayer({ id: FILL, type: 'fill', source: SRC, paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.2 } });
      map.addLayer({ id: LINE, type: 'line', source: SRC, paint: { 'line-color': '#f59e0b', 'line-width': 3 } });
    }
  }, [highlightedLga, lgaData, mapLoaded]);

  // ---- Historical highlighted LGAs (from BRIGHT poller history) ----
  // Multi-match overlay. The poller may emit names with bracketed suffixes
  // like "Campbelltown (NSW)" that do not appear verbatim in our canonical
  // LGA dataset, so we normalise both sides before matching.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC = 'historical-highlighted-lga';
    const FILL = 'historical-highlighted-lga-fill';
    const LINE = 'historical-highlighted-lga-line';

    const cleanup = () => {
      if (map.getLayer(FILL)) map.removeLayer(FILL);
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getSource(SRC)) map.removeSource(SRC);
    };

    const entries = Array.isArray(historicalHighlightedLgas) ? historicalHighlightedLgas : [];
    if (!entries.length || !lgaData?.features?.length) {
      cleanup();
      return;
    }

    const normalise = (raw) => {
      if (!raw) return '';
      return String(raw)
        .trim()
        .replace(/\s*\([^)]*\)\s*$/, '')
        .trim()
        .toLowerCase();
    };

    const getName = (f) => {
      const p = f.properties || {};
      return p.abb_name || p.LGA_NAME || p.lga_name || p.name || p.NAME || '';
    };

    const targetNames = new Set();
    for (const entry of entries) {
      const candidates = [entry?.lga_name, entry?.raw_name, entry?.normalised];
      for (const cand of candidates) {
        const norm = normalise(cand);
        if (norm) targetNames.add(norm);
      }
    }

    const matches = lgaData.features.filter((f) => targetNames.has(normalise(getName(f))));
    if (!matches.length) {
      cleanup();
      return;
    }

    const geojson = { type: 'FeatureCollection', features: matches };

    if (map.getSource(SRC)) {
      map.getSource(SRC).setData(geojson);
    } else {
      map.addSource(SRC, { type: 'geojson', data: geojson });
      map.addLayer({ id: FILL, type: 'fill', source: SRC, paint: { 'fill-color': '#f97316', 'fill-opacity': 0.18 } });
      map.addLayer({ id: LINE, type: 'line', source: SRC, paint: { 'line-color': '#f97316', 'line-width': 2.5 } });
    }
  }, [historicalHighlightedLgas, lgaData, mapLoaded]);

  // Historical mode: pan/zoom to selected highlighted LGA when clicked in sidebar
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;
    if (mode !== 'historical') return;
    if (!selectedTargetLga) return;
    if (!lgaData?.features?.length) return;

    const normalise = (raw) => String(raw || '')
      .trim()
      .replace(/\s*\([^)]*\)\s*$/, '')
      .trim()
      .toLowerCase();
    const getName = (f) => {
      const p = f.properties || {};
      return p.abb_name || p.LGA_NAME || p.lga_name || p.name || p.NAME || '';
    };
    const target = normalise(selectedTargetLga);
    const match = lgaData.features.find((f) => normalise(getName(f)) === target);
    if (!match?.geometry) return;

    const bounds = new mapboxgl.LngLatBounds();
    const walk = (coords) => {
      if (typeof coords[0] === 'number') {
        bounds.extend(coords);
      } else {
        coords.forEach(walk);
      }
    };
    walk(match.geometry.coordinates);
    if (!bounds.isEmpty()) {
      map.fitBounds(bounds, { padding: 80, duration: 1200, maxZoom: 11 });
    }
  }, [selectedTargetLga, mode, lgaData, mapLoaded]);

  // ---- Target LGA boundaries (XPRIZE ArcGIS) ----
  // Hidden in historical mode — live targets don't apply to past dates
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const SRC = 'target-lga-areas';
    const FILL = 'target-lga-fill';
    const LINE = 'target-lga-line';
    const SELECTED_FILL = 'target-lga-selected-fill';
    const SELECTED_LINE = 'target-lga-selected-line';

    const cleanupSelected = () => {
      if (map.getLayer(SELECTED_FILL)) map.removeLayer(SELECTED_FILL);
      if (map.getLayer(SELECTED_LINE)) map.removeLayer(SELECTED_LINE);
      if (map.getSource('target-lga-selected')) map.removeSource('target-lga-selected');
    };

    const cleanupAll = () => {
      if (map.getLayer(FILL)) map.removeLayer(FILL);
      if (map.getLayer(LINE)) map.removeLayer(LINE);
      if (map.getSource(SRC)) map.removeSource(SRC);
      cleanupSelected();
    };

    // In historical mode, remove target LGA layers entirely
    if (mode === 'historical') {
      cleanupAll();
      return;
    }

    if (!targetAreas?.targets?.length) {
      cleanupAll();
      return;
    }

    // Build GeoJSON from target area geometries, matching against lgaData
    const getName = (f) => {
      const p = f.properties || {};
      return p.abb_name || p.LGA_NAME || p.lga_name || p.name || p.NAME || '';
    };
    const targetNames = new Set(targetAreas.targets.map(t => (t.lga_name || '').toLowerCase()));
    const targetFeatures = (lgaData?.features || []).filter(f => targetNames.has(getName(f).toLowerCase()));

    if (!targetFeatures.length) {
      cleanupAll();
      return;
    }

    const geojson = { type: 'FeatureCollection', features: targetFeatures };

    if (map.getSource(SRC)) {
      map.getSource(SRC).setData(geojson);
    } else {
      map.addSource(SRC, { type: 'geojson', data: geojson });
    }
    if (!map.getLayer(FILL)) {
      map.addLayer({ id: FILL, type: 'fill', source: SRC, paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.08 } });
    }
    if (!map.getLayer(LINE)) {
      map.addLayer({ id: LINE, type: 'line', source: SRC, paint: { 'line-color': '#ef4444', 'line-width': 2, 'line-dasharray': [4, 2] } });
    }

    // Highlight selected target LGA
    cleanupSelected();
    if (selectedTargetLga) {
      const selectedFeature = targetFeatures.find(f => getName(f).toLowerCase() === selectedTargetLga.toLowerCase());
      if (selectedFeature) {
        const selectedGeoJson = { type: 'FeatureCollection', features: [selectedFeature] };
        map.addSource('target-lga-selected', { type: 'geojson', data: selectedGeoJson });
        map.addLayer({ id: SELECTED_FILL, type: 'fill', source: 'target-lga-selected', paint: { 'fill-color': '#ef4444', 'fill-opacity': 0.25 } });
        map.addLayer({ id: SELECTED_LINE, type: 'line', source: 'target-lga-selected', paint: { 'line-color': '#ef4444', 'line-width': 4 } });
      }
    }
  }, [targetAreas, lgaData, selectedTargetLga, mapLoaded, mode]);

  const hasActiveRealtimeProducts = Array.isArray(activeProducts) && activeProducts.length > 0;
  const showHotspotLegend = layers.hotspots && (mode !== 'realtime' || hasActiveRealtimeProducts);
  const missingMapboxToken = !MAPBOX_TOKEN;

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      {missingMapboxToken && (
        <div className="mapbox-token-warning" role="alert">
          <strong>Map preview unavailable.</strong>
          <span>
            {' '}No Mapbox token was baked into this build. If you added or changed{' '}
            <code>.env.local</code>, run <code>npm run build</code> again before <code>npm run preview</code>.
          </span>
        </div>
      )}
      <button
        className="nsw-reset-btn"
        onClick={handleResetNSW}
        title="Reset view to NSW"
        disabled={missingMapboxToken}
      >
        NSW
      </button>
      {hotspotChooser?.candidates?.length > 1 && hotspotChooserPosition && (
        <div className="sim-stack-chooser" style={hotspotChooserPosition}>
          <div className="sim-stack-chooser-header">
            <span>{hotspotChooser.candidates.length} hotspots at this click</span>
            <button type="button" className="sim-stack-chooser-close" onClick={() => setHotspotChooser(null)}>×</button>
          </div>
          <div className="sim-stack-chooser-subtitle">
            {chooserSelectedIndex >= 0 ? `${chooserSelectedIndex + 1} of ${hotspotChooser.candidates.length} selected` : 'Defaulting to most recent'}
          </div>
          <div className="sim-stack-chooser-list">
            {hotspotChooser.candidates.map((candidate, index) => (
              <button
                key={`${candidate.idx}-${index}`}
                type="button"
                className={`sim-stack-chooser-item ${chooserSelectedHotspot?.idx === candidate.idx ? 'active' : ''}`}
                onClick={() => {
                  if (hotspotChooser.mode === 'simulation') {
                    setHotspotChooser(null);
                    onSelectSimulationHotspotRef.current?.(candidate, { flyTo: true });
                    return;
                  }
                  setHotspotChooser(null);
                  onSelectRealtimeHotspotRef.current?.(candidate, {
                    flyTo: true,
                    contextHotspots: [candidate, ...hotspotChooser.candidates.filter((item) => item.idx !== candidate.idx)],
                  });
                }}
              >
                <span className="sim-stack-chooser-item-index">#{index + 1}</span>
                <span className="sim-stack-chooser-item-body">
                  <span className="sim-stack-chooser-item-title">{candidate.displayId || candidate.id}</span>
                  <span className="sim-stack-chooser-item-meta">{getProductDisplayName(candidate.product_id)} · {candidate.datetime ? formatAest(candidate.datetime) : 'Unknown time'}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="map-legends-container">
        {simulationResult && (
          <SimulationLegend simulationResult={simulationResult} activeSimLayers={activeSimLayers} title={simulationLegendTitle} loadState={simulationLayerLoadState} />
        )}
        {showHotspotLegend && <HotspotLegend mode={mode} />}
        {activeOverlays?.length > 0 && deaLayerConfig && (
          <DeaOverlayLegends activeOverlays={activeOverlays} deaLayerConfig={deaLayerConfig} />
        )}
        {layers.weather && layers.weather !== 'none' && <WeatherLegend type={layers.weather} />}
      </div>
    </div>
  );
}

/* ================================================================
   Helper functions
   ================================================================ */

function addDataSources(map) {
  const ensureGeoJsonSource = (id) => {
    if (!map.getSource(id)) {
      map.addSource(id, { type: 'geojson', data: EMPTY_FC });
    }
  };
  const ensureLayer = (id, definition) => {
    if (!map.getLayer(id)) {
      map.addLayer(definition);
    }
  };

  ensureHotspotMarkerImages(map);

  // Fire event perimeters
  ensureGeoJsonSource('fire-events');
  ensureLayer('fire-events-fill', {
    id: 'fire-events-fill', type: 'fill', source: 'fire-events',
    paint: { 'fill-color': ['coalesce', ['get', '_color'], '#ff6b35'], 'fill-opacity': 0.25 },
  });
  ensureLayer('fire-events-outline', {
    id: 'fire-events-outline', type: 'line', source: 'fire-events',
    paint: { 'line-color': ['coalesce', ['get', '_color'], '#ff6b35'], 'line-width': 2, 'line-opacity': 0.8 },
  });
  ensureLayer('fire-events-labels', {
    id: 'fire-events-labels', type: 'symbol', source: 'fire-events',
    layout: {
      'text-field': ['get', '_label'],
      'text-size': 12,
      'text-font': ['DIN Pro Medium', 'Arial Unicode MS Regular'],
      'text-allow-overlap': false,
      'text-ignore-placement': false,
    },
    paint: {
      'text-color': '#fff7cc',
      'text-halo-color': 'rgba(0, 0, 0, 0.82)',
      'text-halo-width': 1.5,
    },
  });

  // Hotspots (polygon + point) — coloured by _hs_color when available
  ensureGeoJsonSource('hotspots');
  ensureLayer('hotspots-fill', {
    id: 'hotspots-fill', type: 'fill', source: 'hotspots',
    filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
    paint: {
      'fill-color': ['coalesce', ['get', '_hs_color'], HOTSPOT_ACTIVE_COLOR],
      'fill-opacity': [
        'case',
        ['==', ['get', '_is_old'], 1], 0.22,
        0.5,
      ],
    },
  });
  ensureLayer('hotspots-outline', {
    id: 'hotspots-outline', type: 'line', source: 'hotspots',
    filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
    paint: {
      'line-color': ['coalesce', ['get', '_hs_color'], HOTSPOT_ACTIVE_COLOR],
      'line-width': 2.2,
      'line-opacity': ['case', ['==', ['get', '_is_old'], 1], 0.72, 1],
    },
  });
  ensureLayer('hotspots-circle', {
    id: 'hotspots-circle', type: 'circle', source: 'hotspots',
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'product_id'], 'bright_ahi']],
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        5, ['case', ['==', ['get', '_is_old'], 1], 5, 6.5],
        8, ['case', ['==', ['get', '_is_old'], 1], 6, 8],
        11, ['case', ['==', ['get', '_is_old'], 1], 7, 10],
      ],
      'circle-color': ['coalesce', ['get', '_hs_color'], HOTSPOT_ACTIVE_COLOR],
      'circle-opacity': ['case', ['==', ['get', '_is_old'], 1], 0.72, 0.96],
      'circle-stroke-color': '#fff7cc',
      'circle-stroke-width': 1.8,
      'circle-blur': 0.08,
    },
  });
  ensureLayer('hotspots-triangle', {
    id: 'hotspots-triangle', type: 'symbol', source: 'hotspots',
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'product_id'], 'bright_ahi']],
    layout: {
      'icon-image': ['coalesce', ['get', '_marker_icon'], HOTSPOT_TRIANGLE_ICON_IDS.red],
      'icon-size': [
        'interpolate', ['linear'], ['zoom'],
        5, 0.46,
        8, 0.56,
        11, 0.7,
      ],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-opacity': ['case', ['==', ['get', '_is_old'], 1], 0.78, 0.98],
    },
  });

  ensureGeoJsonSource('selected-hotspots');
  ensureLayer('selected-hotspots-fill', {
    id: 'selected-hotspots-fill', type: 'fill', source: 'selected-hotspots',
    filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
    paint: { 'fill-color': ['coalesce', ['get', '_hs_color'], HOTSPOT_ACTIVE_COLOR], 'fill-opacity': 0.16 },
  });
  ensureLayer('selected-hotspots-outline', {
    id: 'selected-hotspots-outline', type: 'line', source: 'selected-hotspots',
    filter: ['any', ['==', ['geometry-type'], 'Polygon'], ['==', ['geometry-type'], 'MultiPolygon']],
    paint: { 'line-color': '#ffffff', 'line-width': 3, 'line-opacity': 1 },
  });
  ensureLayer('selected-hotspots-circle', {
    id: 'selected-hotspots-circle', type: 'circle', source: 'selected-hotspots',
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'product_id'], 'bright_ahi']],
    paint: {
      'circle-radius': [
        'interpolate', ['linear'], ['zoom'],
        5, 8,
        8, 10,
        11, 12,
      ],
      'circle-color': ['coalesce', ['get', '_hs_color'], HOTSPOT_ACTIVE_COLOR],
      'circle-opacity': 0.34,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 3,
    },
  });
  ensureLayer('selected-hotspots-triangle', {
    id: 'selected-hotspots-triangle', type: 'symbol', source: 'selected-hotspots',
    filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'product_id'], 'bright_ahi']],
    layout: {
      'icon-image': ['coalesce', ['get', '_selected_marker_icon'], HOTSPOT_TRIANGLE_ICON_IDS.selectedRed],
      'icon-size': [
        'interpolate', ['linear'], ['zoom'],
        5, 0.54,
        8, 0.66,
        11, 0.82,
      ],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    },
    paint: {
      'icon-opacity': 1,
    },
  });

  // Ignition points
  ensureGeoJsonSource('ignitions');
  ensureLayer('ignitions-circle', {
    id: 'ignitions-circle', type: 'circle', source: 'ignitions',
    paint: {
      'circle-radius': 10,
      'circle-color': '#1f2937',
      'circle-stroke-color': '#fde68a',
      'circle-stroke-width': 2.5,
      'circle-opacity': 0.95,
    },
  });
  ensureLayer('ignitions-core', {
    id: 'ignitions-core', type: 'circle', source: 'ignitions',
    paint: {
      'circle-radius': 4.5,
      'circle-color': '#f59e0b',
      'circle-stroke-color': '#fff7cc',
      'circle-stroke-width': 1,
      'circle-opacity': 1,
    },
  });

  // Selected event highlight
  ensureGeoJsonSource('selected-event');
  ensureLayer('selected-event-fill', {
    id: 'selected-event-fill', type: 'fill', source: 'selected-event',
    paint: { 'fill-color': '#fde68a', 'fill-opacity': 0.14 },
  });
  ensureLayer('selected-event-outline', {
    id: 'selected-event-outline', type: 'line', source: 'selected-event',
    paint: { 'line-color': '#fde68a', 'line-width': 4.5, 'line-opacity': 1 },
  });
}

function applyVisibility(map, layers, currentMode) {
  const fireVis = (currentMode !== 'simulation' && layers.fireEvents) ? 'visible' : 'none';
  const ignitionVis = currentMode === 'realtime'
    ? (layers.ignitions ? 'visible' : 'none')
    : fireVis;
  const hotVis = layers.hotspots ? 'visible' : 'none';

  for (const id of ['fire-events-fill', 'fire-events-outline', 'fire-events-labels', 'selected-event-fill', 'selected-event-outline']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', fireVis);
  }
  if (map.getLayer('ignitions-circle')) map.setLayoutProperty('ignitions-circle', 'visibility', ignitionVis);
  if (map.getLayer('ignitions-core')) map.setLayoutProperty('ignitions-core', 'visibility', ignitionVis);
  for (const id of ['hotspots-fill', 'hotspots-outline', 'hotspots-circle', 'hotspots-triangle', 'selected-hotspots-fill', 'selected-hotspots-outline', 'selected-hotspots-circle', 'selected-hotspots-triangle']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', hotVis);
  }
}

function applyWeather(map) {
  if (map.getLayer('weather-overlay')) map.removeLayer('weather-overlay');
  if (map.getSource('weather-overlay')) map.removeSource('weather-overlay');
}

/**
 * Apply/remove DEA WMS overlay layers based on active overlay IDs.
 * Each overlay is a separate raster source + layer.
 * NSW bbox is used as bounds to restrict tile loading.
 */
function applyDeaOverlays(map, activeOverlays, deaLayerConfig, onOverlayLoadingChange) {
  if (!deaLayerConfig?.layers) return;

  const wmsBase = deaLayerConfig.wms_base || 'https://ows.dea.ga.gov.au/';
  const allLayers = deaLayerConfig.layers;
  const beforeId = map.getLayer('fire-events-fill') ? 'fire-events-fill' : undefined;

  for (const layerDef of allLayers) {
    const sourceId = `dea-overlay-${layerDef.id}`;
    const mapLayerId = `dea-overlay-${layerDef.id}-raster`;
    const isActive = activeOverlays.includes(layerDef.id);

    if (layerDef.tile_mode === 'vector_query') {
      if (map.getLayer(mapLayerId)) map.removeLayer(mapLayerId);
      if (map.getSource(sourceId)) map.removeSource(sourceId);
      continue;
    }

    if (isActive) {
      mountDeaOverlaySource(map, layerDef, beforeId, onOverlayLoadingChange, wmsBase);
    } else {
      removeDeaOverlaySource(map, layerDef, onOverlayLoadingChange);
    }
  }
}

/* ================================================================
   Map overlay legends
   ================================================================ */

/* ================================================================
   DEA overlay legends
   ================================================================ */

const LC_LEGEND = [
  { color: '#347834', label: 'Woody Vegetation' },
  { color: '#80b040', label: 'Herbaceous Vegetation' },
  { color: '#22d3ee', label: 'Aquatic Vegetation' },
  { color: '#c8a040', label: 'Cultivated' },
  { color: '#9ca3af', label: 'Bare / Sparse' },
  { color: '#3b82f6', label: 'Water' },
  { color: '#ef4444', label: 'Artificial Surface' },
];

const FMC_LEGEND = [
  { color: '#8b0000', label: '0–50% (Very Dry)' },
  { color: '#ff4500', label: '50–80% (Dry)' },
  { color: '#ffa500', label: '80–100% (Moderate)' },
  { color: '#ffd700', label: '100–120% (Moist)' },
  { color: '#90ee90', label: '120–150% (Green)' },
  { color: '#228b22', label: '150–200% (Very Green)' },
  { color: '#006400', label: '200–300% (Wet)' },
];

const FC_LEGEND = [
  { color: '#009900', label: 'Green Vegetation' },
  { color: '#966400', label: 'Non-green (Dry)' },
  { color: '#c8a040', label: 'Bare Soil' },
];

const WO_LEGEND = [
  { color: '#08306b', label: '100% (Permanent Water)' },
  { color: '#2171b5', label: '50–99% (Frequent)' },
  { color: '#6baed6', label: '20–49% (Moderate)' },
  { color: '#bdd7e7', label: '1–19% (Infrequent)' },
  { color: 'rgba(0,0,0,0)', label: '0% (Never Wet)' },
];

const OVERLAY_LEGENDS = {
  fmc: { title: 'Fuel Moisture Content', items: FMC_LEGEND, note: 'Source: DEA WMTS / Sentinel-2 Mosaic' },
  fractional_cover: { title: 'Fractional Cover', items: FC_LEGEND, note: 'Source: DEA WMTS / Landsat annual fractional cover' },
  water_observations: { title: 'Water Frequency', items: WO_LEGEND, note: 'Source: DEA WMTS / Landsat annual water observations' },
  land_cover: { title: '🌿 Land Cover', items: LC_LEGEND, note: 'Source: DEA WMTS / Landsat annual land cover' },
  npws_fire_history: {
    title: 'NPWS Fire History',
    items: [
      { color: 'rgba(220, 38, 38, 0.08)', label: 'Wildfire', border: '2px solid #dc2626' },
      { color: 'rgba(250, 204, 21, 0.16)', label: 'Prescribed Burn', border: '2px dashed #f59e0b' },
    ],
    note: 'Wildfire: red outline. Prescribed burn: dashed amber outline.',
  },
};

const HOTSPOT_LEGEND_ITEMS = [
  { shape: 'circle', color: HOTSPOT_ACTIVE_COLOR, label: 'BRIGHT AHI v2.0 (obs ≤ 10 mins)' },
  { shape: 'triangle', color: HOTSPOT_ACTIVE_COLOR, label: 'BRIGHT AHI v1.86 (obs ≤ 10 mins)' },
  { shape: 'circle', color: HOTSPOT_OLD_COLOR, label: 'BRIGHT AHI v2.0 (obs > 10 mins)' },
  { shape: 'triangle', color: HOTSPOT_OLD_COLOR, label: 'BRIGHT AHI v1.86 (obs > 10 mins)' },
];

const HOTSPOT_LEGEND_ITEMS_HISTORICAL = [
  { shape: 'circle', color: HOTSPOT_OLD_COLOR, label: 'BRIGHT AHI v2.0' },
];

const FC_DETAIL_ITEMS = [
  { label: 'NG', color: '#2f2df4', description: 'Dominant non-green vegetation cover (> 2/3 non-green vegetation cover).' },
  { label: 'NG Mix', color: '#7a4ca5', description: 'Mixture of all cover fractions, dominated by non-green cover.' },
  { label: 'NG & Bare', color: '#cc2f7a', description: 'Predominantly non-green vegetation and bare ground with minimal green cover.' },
  { label: 'NG & Green', color: '#67a894', description: 'Predominantly non-green and green vegetation with minimal bare ground.' },
  { label: 'Bare', color: '#ff4208', description: 'Dominant bare ground (> 2/3 bare ground).' },
  { label: 'Bare Mix', color: '#f06212', description: 'Mixture of all cover fractions, dominated by bare ground.' },
  { label: 'Bare & Green', color: '#a8f000', textColor: '#173000', description: 'Predominantly bare ground and green cover with minimal non-green vegetation.' },
  { label: 'Green Mix', color: '#39da75', description: 'Mixture of all cover fractions, dominated by green vegetation.' },
  { label: 'Green', color: '#15f000', textColor: '#083300', description: 'Dominant green vegetation cover (> 2/3 green vegetation cover).' },
];

const WATER_DETAIL_ITEMS = [
  { label: 'X', color: 'transparent', outline: '1px solid rgba(17, 24, 39, 0.35)', marker: 'X', description: 'No-data or water not detected.' },
  { label: '100%', color: '#08306b', description: 'Permanent water.' },
  { label: '50–99%', color: '#2171b5', description: 'Frequent water observations.' },
  { label: '20–49%', color: '#6baed6', description: 'Moderate water occurrence.' },
  { label: '1–19%', color: '#bdd7e7', description: 'Infrequent water occurrence.' },
  { label: '0%', color: 'rgba(0,0,0,0)', outline: '1px solid rgba(17, 24, 39, 0.2)', description: 'Never wet.' },
];

function LegendTooltip({ text }) {
  const triggerRef = useRef(null);
  const bubbleRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [placement, setPlacement] = useState('right');

  const updatePlacement = () => {
    const trigger = triggerRef.current;
    if (!trigger) return;

    const rect = trigger.getBoundingClientRect();
    const bubbleRect = bubbleRef.current?.getBoundingClientRect();
    const tooltipWidth = bubbleRect?.width || 220;
    const tooltipHeight = bubbleRect?.height || 88;
    const gap = 4;
    const fitsRight = rect.right + gap + tooltipWidth <= window.innerWidth - 12;
    const fitsLeft = rect.left - gap - tooltipWidth >= 12;
    const fitsBottom = rect.bottom + gap + tooltipHeight <= window.innerHeight - 12;

    if (fitsRight) {
      setPlacement('right');
      return;
    }

    if (fitsLeft) {
      setPlacement('left');
      return;
    }

    setPlacement(fitsBottom ? 'bottom' : 'top');
  };

  useEffect(() => {
    if (!visible) return undefined;

    const handleWindowChange = () => updatePlacement();
    window.addEventListener('resize', handleWindowChange);
    window.addEventListener('scroll', handleWindowChange, true);
    return () => {
      window.removeEventListener('resize', handleWindowChange);
      window.removeEventListener('scroll', handleWindowChange, true);
    };
  }, [visible]);

  return (
    <span
      className="dea-legend-tooltip"
      onMouseEnter={() => {
        setVisible(true);
        requestAnimationFrame(updatePlacement);
      }}
      onMouseLeave={() => setVisible(false)}
    >
      <span
        ref={triggerRef}
        className="dea-legend-tooltip-trigger"
        aria-label={text}
        role="button"
        tabIndex={0}
        onClick={() => setVisible(v => {
          const next = !v;
          if (next) requestAnimationFrame(updatePlacement);
          return next;
        })}
        onFocus={() => {
          setVisible(true);
          requestAnimationFrame(updatePlacement);
        }}
        onBlur={() => setVisible(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { setVisible(false); e.stopPropagation(); }
        }}
      >
        ?
      </span>
      {visible ? (
        <span
          ref={bubbleRef}
          className={`dea-legend-tooltip-bubble ${placement}`}
          onMouseEnter={() => setVisible(true)}
          onMouseLeave={() => setVisible(false)}
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}

function CompactLegendRow({ label, color, description, outline = null, marker = null }) {
  return (
    <div className="dea-legend-row">
      <span className="dea-legend-swatch" style={{ background: color, border: outline || undefined }}>
        {marker ? <span className="dea-legend-swatch-marker">{marker}</span> : null}
      </span>
      <span className="dea-legend-row-label">{label}</span>
      {description ? <LegendTooltip text={description} /> : null}
    </div>
  );
}

function OverlayLegendCard({ title, note, children, className = '' }) {
  return (
    <section className={`overlay-legend-card ${className}`.trim()}>
      <div className="overlay-legend-title">{title}</div>
      {children}
      {note ? <div className="overlay-legend-note">{note}</div> : null}
    </section>
  );
}

function HotspotLegendSymbol({ shape, color }) {
  if (shape === 'triangle') {
    return <span className="hotspot-legend-symbol hotspot-legend-symbol-triangle" style={{ '--hotspot-legend-color': color }} aria-hidden="true" />;
  }

  return <span className="hotspot-legend-symbol hotspot-legend-symbol-circle" style={{ background: color }} aria-hidden="true" />;
}

function HotspotLegend({ mode }) {
  const items = mode === 'historical' ? HOTSPOT_LEGEND_ITEMS_HISTORICAL : HOTSPOT_LEGEND_ITEMS;
  return (
    <OverlayLegendCard title="Hotspot Legend" className="hotspot-legend-card">
      <div className="hotspot-legend-list">
        {items.map((item) => (
          <div key={item.label} className="hotspot-legend-row">
            <HotspotLegendSymbol shape={item.shape} color={item.color} />
            <span className="hotspot-legend-label">{item.label}</span>
          </div>
        ))}
      </div>
    </OverlayLegendCard>
  );
}

function FuelMoistureLegend() {
  return (
    <OverlayLegendCard title="Fuel Moisture Content" note="Source: DEA WMTS / Sentinel-2 Mosaic">
      <div className="legend-gradient-horizontal fmc-gradient" aria-hidden="true" />
      <div className="legend-scale">
        <span>0%</span>
        <span>50%</span>
        <span>100%</span>
        <span>150%</span>
      </div>
      <div className="legend-caption">Fuel Moisture Content (Weight Percent)</div>
    </OverlayLegendCard>
  );
}

function FractionalCoverLegend() {
  return (
    <OverlayLegendCard title="Fractional Cover" note="Source: DEA WMTS / Landsat annual fractional cover">
      <div className="dea-legend-list" role="img" aria-label="Fractional cover legend categories">
        {FC_DETAIL_ITEMS.map((item) => (
          <CompactLegendRow
            key={item.label}
            color={item.color}
            label={item.label}
            description={item.description}
            outline={item.textColor ? '1px solid rgba(0, 0, 0, 0.15)' : null}
          />
        ))}
      </div>
      <div className="overlay-legend-note overlay-legend-note-secondary">Hover the ? markers for class descriptions.</div>
    </OverlayLegendCard>
  );
}

function WaterFrequencyLegend() {
  return (
    <OverlayLegendCard title="Water Frequency" note="Source: DEA WMTS / Landsat annual water observations">
      <div className="dea-legend-list">
        {WATER_DETAIL_ITEMS.map((item) => (
          <CompactLegendRow
            key={item.label}
            color={item.color}
            label={item.label}
            description={item.description}
            outline={item.outline}
            marker={item.marker}
          />
        ))}
      </div>
    </OverlayLegendCard>
  );
}

function DeaOverlayLegends({ activeOverlays, deaLayerConfig }) {
  const legendsToShow = activeOverlays.filter(id => OVERLAY_LEGENDS[id]);

  if (legendsToShow.length === 0) return null;

  return (
    <>
      {legendsToShow.map(id => {
        const legendDef = OVERLAY_LEGENDS[id];

        if (id === 'fmc') return <FuelMoistureLegend key={id} />;
        if (id === 'fractional_cover') return <FractionalCoverLegend key={id} />;
        if (id === 'water_observations') return <WaterFrequencyLegend key={id} />;

        if (legendDef) {
          return (
            <OverlayLegendCard key={id} title={legendDef.title} note={legendDef.note} className="land-cover-legend-box">
              {legendDef.items.map(({ color, label, border }) => (
                <div key={label} className="dea-legend-row">
                  <span className="dea-legend-swatch" style={{ background: color, border: border || undefined }} />
                  <span className="dea-legend-row-label">{label}</span>
                </div>
              ))}
            </OverlayLegendCard>
          );
        }

        return null;
      })}
    </>
  );
}

const PRECIP_LEGEND = [
  { color: 'rgba(0,130,255,0.4)', label: 'Light' },
  { color: 'rgba(0,200,0,0.6)', label: 'Moderate' },
  { color: 'rgba(255,255,0,0.7)', label: 'Heavy' },
  { color: 'rgba(255,130,0,0.8)', label: 'Very Heavy' },
  { color: 'rgba(255,0,0,0.9)', label: 'Extreme' },
];

const TEMP_LEGEND = [
  { color: '#2b1189', label: '< -30°C' },
  { color: '#3f51b5', label: '-20°C' },
  { color: '#00bcd4', label: '-10°C' },
  { color: '#009688', label: '0°C' },
  { color: '#4caf50', label: '10°C' },
  { color: '#ffeb3b', label: '20°C' },
  { color: '#ff9800', label: '30°C' },
  { color: '#f44336', label: '40°C' },
  { color: '#880e4f', label: '> 50°C' },
];

const CLOUD_LEGEND = [
  { color: 'rgba(255,255,255,0.0)', label: 'Clear' },
  { color: 'rgba(255,255,255,0.25)', label: '25%' },
  { color: 'rgba(255,255,255,0.5)', label: '50%' },
  { color: 'rgba(255,255,255,0.75)', label: '75%' },
  { color: 'rgba(255,255,255,1.0)', label: '100%' },
];

const WIND_LEGEND = [
  { color: '#ffffcc', label: '< 5 m/s' },
  { color: '#a1dab4', label: '5–10' },
  { color: '#41b6c4', label: '10–15' },
  { color: '#2c7fb8', label: '15–20' },
  { color: '#253494', label: '> 20 m/s' },
];

function WeatherLegend({ type }) {
  if (type === 'precipitation') {
    return (
      <div className="map-legend weather-legend-box">
        <div className="map-legend-title">🌧 Precipitation</div>
        <div className="precip-gradient">
          {PRECIP_LEGEND.map(({ color, label }) => (
            <div key={label} className="map-legend-row">
              <span className="map-legend-swatch" style={{ background: color }} />
              <span>{label}</span>
            </div>
          ))}
        </div>
        <div className="map-legend-note">Source: OpenWeatherMap</div>
      </div>
    );
  }

  if (type === 'temperature') {
    return (
      <div className="map-legend weather-legend-box">
        <div className="map-legend-title">🌡 Temperature</div>
        {TEMP_LEGEND.map(({ color, label }) => (
          <div key={label} className="map-legend-row">
            <span className="map-legend-swatch" style={{ background: color }} />
            <span>{label}</span>
          </div>
        ))}
        <div className="map-legend-note">Source: OpenWeatherMap</div>
      </div>
    );
  }

  if (type === 'clouds') {
    return (
      <div className="map-legend weather-legend-box">
        <div className="map-legend-title">☁ Cloud Cover</div>
        {CLOUD_LEGEND.map(({ color, label }) => (
          <div key={label} className="map-legend-row">
            <span className="map-legend-swatch" style={{ background: color, border: '1px solid rgba(255,255,255,0.3)' }} />
            <span>{label}</span>
          </div>
        ))}
        <div className="map-legend-note">Source: OpenWeatherMap</div>
      </div>
    );
  }

  if (type === 'wind') {
    return (
      <div className="map-legend weather-legend-box">
        <div className="map-legend-title">💨 Wind Speed</div>
        {WIND_LEGEND.map(({ color, label }) => (
          <div key={label} className="map-legend-row">
            <span className="map-legend-swatch" style={{ background: color }} />
            <span>{label}</span>
          </div>
        ))}
        <div className="map-legend-note">Source: OpenWeatherMap</div>
      </div>
    );
  }

  return null;
}
