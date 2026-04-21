import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  useStatus, useFireEvents, useHotspots, useTimeRange, usePolling,
  useHistoricalDates, useHistoricalDay, useRealtimeEvents, useRealtimeIgnitions, useRealtimeProducts, useRealtimeHotspots, useRealtimeStatus,
  useDeaLayers, useDeaCacheStats, useLgaBoundaries, useSavedSimulationRuns,
  useBushfireExtents, useRfsFacilities, useNpwsFireHistory,
} from './hooks/useData';
import Header from './components/Header';
import StaticArchiveBanner from './components/StaticArchiveBanner';
import Sidebar from './components/Sidebar';
import MapView from './components/MapView';
import LayerPanel from './components/LayerPanel';
import TimeSlider from './components/TimeSlider';
import SimulationPanel from './components/SimulationPanel';
import SearchToolPanel from './components/SearchToolPanel';
import ToolsMenu from './components/ToolsMenu';
import FrpPlotPanel from './components/FrpPlotPanel';
import { getSelectionKey } from './utils/frpNormalize';
import { startSimulation, getSimulationProgress, getSimulationResults, getSavedSimulationRun, getHistoricalSimulationRun, getLgaTargetAreas, getHighlightedLgas } from './api';
import { startPoll, stopPoll } from './utils/poll';

function parseEnvDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function getFixedDemoWindow() {
  const start = parseEnvDate(import.meta.env.VITE_DEMO_FIXED_WINDOW_START);
  const end = parseEnvDate(import.meta.env.VITE_DEMO_FIXED_WINDOW_END);
  if (!start || !end || end.getTime() <= start.getTime()) return null;
  return { start, end };
}

function getFixedDemoWindowHours(fixedWindow) {
  if (!fixedWindow) return null;
  const hours = Math.round((fixedWindow.end.getTime() - fixedWindow.start.getTime()) / 3600000);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

const FIXED_DEMO_WINDOW = getFixedDemoWindow();
const FIXED_DEMO_WINDOW_HOURS = getFixedDemoWindowHours(FIXED_DEMO_WINDOW);
const HOTSPOT_MONITORING_WINDOW_OPTIONS = Array.from(
  new Set([12, 24, 48, 72, FIXED_DEMO_WINDOW_HOURS].filter((hours) => Number.isFinite(hours) && hours > 0))
).sort((left, right) => left - right);

function getInitialMonitoringWindowHours() {
  if (FIXED_DEMO_WINDOW_HOURS) return FIXED_DEMO_WINDOW_HOURS;
  if (typeof window === 'undefined') return 12;
  const params = new URLSearchParams(window.location.search);
  const hours = Number(params.get('hotspot_hours'));
  return HOTSPOT_MONITORING_WINDOW_OPTIONS.includes(hours) ? hours : 12;
}

function getInitialLayers() {
  const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;
  return {
    fireEvents: true,
    ignitions: true,
    hotspots: !isMobile,
    savedSimulations: true,
    basemap: isMobile ? 'streets' : 'satellite',
    weather: 'none',
    landCover: false,
  };
}

function toUtcIso(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function buildRealtimeWindow(hours) {
  if (FIXED_DEMO_WINDOW) {
    return {
      start: FIXED_DEMO_WINDOW.start,
      end: FIXED_DEMO_WINDOW.end,
      startUtc: toUtcIso(FIXED_DEMO_WINDOW.start),
      endUtc: toUtcIso(FIXED_DEMO_WINDOW.end),
    };
  }
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3600000);
  return {
    start,
    end,
    startUtc: toUtcIso(start),
    endUtc: toUtcIso(end),
  };
}

function getFeatureWindowTime(feature, candidateKeys) {
  const props = feature?.properties || {};
  for (const key of candidateKeys) {
    const value = props[key];
    if (!value) continue;
    const timestamp = new Date(value).getTime();
    if (!Number.isNaN(timestamp)) return timestamp;
  }
  return null;
}

function filterFeatureCollectionByWindow(featureCollection, start, end, candidateKeys) {
  if (!featureCollection?.features) return featureCollection;
  const startMs = start.getTime();
  const endMs = end.getTime();
  return {
    ...featureCollection,
    features: featureCollection.features.filter((feature) => {
      const time = getFeatureWindowTime(feature, candidateKeys);
      return time == null || (time >= startMs && time <= endMs);
    }),
  };
}

function isTimestampWithinWindow(value, start, end) {
  if (!value || !start || !end) return false;
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return false;
  return timestamp >= start.getTime() && timestamp <= end.getTime();
}

// Fire event colour palette
const EVENT_COLORS = [
  '#ff6b35', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa',
  '#f472b6', '#fb923c', '#38bdf8', '#4ade80', '#facc15',
  '#c084fc', '#f87171', '#2dd4bf', '#e879f9', '#22d3ee',
];

// Product colours for real-time hotspots
const PRODUCT_COLORS = {
  bright_ahi: '#ff6b35',
  bright_s3: '#ff3333',
};

const SIM_RESULT_LAYER_CONFIG = {
  isochrones: { activeKey: 'isochrones', label: 'Fire spread' },
  roads: { activeKey: 'roads', label: 'Roads' },
  min_arrival_time: { activeKey: 'arrival_time', label: 'Arrival time' },
  max_intensity: { activeKey: 'intensity', label: 'Intensity' },
};

const SIM_RESULT_LAYER_PRIORITY = ['isochrones', 'roads', 'min_arrival_time', 'max_intensity'];

function createEmptySimulationLoadState() {
  return {
    primaryLayer: null,
    pendingKeys: [],
    loadedKeys: [],
    failedKeys: [],
    errors: {},
    availableResults: {},
  };
}

function mergeSimulationPayload(previous, incoming) {
  if (!incoming) return previous;
  if (!previous) return incoming;
  return {
    ...previous,
    ...incoming,
    results: {
      ...(previous.results || {}),
      ...(incoming.results || {}),
    },
    available_results: {
      ...(previous.available_results || {}),
      ...(incoming.available_results || {}),
    },
  };
}

function getAvailableSimulationResultKeys(payload) {
  const available = payload?.available_results || {};
  return SIM_RESULT_LAYER_PRIORITY.filter((key) => available[key]);
}

function getSimulationLayerRequestOrder(activeSimLayers, availableResults = null) {
  const primary = resolvePrimarySimulationResultKey(activeSimLayers, availableResults);
  const remaining = SIM_RESULT_LAYER_PRIORITY.filter((key) => key !== primary);
  return primary ? [primary, ...remaining] : [...SIM_RESULT_LAYER_PRIORITY];
}

function resolvePrimarySimulationResultKey(activeSimLayers, availableResults = null) {
  const enabledKeys = SIM_RESULT_LAYER_PRIORITY.filter((key) => activeSimLayers?.[SIM_RESULT_LAYER_CONFIG[key].activeKey]);
  const preferredKeys = enabledKeys.length > 0 ? enabledKeys : SIM_RESULT_LAYER_PRIORITY;
  if (availableResults) {
    return preferredKeys.find((key) => availableResults[key])
      || SIM_RESULT_LAYER_PRIORITY.find((key) => availableResults[key])
      || null;
  }
  return preferredKeys[0] || null;
}

function waitForNextPaint() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    window.requestAnimationFrame(() => resolve());
  });
}

export default function App() {
  // ---- Mode: 'realtime' or 'historical' ----
  const [mode, setMode] = useState('realtime');

  // ---- Polling ----
  const refreshKey = usePolling(30000);

  // ---- Pipeline status ----
  const { status } = useStatus(30000);

  // ---- Real-time state ----
  const rtStatus = useRealtimeStatus(10000);
  const allProducts = useRealtimeProducts();
  const [activeProducts, setActiveProducts] = useState(['bright_ahi', 'bright_s3']);
  const [simulationProductId, setSimulationProductId] = useState('bright_s3');
  const [showAsPolygons, setShowAsPolygons] = useState(false);
  const [hotspotMonitoringHours, setHotspotMonitoringHours] = useState(getInitialMonitoringWindowHours);
  const realtimeWindow = useMemo(
    () => buildRealtimeWindow(hotspotMonitoringHours),
    [hotspotMonitoringHours, refreshKey]
  );
  const { events: rawRtEvents, metadata: rtEventMetadata, loading: rtEventsLoading } = useRealtimeEvents(
    refreshKey,
    realtimeWindow.startUtc,
    realtimeWindow.endUtc
  );
  const { ignitions: rawRtIgnitions, loading: rtIgnitionsLoading } = useRealtimeIgnitions(
    refreshKey,
    realtimeWindow.startUtc,
    realtimeWindow.endUtc
  );

  // Stable product list for hook
  const activeProductsSorted = useMemo(
    () => [...activeProducts].sort(),
    [activeProducts.join(',')]
  );
  const effectiveRealtimeProducts = useMemo(
    () => (mode === 'simulation' ? [simulationProductId] : activeProductsSorted),
    [mode, activeProductsSorted, simulationProductId]
  );
  const displayedActiveProducts = useMemo(
    () => (mode === 'simulation' ? [simulationProductId] : activeProducts),
    [mode, activeProducts, simulationProductId]
  );
  const { hotspots: rtHotspots, metadata: rtMetadata, loading: rtLoading } = useRealtimeHotspots(
    refreshKey, effectiveRealtimeProducts, showAsPolygons, hotspotMonitoringHours
  );

  // ---- Historical state ----
  const historicalMode = mode === 'historical';
  const {
    dates: historicalDates,
    loading: historicalDatesLoading,
    error: historicalDatesError,
  } = useHistoricalDates(refreshKey, historicalMode);
  const [selectedHistoricalDate, setSelectedHistoricalDate] = useState(null);
  const activeHistoricalDate = selectedHistoricalDate || historicalDates[0]?.report_date || null;
  const {
    day: historicalDay,
    loading: historicalDayLoading,
    error: historicalDayError,
  } = useHistoricalDay(refreshKey, activeHistoricalDate, historicalMode);
  const { events: histEvents, loading: histEventsLoading, error: histEventsError } = useFireEvents(refreshKey, {
    reportDate: activeHistoricalDate,
    enabled: historicalMode,
  });
  const histTimeRange = useTimeRange(refreshKey, {
    reportDate: activeHistoricalDate,
    enabled: historicalMode,
  });

  const [timeFilter, setTimeFilter] = useState({ min: null, max: null });
  const histFilters = useMemo(() => ({
    timeMin: timeFilter.min,
    timeMax: timeFilter.max,
    reportDate: activeHistoricalDate,
    enabled: historicalMode,
  }), [timeFilter.min, timeFilter.max, activeHistoricalDate, historicalMode]);
  const { hotspots: histHotspots, loading: histHotspotsLoading, error: histHotspotsError } = useHotspots(refreshKey, histFilters);
  const historicalMetadata = historicalDay?.metadata || null;
  const historicalSimulations = historicalDay?.simulations?.bundled || [];
  const historicalDataError = historicalDatesError || historicalDayError || histEventsError || histHotspotsError || histTimeRange.error;

  // ---- UI state ----
  const [selectedEventId, setSelectedEventId] = useState(null);
  const isMobileInit = typeof window !== 'undefined' && window.innerWidth < 768;
  const [sidebarOpen, setSidebarOpen] = useState(!isMobileInit);
  const [layerPanelOpen, setLayerPanelOpen] = useState(!isMobileInit);
  const [flyTo, setFlyTo] = useState(null);
  const [selectedRealtimeClusterId, setSelectedRealtimeClusterId] = useState(null);

  // ---- Tools menu + panels state ----
  const [toolsMenuOpen, setToolsMenuOpen] = useState(false);
  const [searchToolOpen, setSearchToolOpen] = useState(false);
  const [frpPlotOpen, setFrpPlotOpen] = useState(false);
  const [frpSelectionMode, setFrpSelectionMode] = useState(false);
  const [frpSelectedSummaries, setFrpSelectedSummaries] = useState([]);
  const [bboxDrawMode, setBboxDrawMode] = useState(false);
  const [drawnBbox, setDrawnBbox] = useState(null); // [west, south, east, north]
  const [highlightedLga, setHighlightedLga] = useState(null);

  // ---- Target LGA areas (XPRIZE ArcGIS) ----
  const [targetAreas, setTargetAreas] = useState(null);
  const [selectedTargetLga, setSelectedTargetLga] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getLgaTargetAreas()
      .then(data => { if (!cancelled) setTargetAreas(data); })
      .catch(() => {});
    // Refresh every 2 minutes to match backend cache TTL
    const interval = startPoll(() => {
      getLgaTargetAreas()
        .then(data => { if (!cancelled) setTargetAreas(data); })
        .catch(() => {});
    }, 120000);
    return () => { cancelled = true; stopPoll(interval); };
  }, []);

  // ---- Highlighted LGAs for historical days (from BRIGHT poller history) ----
  // The live ArcGIS endpoint only reflects the current state, so for historical
  // days we call /api/lga/highlighted which reconstructs the end-of-day set
  // from the synced lga_poller log (add/remove/snapshot events).
  const [historicalHighlightedLgas, setHistoricalHighlightedLgas] = useState([]);
  const [historicalHighlightedLgaStatus, setHistoricalHighlightedLgaStatus] = useState(null);
  useEffect(() => {
    if (!historicalMode || !activeHistoricalDate) {
      setHistoricalHighlightedLgas([]);
      setHistoricalHighlightedLgaStatus(null);
      return undefined;
    }
    let cancelled = false;
    getHighlightedLgas(activeHistoricalDate)
      .then((data) => {
        if (cancelled) return;
        setHistoricalHighlightedLgas(Array.isArray(data?.highlighted) ? data.highlighted : []);
        setHistoricalHighlightedLgaStatus({
          status: data?.status || null,
          note: data?.note || null,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setHistoricalHighlightedLgas([]);
        setHistoricalHighlightedLgaStatus({ status: 'error', note: 'Failed to load highlighted LGA history.' });
      });
    return () => { cancelled = true; };
  }, [historicalMode, activeHistoricalDate]);

  const handleSearchToolToggle = useCallback(() => {
    setSearchToolOpen(v => !v);
  }, []);

  const handleToolsMenuToggle = useCallback(() => {
    setToolsMenuOpen(v => !v);
  }, []);

  const handleOpenSearchTool = useCallback(() => {
    setSearchToolOpen(true);
    setFrpPlotOpen(false);
  }, []);

  const handleOpenFrpPlot = useCallback(() => {
    setFrpPlotOpen(true);
    setSearchToolOpen(false);
    setFrpSelectionMode(true);
  }, []);

  const handleFrpHotspotPick = useCallback((summary) => {
    if (!summary) return;
    const key = getSelectionKey(summary);
    if (!key) return;
    setFrpSelectedSummaries((prev) => {
      const existing = prev.findIndex((s) => getSelectionKey(s) === key);
      if (existing >= 0) {
        const next = prev.slice();
        next.splice(existing, 1);
        return next;
      }
      return [...prev, summary];
    });
  }, []);

  const handleFrpAreaSelect = useCallback((summaries) => {
    if (!Array.isArray(summaries) || summaries.length === 0) return;
    setFrpSelectedSummaries((prev) => {
      const seen = new Set(prev.map((s) => getSelectionKey(s)).filter(Boolean));
      const next = prev.slice();
      for (const s of summaries) {
        const key = getSelectionKey(s);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        next.push(s);
      }
      return next;
    });
  }, []);

  const handleFrpRemoveOne = useCallback((key) => {
    setFrpSelectedSummaries((prev) => prev.filter((s) => getSelectionKey(s) !== key));
  }, []);

  const handleFrpClearSelection = useCallback(() => {
    setFrpSelectedSummaries([]);
  }, []);

  const handleFrpToggleSelectionMode = useCallback(() => {
    setFrpSelectionMode((v) => !v);
  }, []);

  const handleFrpExitSelectionMode = useCallback(() => {
    setFrpSelectionMode(false);
  }, []);

  const handleCloseFrpPanel = useCallback(() => {
    setFrpPlotOpen(false);
    setFrpSelectionMode(false);
    setFrpSelectedSummaries([]);
  }, []);

  const frpSelectedPoints = useMemo(
    () => frpSelectedSummaries
      .map((s) => {
        const key = getSelectionKey(s);
        if (!key || !Number.isFinite(s?.lat) || !Number.isFinite(s?.lng)) return null;
        return { key, lat: s.lat, lng: s.lng };
      })
      .filter(Boolean),
    [frpSelectedSummaries]
  );

  useEffect(() => {
    if (mode !== 'realtime') {
      setFrpPlotOpen(false);
      setFrpSelectionMode(false);
      setFrpSelectedSummaries([]);
      setToolsMenuOpen(false);
    }
  }, [mode]);

  const handleDrawBbox = useCallback(() => {
    setBboxDrawMode(true);
  }, []);

  const handleBboxDrawn = useCallback((bbox) => {
    setDrawnBbox(bbox);
    setBboxDrawMode(false);
  }, []);

  const handleClearBbox = useCallback(() => {
    setDrawnBbox(null);
  }, []);

  // ---- Data freshness tracking ----
  const [lastFetchTime, setLastFetchTime] = useState(null);
  useEffect(() => {
    if (rtMetadata) setLastFetchTime(new Date());
  }, [rtMetadata]);

  // ---- Layer visibility ----
  const [layers, setLayers] = useState(getInitialLayers);

  // ---- DEA WMS overlay layers ----
  const deaLayerConfig = useDeaLayers();
  const deaCacheStats = useDeaCacheStats();
  const [activeOverlays, setActiveOverlays] = useState([]);
  const [overlayLoadingState, setOverlayLoadingState] = useState({});
  const [overlayErrorState, setOverlayErrorState] = useState({});
  const npwsFireHistoryEnabled = activeOverlays.includes('npws_fire_history');
  const {
    data: npwsFireHistoryData,
    loading: npwsFireHistoryLoading,
    error: npwsFireHistoryError,
  } = useNpwsFireHistory(npwsFireHistoryEnabled, 202526);

  // ---- NSW LGA boundaries ----
  const lgaData = useLgaBoundaries();
  const [showLga, setShowLga] = useState(false);

  // ---- External vector layers ----
  const [showBushfireExtents, setShowBushfireExtents] = useState(false);
  const [showRfsFacilities, setShowRfsFacilities] = useState(false);
  const { data: bushfireExtentsData, loading: bushfireExtentsLoading } = useBushfireExtents(showBushfireExtents);
  const { data: rfsFacilitiesData, loading: rfsFacilitiesLoading } = useRfsFacilities(showRfsFacilities);

  useEffect(() => {
    if (!npwsFireHistoryEnabled) {
      setOverlayLoadingState(prev => ({ ...prev, npws_fire_history: false }));
      setOverlayErrorState(prev => ({ ...prev, npws_fire_history: null }));
      return;
    }
    setOverlayLoadingState(prev => ({ ...prev, npws_fire_history: npwsFireHistoryLoading }));
    setOverlayErrorState(prev => ({
      ...prev,
      npws_fire_history: npwsFireHistoryError ? npwsFireHistoryError.message : null,
    }));
  }, [npwsFireHistoryEnabled, npwsFireHistoryLoading, npwsFireHistoryError]);

  // ---- Simulation state ----
  const [simulationResult, setSimulationResult] = useState(null);
  const [simulationStatus, setSimulationStatus] = useState('idle'); // idle | running | done | error
  const [simulationError, setSimulationError] = useState(null);
  const [selectedSimHotspot, setSelectedSimHotspot] = useState(null);
  const [simulationProgress, setSimulationProgress] = useState(null);
  const [activeSimLayers, setActiveSimLayers] = useState({ isochrones: true, arrival_time: false, intensity: false, roads: true, ignition: true });
  const [simGroupFeatures, setSimGroupFeatures] = useState(null);
  const [customSimPoint, setCustomSimPoint] = useState(null);
  const [customPointMode, setCustomPointMode] = useState(false);
  const [selectedRealtimeHotspots, setSelectedRealtimeHotspots] = useState([]);
  const [checkedSimHotspots, setCheckedSimHotspots] = useState([]);
  const [simSelectionClearVersion, setSimSelectionClearVersion] = useState(0);
  const [savedSimulationRefreshVersion, setSavedSimulationRefreshVersion] = useState(0);
  const [selectedSavedSimulationId, setSelectedSavedSimulationId] = useState(null);
  const [selectedSavedSimulation, setSelectedSavedSimulation] = useState(null);
  const [selectedSavedSimulationError, setSelectedSavedSimulationError] = useState(null);
  const [selectedHistoricalSimulationId, setSelectedHistoricalSimulationId] = useState(null);
  const [selectedHistoricalSimulation, setSelectedHistoricalSimulation] = useState(null);
  const [selectedHistoricalSimulationError, setSelectedHistoricalSimulationError] = useState(null);
  const [mapSimulationLoadState, setMapSimulationLoadState] = useState(createEmptySimulationLoadState);
  const [savedSimulationRequestLimit, setSavedSimulationRequestLimit] = useState(100);
  const simulationLoadRequestRef = useRef(0);
  const mapSimulationLoadStateRef = useRef(createEmptySimulationLoadState());
  const simulationResultRef = useRef(null);
  const {
    runs: savedSimulationRuns,
    diagnostics: savedSimulationDiagnostics,
    loading: savedSimulationLoading,
    refreshing: savedSimulationRefreshing,
  } = useSavedSimulationRuns(`${refreshKey}:${savedSimulationRefreshVersion}`, {
    start_after: realtimeWindow.startUtc,
    start_before: realtimeWindow.endUtc,
    limit: savedSimulationRequestLimit,
  });

  const requestMoreSavedSimulations = useCallback(() => {
    setSavedSimulationRequestLimit((current) => Math.min(current + 50, 500));
  }, []);

  const clearSimulationSelections = useCallback(() => {
    setSelectedSimHotspot(null);
    setSimGroupFeatures(null);
    setCustomSimPoint(null);
    setCustomPointMode(false);
    setCheckedSimHotspots([]);
    setSimSelectionClearVersion(v => v + 1);
  }, []);

  const clearRealtimeSelections = useCallback(() => {
    setSelectedRealtimeHotspots([]);
    setSelectedRealtimeClusterId(null);
  }, []);

  const clearSelectedSavedSimulation = useCallback(() => {
    setSelectedSavedSimulationId(null);
    setSelectedSavedSimulation(null);
    setSelectedSavedSimulationError(null);
    setMapSimulationLoadState(createEmptySimulationLoadState());
    simulationLoadRequestRef.current += 1;
  }, []);

  const clearSelectedHistoricalSimulation = useCallback(() => {
    setSelectedHistoricalSimulationId(null);
    setSelectedHistoricalSimulation(null);
    setSelectedHistoricalSimulationError(null);
    setMapSimulationLoadState(createEmptySimulationLoadState());
    simulationLoadRequestRef.current += 1;
  }, []);

  useEffect(() => {
    mapSimulationLoadStateRef.current = mapSimulationLoadState;
  }, [mapSimulationLoadState]);

  useEffect(() => {
    simulationResultRef.current = simulationResult;
  }, [simulationResult]);

  const applySimulationPartialResult = useCallback((partialResult, loadedKey = null) => {
    if (!partialResult) return;

    const hadExistingResult = Boolean(simulationResultRef.current);
    if (!hadExistingResult && partialResult.lng != null && partialResult.lat != null) {
      setFlyTo({ center: [partialResult.lng, partialResult.lat], zoom: 12 });
    }

    setSimulationResult((previous) => mergeSimulationPayload(previous, partialResult));
    setMapSimulationLoadState((previous) => {
      const availableResults = {
        ...previous.availableResults,
        ...(partialResult?.available_results || {}),
      };
      const primaryLayer = previous.primaryLayer || resolvePrimarySimulationResultKey(activeSimLayers, availableResults);
      const loadedKeys = loadedKey && !previous.loadedKeys.includes(loadedKey)
        ? [...previous.loadedKeys, loadedKey]
        : previous.loadedKeys;
      return {
        ...previous,
        primaryLayer,
        loadedKeys,
        pendingKeys: getSimulationLayerRequestOrder(activeSimLayers, availableResults)
          .filter((key) => !loadedKeys.includes(key)),
        availableResults,
      };
    });
  }, [activeSimLayers]);

  const progressivelyLoadSimulationPayload = useCallback(async ({
    fetchResult,
    setTargetResult,
    primaryLoadingMessage = null,
    backgroundLoadingMessage = null,
    onInitialResult,
    onBaseLoaded,
  }) => {
    const requestId = simulationLoadRequestRef.current + 1;
    simulationLoadRequestRef.current = requestId;

    const optimisticPrimary = resolvePrimarySimulationResultKey(activeSimLayers);
    setMapSimulationLoadState({
      ...createEmptySimulationLoadState(),
      primaryLayer: optimisticPrimary,
      pendingKeys: optimisticPrimary ? [optimisticPrimary] : [],
    });
    if (primaryLoadingMessage) {
      setSimulationProgress(primaryLoadingMessage);
    }

    const initialInclude = ['variables'];
    if (optimisticPrimary) {
      initialInclude.push(optimisticPrimary);
    }
    const baseResult = await fetchResult({ include: Array.from(new Set(initialInclude)) });
    if (simulationLoadRequestRef.current !== requestId) {
      return null;
    }

    const availableResults = baseResult?.available_results || {};
    const resolvedPrimary = resolvePrimarySimulationResultKey(activeSimLayers, availableResults);
    const availableKeys = getAvailableSimulationResultKeys(baseResult);
    const loadedKeys = resolvedPrimary && baseResult?.results?.[resolvedPrimary] ? [resolvedPrimary] : [];
    const pendingKeys = availableKeys.filter((key) => key !== resolvedPrimary);

    setTargetResult(baseResult);
    setMapSimulationLoadState({
      primaryLayer: resolvedPrimary,
      pendingKeys,
      loadedKeys,
      failedKeys: [],
      errors: {},
      availableResults,
    });

    if (typeof onInitialResult === 'function') {
      onInitialResult(baseResult);
    }
    if (typeof onBaseLoaded === 'function') {
      onBaseLoaded(baseResult);
    }

    if (pendingKeys.length === 0) {
      if (primaryLoadingMessage || backgroundLoadingMessage) {
        setSimulationProgress(null);
      }
      return baseResult;
    }

    await waitForNextPaint();
    if (simulationLoadRequestRef.current !== requestId) {
      return null;
    }

    if (backgroundLoadingMessage) {
      setSimulationProgress(backgroundLoadingMessage);
    }

    for (const key of pendingKeys) {
      try {
        const partialResult = await fetchResult({ include: [key] });
        if (simulationLoadRequestRef.current !== requestId) {
          return null;
        }
        setTargetResult((previous) => mergeSimulationPayload(previous, partialResult));
        setMapSimulationLoadState((previous) => ({
          ...previous,
          pendingKeys: previous.pendingKeys.filter((item) => item !== key),
          loadedKeys: previous.loadedKeys.includes(key) ? previous.loadedKeys : [...previous.loadedKeys, key],
          availableResults: {
            ...previous.availableResults,
            ...(partialResult?.available_results || {}),
          },
        }));
        await waitForNextPaint();
      } catch (error) {
        if (simulationLoadRequestRef.current !== requestId) {
          return null;
        }
        console.error(`Simulation layer fetch failed for ${key}:`, error);
        setMapSimulationLoadState((previous) => ({
          ...previous,
          pendingKeys: previous.pendingKeys.filter((item) => item !== key),
          failedKeys: previous.failedKeys.includes(key) ? previous.failedKeys : [...previous.failedKeys, key],
          errors: {
            ...previous.errors,
            [key]: error.message || 'Layer unavailable',
          },
        }));
      }
    }

    if (simulationLoadRequestRef.current === requestId && (primaryLoadingMessage || backgroundLoadingMessage)) {
      setSimulationProgress(null);
    }

    return baseResult;
  }, [activeSimLayers]);

  const tryLoadNextSimulationLayer = useCallback(async (runId, requestId) => {
    const loadState = mapSimulationLoadStateRef.current || createEmptySimulationLoadState();
    const requestOrder = getSimulationLayerRequestOrder(activeSimLayers, loadState.availableResults);
    const nextKey = requestOrder.find((key) => !loadState.loadedKeys.includes(key));
    if (!nextKey) {
      return false;
    }

    const partialResult = await getSimulationResults(runId, {
      include: [nextKey],
      allowIncomplete: true,
    });

    if (simulationLoadRequestRef.current !== requestId) {
      return false;
    }

    if (!partialResult?.results?.[nextKey]) {
      return false;
    }

    applySimulationPartialResult(partialResult, nextKey);
    await waitForNextPaint();
    return true;
  }, [activeSimLayers, applySimulationPartialResult]);

  const handleToggleOverlay = useCallback((overlayId) => {
    setActiveOverlays(prev => {
      if (prev.includes(overlayId)) {
        setOverlayLoadingState(current => ({ ...current, [overlayId]: false }));
        setOverlayErrorState(current => ({ ...current, [overlayId]: null }));
        return prev.filter(id => id !== overlayId);
      }
      // When enabling an overlay, if it's 'land_cover', also sync legacy state
      setOverlayLoadingState(current => ({ ...current, [overlayId]: true }));
      setOverlayErrorState(current => ({ ...current, [overlayId]: null }));
      return [...prev, overlayId];
    });
    // Keep legacy landCover state in sync
    if (overlayId === 'land_cover') {
      setLayers(prev => ({ ...prev, landCover: !prev.landCover }));
    }
  }, []);

  const toggleSimLayer = useCallback((layerKey, nextValue = null) => {
    setActiveSimLayers(prev => ({
      ...prev,
      [layerKey]: nextValue == null ? !prev[layerKey] : nextValue,
    }));
  }, []);

  // Historical bundles never ship arrival_time or intensity rasters. If a user
  // left those toggles ON in real-time mode and then switched to historical,
  // force them off so the legend doesn't advertise layers that can't render.
  useEffect(() => {
    if (mode !== 'historical') return;
    setActiveSimLayers(prev => {
      if (!prev.arrival_time && !prev.intensity) return prev;
      return { ...prev, arrival_time: false, intensity: false };
    });
  }, [mode]);

  const handleToggleLayer = useCallback((key, value) => {
    setLayers(prev => ({ ...prev, [key]: value }));
    if (key === 'savedSimulations' && value) {
      setActiveSimLayers(prev => {
        if (Object.values(prev).some(Boolean)) return prev;
        return { ...prev, isochrones: true };
      });
    }
  }, []);

  const handleOverlayLoadingChange = useCallback((layerId, isLoading, errorMessage = null) => {
    setOverlayLoadingState(prev => ({ ...prev, [layerId]: isLoading }));
    setOverlayErrorState(prev => ({ ...prev, [layerId]: errorMessage }));
  }, []);

  const handleFlyToLga = useCallback((feature) => {
    const geometry = feature?.geometry;
    if (!geometry) return;
    const coordinates = geometry.type === 'Polygon'
      ? geometry.coordinates?.[0]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates?.[0]?.[0]
        : null;
    if (!coordinates?.length) return;
    const lng = coordinates.reduce((sum, coord) => sum + coord[0], 0) / coordinates.length;
    const lat = coordinates.reduce((sum, coord) => sum + coord[1], 0) / coordinates.length;
    setShowLga(true);
    setFlyTo({ center: [lng, lat], zoom: 8 });
  }, []);

  const handleSelectSavedSimulation = useCallback(async (runId) => {
    if (!runId) {
      clearSelectedSavedSimulation();
      return;
    }
    setSelectedSavedSimulationId(runId);
    setSelectedSavedSimulation(null);
    setSelectedSavedSimulationError(null);
    setLayers(prev => ({ ...prev, savedSimulations: true }));
    try {
      const result = await progressivelyLoadSimulationPayload({
        fetchResult: (options = {}) => getSavedSimulationRun(runId, options),
        setTargetResult: setSelectedSavedSimulation,
        onInitialResult: (initialResult) => {
          if (initialResult.lng != null && initialResult.lat != null) {
            setFlyTo({ center: [initialResult.lng, initialResult.lat], zoom: 10 });
          }
        },
      });
      if (!result) return;
      setSidebarOpen(true);
    } catch (error) {
      setSelectedSavedSimulation(null);
      setMapSimulationLoadState(createEmptySimulationLoadState());
      setSelectedSavedSimulationError(error.message || 'Failed to load saved simulation');
    }
  }, [clearSelectedSavedSimulation, progressivelyLoadSimulationPayload]);

  const handleSelectHistoricalSimulation = useCallback(async (simulationId) => {
    if (!simulationId || !activeHistoricalDate) {
      clearSelectedHistoricalSimulation();
      return;
    }
    // Full clear of previous simulation state before loading new one
    clearSelectedHistoricalSimulation();
    setSelectedHistoricalSimulationId(simulationId);
    setLayers(prev => ({ ...prev, savedSimulations: true }));
    try {
      const result = await progressivelyLoadSimulationPayload({
        fetchResult: (options = {}) => getHistoricalSimulationRun(activeHistoricalDate, simulationId, options),
        setTargetResult: setSelectedHistoricalSimulation,
        onInitialResult: (initialResult) => {
          if (initialResult.lng != null && initialResult.lat != null) {
            setFlyTo({ center: [initialResult.lng, initialResult.lat], zoom: 10 });
          }
        },
      });
      if (!result) return;
      setSidebarOpen(true);
    } catch (error) {
      setSelectedHistoricalSimulation(null);
      setMapSimulationLoadState(createEmptySimulationLoadState());
      setSelectedHistoricalSimulationError(error.message || 'Failed to load historical simulation');
    }
  }, [activeHistoricalDate, clearSelectedHistoricalSimulation, progressivelyLoadSimulationPayload]);

  const handleToggleProduct = useCallback((productId) => {
    if (mode === 'simulation') {
      setSimulationProductId(productId);
      return;
    }
    setActiveProducts(prev =>
      prev.includes(productId)
        ? prev.filter(p => p !== productId)
        : [...prev, productId]
    );
  }, [mode]);

  const handleToggleProductGroup = useCallback((sensorName) => {
    if (mode === 'simulation' || !allProducts) return;
    if (!allProducts) return;
    const groupIds = allProducts.filter(p => (p.group || p.sensor) === sensorName).map(p => p.id);
    setActiveProducts(prev => {
      const allActive = groupIds.every(id => prev.includes(id));
      if (allActive) {
        // Turn all off
        return prev.filter(id => !groupIds.includes(id));
      } else {
        // Turn all on
        return [...new Set([...prev, ...groupIds])];
      }
    });
  }, [allProducts, mode]);

  const rtEvents = useMemo(
    () => filterFeatureCollectionByWindow(
      rawRtEvents,
      realtimeWindow.start,
      realtimeWindow.end,
      ['last_hotspot_time', 'end_dt', 'first_hotspot_time', 'ignition_datetime', 'start_dt', 'datetime']
    ),
    [rawRtEvents, realtimeWindow]
  );

  const rtIgnitions = useMemo(
    () => filterFeatureCollectionByWindow(
      rawRtIgnitions,
      realtimeWindow.start,
      realtimeWindow.end,
      ['datetime', 'ignition_datetime', 'first_hotspot_time']
    ),
    [rawRtIgnitions, realtimeWindow]
  );

  useEffect(() => {
    if (selectedRealtimeClusterId == null || !rtEvents?.features) return;
    const stillVisible = rtEvents.features.some((feature) => {
      const props = feature.properties || {};
      return (props.stable_id ?? props.cluster_id ?? props.event_id ?? props.fire_id) == selectedRealtimeClusterId;
    });
    if (!stillVisible) {
      setSelectedRealtimeClusterId(null);
    }
  }, [rtEvents, selectedRealtimeClusterId]);

  useEffect(() => {
    if (!selectedSavedSimulationId) return;
    const stillVisible = (savedSimulationRuns || []).some((run) => run?.run_id === selectedSavedSimulationId);
    if (!stillVisible) {
      clearSelectedSavedSimulation();
    }
  }, [savedSimulationRuns, selectedSavedSimulationId, clearSelectedSavedSimulation]);

  useEffect(() => {
    if (!selectedSavedSimulation?.startDateTime) return;
    if (!isTimestampWithinWindow(selectedSavedSimulation.startDateTime, realtimeWindow.start, realtimeWindow.end)) {
      clearSelectedSavedSimulation();
    }
  }, [selectedSavedSimulation, realtimeWindow, clearSelectedSavedSimulation]);

  useEffect(() => {
    if (!selectedHistoricalSimulationId) return;
    const stillVisible = (historicalSimulations || []).some((run) => run?.simulation_id === selectedHistoricalSimulationId);
    if (!stillVisible) {
      clearSelectedHistoricalSimulation();
    }
  }, [historicalSimulations, selectedHistoricalSimulationId, clearSelectedHistoricalSimulation]);

  useEffect(() => {
    clearSimulationSelections();
  }, [simulationProductId, hotspotMonitoringHours, clearSimulationSelections]);

  useEffect(() => {
    setSelectedEventId(null);
    setTimeFilter({ min: null, max: null });
    clearSelectedHistoricalSimulation();
  }, [activeHistoricalDate, clearSelectedHistoricalSimulation]);

  // ---- Derive what data to show based on mode ----
  const currentEvents = mode === 'historical' ? histEvents : mode === 'realtime' ? rtEvents : null;
  const currentHotspots = mode === 'historical' ? histHotspots : rtHotspots;
  // Only show loading spinner on first load (not subsequent polls)
  const isFirstLoad = mode === 'historical'
    ? (histEvents === null && (historicalDayLoading || histEventsLoading))
    : (rtHotspots === null && rtLoading);

  const handleSelectEvent = useCallback((id) => {
    setSelectedEventId(id);
    setSidebarOpen(true);

    // Fly to event centroid (historical mode only — events come from pipeline)
    const events = currentEvents;
    if (events && events.features) {
      const feat = events.features.find(f => {
        const props = f.properties;
        return (props.stable_id ?? props.cluster_id ?? props.event_id ?? props.fire_id) == id;
      });
      if (feat && feat.geometry) {
        const coords = feat.geometry.coordinates;
        let center;
        if (feat.geometry.type === 'Point') {
          center = coords;
        } else if (feat.geometry.type === 'Polygon') {
          const ring = coords[0];
          const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
          const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
          center = [lng, lat];
        } else if (feat.geometry.type === 'MultiPolygon') {
          const ring = coords[0][0];
          const lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
          const lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
          center = [lng, lat];
        }
        if (center) {
          setFlyTo({ center, zoom: 10 });
        }
      }
    }
  }, [currentEvents]);

  const handleSelectRealtimeCluster = useCallback((id) => {
    setSelectedRealtimeClusterId(id);
    setSelectedRealtimeHotspots([]);
    setSidebarOpen(true);
    if (!rtEvents?.features) return;
    const feature = rtEvents.features.find((item) => {
      const props = item.properties || {};
      return (props.stable_id ?? props.cluster_id ?? props.event_id ?? props.fire_id) == id;
    });
    if (!feature?.geometry) return;
    const coords = feature.geometry.type === 'Polygon'
      ? feature.geometry.coordinates?.[0]
      : feature.geometry.type === 'MultiPolygon'
        ? feature.geometry.coordinates?.[0]?.[0]
        : null;
    if (!coords?.length) return;
    const lng = coords.reduce((sum, coord) => sum + coord[0], 0) / coords.length;
    const lat = coords.reduce((sum, coord) => sum + coord[1], 0) / coords.length;
    setFlyTo({ center: [lng, lat], zoom: 9 });
  }, [rtEvents]);

  const handleSelectRealtimeIgnition = useCallback((ignition) => {
    if (!ignition) return;
    setSidebarOpen(true);
    setSelectedRealtimeHotspots([]);
    if (ignition.stableId != null) {
      setSelectedRealtimeClusterId(ignition.stableId);
    }
    if (Number.isFinite(ignition.lng) && Number.isFinite(ignition.lat)) {
      setFlyTo({ center: [ignition.lng, ignition.lat], zoom: 11 });
    }
  }, []);

  const handleRunSimulation = useCallback(async (params) => {
    const requestId = simulationLoadRequestRef.current + 1;
    simulationLoadRequestRef.current = requestId;
    const primaryLayer = resolvePrimarySimulationResultKey(activeSimLayers);
    setSimulationStatus('running');
    setSimulationResult(null);
    setSimulationError(null);
    setSimulationProgress('Starting...');
    setMapSimulationLoadState({
      ...createEmptySimulationLoadState(),
      primaryLayer,
      pendingKeys: getSimulationLayerRequestOrder(activeSimLayers),
    });
    try {
      // Build request body
      const body = { startDateTime: params.startDateTime };
      if (params.source) {
        body.source = params.source;
      }
      if (params.points && params.points.length > 0) {
        body.points = params.points;
      } else {
        body.lat = params.lat;
        body.lng = params.lng;
      }

      // Start simulation (async)
      const { run_id } = await startSimulation(body);

      // Poll progress
      let completed = false;
      while (!completed) {
        await new Promise(r => setTimeout(r, 1500));
        if (simulationLoadRequestRef.current !== requestId) return;
        const progress = await getSimulationProgress(run_id);
        setSimulationProgress(progress.progress || 'Running...');

        if (progress.status === 'complete') {
          const completionOrder = ['variables', ...getSimulationLayerRequestOrder(activeSimLayers, mapSimulationLoadStateRef.current?.availableResults)];
          for (const key of completionOrder) {
            if (simulationLoadRequestRef.current !== requestId) return;
            if (key !== 'variables' && mapSimulationLoadStateRef.current?.loadedKeys?.includes(key)) {
              continue;
            }
            if (key === 'variables' && simulationResultRef.current?.results?.variables) {
              continue;
            }
            const partialResult = await getSimulationResults(run_id, { include: [key] });
            if (simulationLoadRequestRef.current !== requestId) return;
            applySimulationPartialResult(partialResult, key === 'variables' ? null : key);
            await waitForNextPaint();
          }
          completed = true;
          setSimulationStatus('done');
          setSavedSimulationRefreshVersion(v => v + 1);
          setSimulationProgress(null);
        } else if (progress.status === 'running') {
          await tryLoadNextSimulationLayer(run_id, requestId);
        } else if (progress.status === 'error') {
          throw new Error(progress.error || 'Simulation failed');
        }
      }
    } catch (err) {
      console.error('Simulation failed:', err);
      setSimulationError(err.message || 'Unknown error');
      setSimulationStatus('error');
      setSimulationProgress(null);
    }
  }, [activeSimLayers, applySimulationPartialResult, tryLoadNextSimulationLayer]);

  const handleClearSimulation = useCallback(() => {
    setSimulationResult(null);
    setSimulationStatus('idle');
    setSimulationError(null);
    setSimulationProgress(null);
    setMapSimulationLoadState(createEmptySimulationLoadState());
    simulationLoadRequestRef.current += 1;
    clearSimulationSelections();
  }, [clearSimulationSelections]);

  const handleMapClickSimPoint = useCallback((coords) => {
    if (!customPointMode) return;
    setCustomSimPoint(coords); // { lat, lng }
  }, [customPointMode]);

  const handleSelectSimHotspot = useCallback((hs, options = {}) => {
    setSelectedSimHotspot(hs);
    if (hs) {
      setSidebarOpen(true);
    }
    if (hs && options.flyTo) {
      setFlyTo({ center: [hs.lng, hs.lat], zoom: 10 });
    }
  }, []);

  const handleClearSimulationHotspotSelection = useCallback((options = {}) => {
    setSelectedSimHotspot(null);
    setCheckedSimHotspots([]);
    setSimGroupFeatures(null);
    if (options.collapseGroup) {
      setSimSelectionClearVersion(v => v + 1);
    }
  }, []);

  const handlePickRealtimeHotspots = useCallback((hotspotSummaries) => {
    const next = (hotspotSummaries || []).filter(Boolean);
    setSelectedRealtimeHotspots(next);
    setSelectedRealtimeClusterId(null);
    if (next.length === 0) {
      return;
    }
    setSidebarOpen(true);
  }, []);

  const handleSelectRealtimeHotspot = useCallback((hotspotSummary, options = {}) => {
    if (!hotspotSummary) {
      setSelectedRealtimeHotspots([]);
      return;
    }
    setSelectedRealtimeHotspots((previous) => {
      const contextHotspots = (options.contextHotspots || []).filter(Boolean);
      if (contextHotspots.length > 0) {
        return contextHotspots;
      }

      const matchingPrevious = (previous || []).filter((item) => item?.idx !== hotspotSummary.idx);
      const hasPreviousContext = matchingPrevious.length > 0 && (previous || []).some((item) => item?.idx === hotspotSummary.idx);
      if (hasPreviousContext) {
        return [hotspotSummary, ...matchingPrevious];
      }

      return [hotspotSummary];
    });
    setSelectedRealtimeClusterId(null);
    setSidebarOpen(true);
    if (options.flyTo) {
      setFlyTo({ center: [hotspotSummary.lng, hotspotSummary.lat], zoom: 10 });
    }
  }, []);

  const handleCloseRealtimeSidebar = useCallback(() => {
    setSidebarOpen(false);
    clearRealtimeSelections();
  }, [clearRealtimeSelections]);

  const handleCloseSimulationSidebar = useCallback(() => {
    setSidebarOpen(false);
    clearSimulationSelections();
  }, [clearSimulationSelections]);

  const handleModeChange = useCallback((newMode) => {
    setMode(newMode);
    setSelectedEventId(null);
    clearRealtimeSelections();
    clearSimulationSelections();
    if (newMode !== 'historical') {
      clearSelectedHistoricalSimulation();
    }
  }, [clearRealtimeSelections, clearSimulationSelections, clearSelectedHistoricalSimulation]);

  const handleMonitoringWindowChange = useCallback((nextValue) => {
    const hours = Number(nextValue);
    if (!HOTSPOT_MONITORING_WINDOW_OPTIONS.includes(hours)) return;
    setHotspotMonitoringHours(hours);
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    params.set('hotspot_hours', String(hours));
    const nextUrl = `${window.location.pathname}?${params.toString()}${window.location.hash}`;
    window.history.replaceState({}, '', nextUrl);
  }, []);

  const selectedMapEventId = mode === 'realtime' ? selectedRealtimeClusterId : selectedEventId;
  const mapSimulationResult = mode === 'realtime'
    ? (layers.savedSimulations ? selectedSavedSimulation : null)
    : mode === 'historical'
      ? (layers.savedSimulations ? selectedHistoricalSimulation : null)
      : simulationResult;
  const mapSimulationLegendTitle = mode === 'realtime'
    ? 'Saved Simulation'
    : mode === 'historical'
      ? 'Historical Simulation'
      : 'Fire Simulation';

  const STATIC_MODE = import.meta.env.VITE_STATIC_MODE === 'true';

  return (
    <div className="app-layout">
      {STATIC_MODE && <StaticArchiveBanner />}
      <Header
        status={status}
        rtStatus={rtStatus}
        mode={mode}
        onModeChange={handleModeChange}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => {
          setSidebarOpen(v => {
            const next = !v;
            if (next && window.innerWidth < 768) setLayerPanelOpen(false);
            return next;
          });
        }}
        layerPanelOpen={layerPanelOpen}
        onToggleLayers={() => {
          setLayerPanelOpen(v => {
            const next = !v;
            if (next && window.innerWidth < 768) setSidebarOpen(false);
            return next;
          });
        }}
        rtMetadata={rtMetadata}
        rtMonitoringHours={hotspotMonitoringHours}
        lastFetchTime={lastFetchTime}
      />

      <main className="app-body">
        {mode === 'simulation' ? (
          <aside className={`sidebar-left ${sidebarOpen ? '' : 'collapsed'}`}>
            <div style={{ display: 'flex', alignItems: 'center', padding: '4px 8px 0', justifyContent: 'flex-end' }}>
              <button className="sidebar-close-btn" onClick={handleCloseSimulationSidebar}>×</button>
            </div>
            <div className="sidebar-body">
              <SimulationPanel
                hotspots={rtHotspots}
                onSelectHotspot={handleSelectSimHotspot}
                selectedHotspot={selectedSimHotspot}
                simulationResult={simulationResult}
                simulationStatus={simulationStatus}
                simulationError={simulationError}
                simulationProgress={simulationProgress}
                onRunSimulation={handleRunSimulation}
                onClearSimulation={handleClearSimulation}
                activeSimLayers={activeSimLayers}
                onToggleSimLayer={toggleSimLayer}
                onSetSimGroupFeatures={setSimGroupFeatures}
                customSimPoint={customSimPoint}
                customPointMode={customPointMode}
                onSetCustomPointMode={setCustomPointMode}
                onSetCustomSimPoint={setCustomSimPoint}
                onFlyTo={setFlyTo}
                onCheckedHotspotsChange={setCheckedSimHotspots}
                selectionClearVersion={simSelectionClearVersion}
                monitoringWindowHours={hotspotMonitoringHours}
              />
            </div>
          </aside>
        ) : (
          <Sidebar
            open={sidebarOpen}
            onClose={handleCloseRealtimeSidebar}
            mode={mode}
            layers={layers}
            events={currentEvents}
            hotspots={currentHotspots}
            selectedEventId={selectedMapEventId}
            onSelectEvent={mode === 'realtime' ? handleSelectRealtimeCluster : handleSelectEvent}
            eventColors={EVENT_COLORS}
            rtMetadata={rtMetadata}
            rtEventMetadata={rtEventMetadata}
            rtStatus={rtStatus}
            allProducts={allProducts}
            activeProducts={displayedActiveProducts}
            selectedRealtimeHotspots={selectedRealtimeHotspots}
            selectedRealtimeClusterId={selectedRealtimeClusterId}
            rtMonitoringHours={hotspotMonitoringHours}
            rtWindowStart={realtimeWindow.start}
            rtWindowEnd={realtimeWindow.end}
            rtIgnitions={rtIgnitions}
            onSelectRealtimeHotspot={handleSelectRealtimeHotspot}
            onSelectRealtimeCluster={handleSelectRealtimeCluster}
            onSelectRealtimeIgnition={handleSelectRealtimeIgnition}
            savedSimulationRuns={savedSimulationRuns}
            savedSimulationDiagnostics={savedSimulationDiagnostics}
            savedSimulationLoading={savedSimulationLoading}
            savedSimulationRefreshing={savedSimulationRefreshing}
            savedSimulationRequestLimit={savedSimulationRequestLimit}
            onRequestMoreSavedSimulations={requestMoreSavedSimulations}
            selectedSavedSimulationId={selectedSavedSimulationId}
            selectedSavedSimulation={selectedSavedSimulation}
            selectedSavedSimulationError={selectedSavedSimulationError}
            onSelectSavedSimulation={handleSelectSavedSimulation}
            onClearSavedSimulation={clearSelectedSavedSimulation}
            lgaData={lgaData}
            historicalDates={historicalDates}
            historicalDatesLoading={historicalDatesLoading}
            selectedHistoricalDate={selectedHistoricalDate}
            onSelectHistoricalDate={setSelectedHistoricalDate}
            historicalMetadata={historicalMetadata}
            historicalSimulations={historicalSimulations}
            historicalLoading={historicalDayLoading}
            historicalError={historicalDataError}
            selectedHistoricalSimulationId={selectedHistoricalSimulationId}
            selectedHistoricalSimulation={selectedHistoricalSimulation}
            selectedHistoricalSimulationError={selectedHistoricalSimulationError}
            onSelectHistoricalSimulation={handleSelectHistoricalSimulation}
            onClearHistoricalSimulation={clearSelectedHistoricalSimulation}
            targetAreas={targetAreas}
            selectedTargetLga={selectedTargetLga}
            onSelectTargetLga={setSelectedTargetLga}
            historicalHighlightedLgas={historicalHighlightedLgas}
            historicalHighlightedLgaStatus={historicalHighlightedLgaStatus}
          />
        )}

        <div className="map-container">
          {(sidebarOpen || layerPanelOpen) && (
            <div
              className="mobile-panel-backdrop"
              onClick={() => { setSidebarOpen(false); setLayerPanelOpen(false); }}
            />
          )}
          {isFirstLoad && (
            <div className="loading-overlay"><div className="spinner" /></div>
          )}
          <MapView
            events={currentEvents}
            hotspots={currentHotspots}
            selectedEventId={selectedMapEventId}
            onSelectEvent={mode === 'realtime' ? handleSelectRealtimeCluster : handleSelectEvent}
            layers={layers}
            activeProducts={displayedActiveProducts}
            eventColors={EVENT_COLORS}
            flyTo={flyTo}
            mode={mode}
            sidebarOpen={sidebarOpen}
            layerPanelOpen={layerPanelOpen}
            deaLayerConfig={deaLayerConfig}
            activeOverlays={activeOverlays}
            lgaData={lgaData}
            showLga={showLga}
            ignitions={mode === 'realtime' ? rtIgnitions : null}
            simulationResult={mapSimulationResult}
            activeSimLayers={activeSimLayers}
            simGroupFeatures={simGroupFeatures}
            selectedSimHotspot={selectedSimHotspot}
            checkedSimulationHotspots={checkedSimHotspots}
            selectedRealtimeHotspots={selectedRealtimeHotspots}
            customSimPoint={customSimPoint}
            onMapClickSimPoint={handleMapClickSimPoint}
            onSelectRealtimeHotspots={handlePickRealtimeHotspots}
            onSelectRealtimeHotspot={handleSelectRealtimeHotspot}
            onSelectSimulationHotspot={handleSelectSimHotspot}
            onClearSimulationHotspotSelection={handleClearSimulationHotspotSelection}
            onOverlayLoadingChange={handleOverlayLoadingChange}
            simulationLegendTitle={mapSimulationLegendTitle}
            simulationLayerLoadState={mapSimulationLoadState}
            bushfireExtentsData={bushfireExtentsData}
            showBushfireExtents={showBushfireExtents}
            rfsFacilitiesData={rfsFacilitiesData}
            showRfsFacilities={showRfsFacilities}
            npwsFireHistoryData={npwsFireHistoryData}
            showNpwsFireHistory={npwsFireHistoryEnabled}
            bboxDrawMode={bboxDrawMode}
            onBboxDrawn={handleBboxDrawn}
            drawnBbox={drawnBbox}
            highlightedLga={highlightedLga}
            historicalHighlightedLgas={historicalMode ? historicalHighlightedLgas : null}
            targetAreas={targetAreas}
            selectedTargetLga={selectedTargetLga}
            frpSelectionMode={frpSelectionMode && mode === 'realtime'}
            onFrpHotspotPick={handleFrpHotspotPick}
            onFrpAreaSelect={handleFrpAreaSelect}
            frpSelectedPoints={frpSelectedPoints}
          />
          {(mode === 'realtime' || mode === 'simulation') && (
            <button
              className={`search-tool-toggle-btn ${toolsMenuOpen || searchToolOpen || frpPlotOpen ? 'active' : ''}`}
              onClick={handleToolsMenuToggle}
              title="Tools: Search & Plot FRP"
            >
              Tools ▾
            </button>
          )}
          {(mode === 'realtime' || mode === 'simulation') && (
            <ToolsMenu
              open={toolsMenuOpen}
              onClose={() => setToolsMenuOpen(false)}
              onOpenSearch={STATIC_MODE ? undefined : handleOpenSearchTool}
              onOpenFrpPlot={mode === 'realtime' ? handleOpenFrpPlot : undefined}
              searchActive={searchToolOpen}
              frpActive={frpPlotOpen}
            />
          )}
          {searchToolOpen && !STATIC_MODE && (mode === 'realtime' || mode === 'simulation') && (
            <SearchToolPanel
              lgaData={lgaData}
              onDrawBbox={handleDrawBbox}
              drawnBbox={drawnBbox}
              onClearBbox={handleClearBbox}
              onFlyTo={setFlyTo}
              onHighlightLga={setHighlightedLga}
              onClose={() => setSearchToolOpen(false)}
            />
          )}
          {frpPlotOpen && mode === 'realtime' && (
            <FrpPlotPanel
              selectedSummaries={frpSelectedSummaries}
              onClose={handleCloseFrpPanel}
              onClearSelection={handleFrpClearSelection}
              onRemoveOne={handleFrpRemoveOne}
              onExitSelectionMode={handleFrpExitSelectionMode}
              selectionModeActive={frpSelectionMode}
              onToggleSelectionMode={handleFrpToggleSelectionMode}
            />
          )}
          {(mode === 'realtime' || mode === 'simulation') && (
            <div className="map-debug-control">
              <label className="map-debug-control-label" htmlFor="hotspot-monitoring-window">
                Hotspot Monitoring Window
              </label>
              <select
                id="hotspot-monitoring-window"
                className="map-debug-control-select"
                value={hotspotMonitoringHours}
                onChange={(e) => handleMonitoringWindowChange(e.target.value)}
              >
                {HOTSPOT_MONITORING_WINDOW_OPTIONS.map((hours) => (
                  <option key={hours} value={hours}>{hours} hours</option>
                ))}
              </select>
            </div>
          )}
        </div>

        <LayerPanel
          open={layerPanelOpen}
          onClose={() => setLayerPanelOpen(false)}
          layers={layers}
          onToggleLayer={handleToggleLayer}
          status={status}
          mode={mode}
          allProducts={allProducts}
          activeProducts={displayedActiveProducts}
          onToggleProduct={handleToggleProduct}
          onToggleProductGroup={handleToggleProductGroup}
          showAsPolygons={showAsPolygons}
          onTogglePolygons={setShowAsPolygons}
          polygonLoading={rtLoading && showAsPolygons}
          rtLoading={rtLoading}
          rtEventLoading={rtEventsLoading}
          rtIgnitionLoading={rtIgnitionsLoading}
          productColors={PRODUCT_COLORS}
          rtMetadata={rtMetadata}
          rtEventMetadata={rtEventMetadata}
          deaLayerConfig={deaLayerConfig}
          deaCacheStats={deaCacheStats}
          activeOverlays={activeOverlays}
          overlayLoadingState={overlayLoadingState}
          overlayErrorState={overlayErrorState}
          onToggleOverlay={handleToggleOverlay}
          lgaData={lgaData}
          showLga={showLga}
          onToggleLga={() => setShowLga(v => !v)}
          onFlyToLga={handleFlyToLga}
          activeSimLayers={activeSimLayers}
          onToggleSimLayer={toggleSimLayer}
          showBushfireExtents={showBushfireExtents}
          onToggleBushfireExtents={() => setShowBushfireExtents(v => !v)}
          bushfireExtentsLoading={bushfireExtentsLoading}
          showRfsFacilities={showRfsFacilities}
          onToggleRfsFacilities={() => setShowRfsFacilities(v => !v)}
          rfsFacilitiesLoading={rfsFacilitiesLoading}
          historicalMetadata={historicalMetadata}
        />
      </main>

      {mode === 'historical' && (
        <TimeSlider
          timeRange={histTimeRange}
          timeFilter={timeFilter}
          onChange={setTimeFilter}
        />
      )}
    </div>
  );
}
