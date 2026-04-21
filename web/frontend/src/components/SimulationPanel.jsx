import { useState, useEffect, useMemo, useRef } from 'react';
import { checkSimulationHealth } from '../api';
import { getDisplayHotspotId, getSourceHotspotId } from '../utils/hotspots';
import { normaliseRoadsGeoJson } from '../utils/roads';
import { downloadSimulationResult } from '../utils/download';

/**
 * Format an ISO datetime for display.
 */
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-AU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney', timeZoneName: 'short',
    });
  } catch { return iso; }
}

/**
 * Format epoch seconds to a readable Sydney local datetime string.
 */
function fmtEpoch(epoch) {
  if (epoch == null) return '—';
  try {
    const d = new Date(epoch * 1000);
    return d.toLocaleString('en-AU', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      timeZone: 'Australia/Sydney', timeZoneName: 'short',
    });
  } catch { return String(epoch); }
}

function getRoadDurationSeconds(props = {}) {
  const candidate = [
    props.impact_duration_seconds,
    props.duration_seconds,
    props.impact_duration,
    props.duration,
  ].find(value => value !== undefined && value !== null && value !== '');
  const numeric = Number(candidate);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

/** Format a short time only */
function fmtTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' });
  } catch { return ''; }
}

/** How long ago in human-readable form */
function timeAgo(iso) {
  if (!iso) return '';
  try {
    const ms = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch { return ''; }
}

/**
 * Serialize a Date for Inferno in UTC without fractional seconds.
 */
function toInfernoUtcIso(date) {
  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return iso.replace('Z', '+00:00');
}

const PRODUCT_LABELS = {
  bright_ahi: 'BRIGHT AHI v1.86',
  bright_s3: 'BRIGHT AHI v2.0',
};

function getProductLabel(pid) { return PRODUCT_LABELS[pid] || pid; }

/** Sensor group for grouping filters */
function getSensorGroup(pid) {
  if (pid === 'bright_ahi' || pid === 'bright_s3') return 'AHI';
  return 'Other';
}

const PRODUCT_COLORS = {
  bright_ahi: '#ff6b35',
  bright_s3: '#ff3333',
};

const TIME_FILTERS = [
  { label: 'Last 1h', hours: 1 },
  { label: 'Last 6h', hours: 6 },
];

// NSW approximate bounding box for validation
const NSW_BOUNDS = { latMin: -37.6, latMax: -28.0, lngMin: 140.0, lngMax: 154.0 };

function isInsideNSW(lat, lng) {
  return lat >= NSW_BOUNDS.latMin && lat <= NSW_BOUNDS.latMax
    && lng >= NSW_BOUNDS.lngMin && lng <= NSW_BOUNDS.lngMax;
}

/**
 * Reverse geocode using Mapbox Geocoding API.
 * Groups nearby hotspots to minimise API calls.
 */
const placeNameCache = new Map();

function isUsefulPlaceName(name) {
  if (!name) return false;
  const text = String(name).trim();
  if (!text) return false;
  if (/^-?\d+(\.\d+)?$/.test(text)) return false;
  if (/^-?\d+(\.\d+)?[, ]+\s*-?\d+(\.\d+)?$/.test(text)) return false;
  return true;
}

function getMapboxPlaceName(feature) {
  const props = feature?.properties || {};
  const context = props.context || {};
  const candidates = [
    context.neighborhood?.name,
    context.locality?.name,
    context.place?.name,
    context.district?.name,
    context.region?.name,
    props.place_formatted,
    props.full_address,
    props.name,
  ];
  return candidates.find(isUsefulPlaceName) || null;
}

function getValidFrp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric;
}

function formatFrp(value) {
  const numeric = getValidFrp(value);
  return numeric == null ? 'Unknown FRP' : `${numeric.toFixed(1)} MW`;
}

function makeCoordKey(lat, lng) {
  return `${Number(lat).toFixed(2)},${Number(lng).toFixed(2)}`;
}

function normalizePlaceName(name) {
  if (!isUsefulPlaceName(name)) return null;
  return String(name).trim().toLowerCase().replace(/\s+/g, ' ');
}

function makeLocationGroupKey(hotspot, placeName) {
  const normalizedPlaceName = normalizePlaceName(placeName);
  if (normalizedPlaceName) return `place:${normalizedPlaceName}`;
  return `coord:${hotspot.coordKey}`;
}

async function reverseGeocode(lat, lng) {
  // Round to ~1km grid to cache nearby lookups
  const key = makeCoordKey(lat, lng);
  if (placeNameCache.has(key)) return placeNameCache.get(key);

  try {
    const token = import.meta.env.VITE_MAPBOX_TOKEN;
    if (token) {
      const res = await fetch(
        `https://api.mapbox.com/search/geocode/v6/reverse?longitude=${lng}&latitude=${lat}&access_token=${token}`
      );
      if (res.ok) {
        const data = await res.json();
        for (const feat of (data.features || [])) {
          const name = getMapboxPlaceName(feat);
          if (name) {
            placeNameCache.set(key, name);
            return name;
          }
        }
        const fallback = getMapboxPlaceName(data.features?.[0]);
        if (fallback) {
          placeNameCache.set(key, fallback);
          return fallback;
        }
      }
    }

    const osmRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=jsonv2&zoom=10&addressdetails=1`
    );
    if (!osmRes.ok) return null;
    const osm = await osmRes.json();
    const address = osm.address || {};
    const name = address.suburb
      || address.locality
      || address.town
      || address.village
      || address.hamlet
      || address.city
      || address.city_district
      || address.municipality
      || address.county
      || address.state_district
      || address.state
      || osm.name
      || osm.display_name;
    if (name) {
      placeNameCache.set(key, name);
      return name;
    }
    placeNameCache.set(key, null);
    return null;
  } catch {
    placeNameCache.set(key, null);
    return null;
  }
}

export default function SimulationPanel({
  hotspots,
  onSelectHotspot,
  simulationResult,
  simulationStatus,
  simulationError,
  simulationProgress,
  onRunSimulation,
  onClearSimulation,
  selectedHotspot,
  activeSimLayers,
  onToggleSimLayer,
  onSetSimGroupFeatures,
  customSimPoint,
  customPointMode,
  onSetCustomPointMode,
  onSetCustomSimPoint,
  onFlyTo,
  onCheckedHotspotsChange,
  selectionClearVersion,
  monitoringWindowHours,
}) {
  const [customLat, setCustomLat] = useState('');
  const [customLng, setCustomLng] = useState('');
  const [customDateTime, setCustomDateTime] = useState('');

  const [useCustom, setUseCustom] = useState(false);
  const [nswWarning, setNswWarning] = useState(false);

  // View mode: 'location' groups by place, 'hotspot' lists individually
  const [viewMode, setViewMode] = useState('location');

  // Filters
  const [timeFilter, setTimeFilter] = useState(monitoringWindowHours || 12);
  const [sensorFilter, setSensorFilter] = useState('all');
  const [sortBy, setSortBy] = useState('time');

  // Place names
  const [placeNames, setPlaceNames] = useState({});
  const geocodeBatchRef = useRef(null);
  const geocodeInFlightRef = useRef(new Set());
  const groupRefs = useRef({});
  const hotspotItemRefs = useRef({});
  const previousMonitoringWindowRef = useRef(monitoringWindowHours || 12);
  // Location mode state
  const [selectedGroupKey, setSelectedGroupKey] = useState(null);
  const [checkedIdxs, setCheckedIdxs] = useState(new Set());

  // Inferno health
  const [serverHealth, setServerHealth] = useState(null);
  const [downloadStatus, setDownloadStatus] = useState(''); // 'downloading', 'success', 'error', ''

  const clearHotspotSelection = () => {
    setSelectedGroupKey(null);
    setCheckedIdxs(new Set());
    onSetSimGroupFeatures?.(null);
    onSelectHotspot?.(null);
  };

  const clearCustomPoint = () => {
    onSetCustomPointMode?.(false);
    onSetCustomSimPoint?.(null);
  };

  const clearCustomInputs = () => {
    setCustomLat('');
    setCustomLng('');
    setCustomDateTime('');

    setNswWarning(false);
  };

  useEffect(() => {
    checkSimulationHealth()
      .then(setServerHealth)
      .catch(() => setServerHealth({ status: 'error', message: 'Backend unreachable' }));
  }, []);

  // Sync custom point from map click into form fields + NSW check
  useEffect(() => {
    if (customSimPoint && useCustom) {
      setCustomLat(String(customSimPoint.lat.toFixed(6)));
      setCustomLng(String(customSimPoint.lng.toFixed(6)));
      setNswWarning(!isInsideNSW(customSimPoint.lat, customSimPoint.lng));
    }
  }, [customSimPoint, useCustom]);

  useEffect(() => {
    if (!useCustom) return;
    clearHotspotSelection();
  }, [useCustom]);

  useEffect(() => {
    if (!useCustom) return;
  }, [useCustom, customDateTime]);

  useEffect(() => {
    if (useCustom || customPointMode) return;
    onSetCustomSimPoint?.(null);
  }, [useCustom, customPointMode, onSetCustomSimPoint]);

  useEffect(() => {
    const windowHours = monitoringWindowHours || 12;
    setTimeFilter(prev => {
      const previousWindow = previousMonitoringWindowRef.current;
      previousMonitoringWindowRef.current = windowHours;
      if (prev === previousWindow || prev > windowHours) return windowHours;
      return prev;
    });
  }, [monitoringWindowHours]);

  // Extract hotspot features
  const hotspotList = useMemo(() => {
    if (!hotspots?.features?.length) return [];
    return hotspots.features
      .filter(f => f.geometry)
      .map((f, idx) => {
        const p = f.properties || {};
        let lat, lng;
        if (f.geometry.type === 'Point') {
          [lng, lat] = f.geometry.coordinates;
        } else if (f.geometry.type === 'Polygon') {
          const ring = f.geometry.coordinates[0];
          lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
          lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
        } else if (f.geometry.type === 'MultiPolygon') {
          const ring = f.geometry.coordinates[0][0];
          lng = ring.reduce((s, c) => s + c[0], 0) / ring.length;
          lat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
        } else {
          return null;
        }
        return {
          id: getSourceHotspotId(p, { id: f.id, idx }),
          displayId: getDisplayHotspotId(p, { id: f.id, idx, product_id: p.product_id || 'unknown' }),
          idx,
          lat,
          lng,
          coordKey: makeCoordKey(lat, lng),
          datetime: p.datetime || p.dt || p.hotspot_datetime || '',
          frp: getValidFrp(p.frp_mw ?? p.power ?? p.frp),
          product_id: p.product_id || 'unknown',
          confidence: p.confidence || '',
          sensor: getSensorGroup(p.product_id || 'unknown'),
          properties: p,
        };
      })
      .filter(Boolean);
  }, [hotspots]);

  useEffect(() => {
    setCheckedIdxs(prev => {
      if (prev.size === 0) return prev;
      const visibleIdxs = new Set(hotspotList.map(hs => hs.idx));
      const next = new Set([...prev].filter(idx => visibleIdxs.has(idx)));
      return next.size === prev.size ? prev : next;
    });
  }, [hotspotList]);

  // Apply filters
  const filteredHotspots = useMemo(() => {
    const now = Date.now();
    const cutoff = now - timeFilter * 3600000;
    let filtered = hotspotList.filter(hs => {
      if (hs.datetime) {
        const t = new Date(hs.datetime).getTime();
        if (!isNaN(t) && t < cutoff) return false;
      }
      if (sensorFilter !== 'all' && hs.sensor !== sensorFilter) return false;
      return true;
    });
    if (sortBy === 'frp') {
      filtered.sort((a, b) => (b.frp || 0) - (a.frp || 0));
    } else {
      filtered.sort((a, b) => {
        const ta = a.datetime ? new Date(a.datetime).getTime() : 0;
        const tb = b.datetime ? new Date(b.datetime).getTime() : 0;
        return tb - ta;
      });
    }
    return filtered;
  }, [hotspotList, timeFilter, sensorFilter, sortBy]);

  const availableSensors = useMemo(() => {
    const groups = new Set(hotspotList.map(h => h.sensor));
    return Array.from(groups).sort();
  }, [hotspotList]);

  const timeFilterOptions = useMemo(() => {
    const windowHours = monitoringWindowHours || 12;
    const options = [...TIME_FILTERS];
    if (!options.some(option => option.hours === windowHours)) {
      options.push({ label: `Window (${windowHours}h)`, hours: windowHours });
    } else {
      for (const option of options) {
        if (option.hours === windowHours) {
          option.label = `Window (${windowHours}h)`;
        }
      }
    }
    return options.filter(option => option.hours <= windowHours).sort((left, right) => left.hours - right.hours);
  }, [monitoringWindowHours]);

  // Batch reverse geocode visible hotspots
  useEffect(() => {
    if (filteredHotspots.length === 0) return undefined;
    if (geocodeBatchRef.current) clearTimeout(geocodeBatchRef.current);

    let cancelled = false;

    const syncCachedPlaceNames = () => {
      const cachedNames = {};
      for (const hs of filteredHotspots) {
        const cachedName = placeNameCache.get(hs.coordKey);
        if (cachedName) cachedNames[hs.coordKey] = cachedName;
      }

      if (Object.keys(cachedNames).length === 0) return;

      setPlaceNames(prev => {
        let changed = false;
        const next = { ...prev };
        for (const [key, value] of Object.entries(cachedNames)) {
          if (next[key] === value) continue;
          next[key] = value;
          changed = true;
        }
        return changed ? next : prev;
      });
    };

    const queueNextBatch = async () => {
      if (cancelled) return;

      syncCachedPlaceNames();

      const uniqueCandidates = [];
      const seen = new Set();
      for (const hs of filteredHotspots) {
        const key = hs.coordKey;
        if (seen.has(key)) continue;
        seen.add(key);
        if (placeNameCache.has(key) || geocodeInFlightRef.current.has(key)) continue;
        uniqueCandidates.push(hs);
      }

      if (uniqueCandidates.length === 0) return;

      const batch = uniqueCandidates.slice(0, 6);
      batch.forEach(hs => geocodeInFlightRef.current.add(hs.coordKey));

      const results = await Promise.all(
        batch.map(async (hs) => {
          const name = await reverseGeocode(hs.lat, hs.lng);
          return { key: hs.coordKey, name };
        })
      );

      batch.forEach(hs => geocodeInFlightRef.current.delete(hs.coordKey));
      if (cancelled) return;

      const newNames = {};
      for (const result of results) {
        if (result.name) newNames[result.key] = result.name;
      }

      if (Object.keys(newNames).length > 0) {
        setPlaceNames(prev => {
          let changed = false;
          const next = { ...prev };
          for (const [key, value] of Object.entries(newNames)) {
            if (next[key] === value) continue;
            next[key] = value;
            changed = true;
          }
          return changed ? next : prev;
        });
      }

      const hasMore = filteredHotspots.some(
        hs => !placeNameCache.has(hs.coordKey) && !geocodeInFlightRef.current.has(hs.coordKey)
      );
      if (hasMore) {
        geocodeBatchRef.current = setTimeout(queueNextBatch, 150);
      }
    };

    geocodeBatchRef.current = setTimeout(queueNextBatch, 250);

    return () => {
      cancelled = true;
      if (geocodeBatchRef.current) clearTimeout(geocodeBatchRef.current);
    };
  }, [filteredHotspots]);

  // Location groups with stats
  const locationGroups = useMemo(() => {
    const groups = {};
    for (const hs of filteredHotspots) {
      const placeName = placeNames[hs.coordKey] || null;
      const key = makeLocationGroupKey(hs, placeName);
      if (!groups[key]) groups[key] = { key, hotspots: [], placeName };
      groups[key].hotspots.push(hs);
      if (!groups[key].placeName && placeName) groups[key].placeName = placeName;
    }
    return Object.values(groups).map(g => {
      const frps = g.hotspots.map(h => h.frp).filter(v => v != null && v > 0);
      const sorted = [...g.hotspots].sort((a, b) => {
        const ta = a.datetime ? new Date(a.datetime).getTime() : Infinity;
        const tb = b.datetime ? new Date(b.datetime).getTime() : Infinity;
        return ta - tb;
      });
      const fallbackName = `${sorted[0]?.lat?.toFixed(2)}°, ${sorted[0]?.lng?.toFixed(2)}°`;
      return {
        ...g,
        name: g.placeName || fallbackName,
        hotspots: sorted,
        count: g.hotspots.length,
        frpMin: frps.length ? Math.min(...frps) : null,
        frpMax: frps.length ? Math.max(...frps) : null,
        frpTotal: frps.length ? frps.reduce((s, v) => s + v, 0) : null,
        earliestTime: sorted[0]?.datetime || null,
        centroidLat: g.hotspots.reduce((s, h) => s + h.lat, 0) / g.hotspots.length,
        centroidLng: g.hotspots.reduce((s, h) => s + h.lng, 0) / g.hotspots.length,
      };
    }).sort((a, b) => {
      if (sortBy === 'frp') return (b.frpTotal || 0) - (a.frpTotal || 0);
      const ta = a.earliestTime ? new Date(a.earliestTime).getTime() : 0;
      const tb = b.earliestTime ? new Date(b.earliestTime).getTime() : 0;
      return tb - ta;
    });
  }, [filteredHotspots, placeNames, sortBy]);

  // Hotspot numbering within location groups (for hotspot mode)
  const hotspotNumbers = useMemo(() => {
    const numbers = {};
    for (const group of locationGroups) {
      group.hotspots.forEach((hs, i) => {
        numbers[hs.idx] = { number: i + 1, locationName: group.name, total: group.count };
      });
    }
    return numbers;
  }, [locationGroups]);

  useEffect(() => {
    if (!selectedHotspot) return;
    const matchingGroup = locationGroups.find(group => group.hotspots.some(hs => hs.idx === selectedHotspot.idx));
    if (!matchingGroup) return;
    clearCustomPoint();
    setUseCustom(false);
    if (viewMode === 'location' && selectedGroupKey !== matchingGroup.key) {
      setSelectedGroupKey(matchingGroup.key);
    }
  }, [selectedHotspot, locationGroups, viewMode, selectedGroupKey]);

  useEffect(() => {
    if (!selectionClearVersion) return;
    setSelectedGroupKey(null);
    setCheckedIdxs(new Set());
  }, [selectionClearVersion]);

  useEffect(() => {
    if (!selectedGroupKey) return;
    if (locationGroups.some(group => group.key === selectedGroupKey)) return;

    const matchingGroup = locationGroups.find(group => group.hotspots.some(hs => checkedIdxs.has(hs.idx)));
    if (matchingGroup) {
      setSelectedGroupKey(matchingGroup.key);
      return;
    }

    setSelectedGroupKey(null);
  }, [selectedGroupKey, locationGroups, checkedIdxs]);

  // When group selection changes, notify map for boundary only.
  useEffect(() => {
    if (selectedGroupKey) {
      const group = locationGroups.find(g => g.key === selectedGroupKey);
      if (group && group.hotspots.length > 0) {
        if (onSetSimGroupFeatures && hotspots?.features) {
          const groupIdxs = new Set(group.hotspots.map(h => h.idx));
          const features = hotspots.features.filter((_, i) => groupIdxs.has(i));
          onSetSimGroupFeatures({ type: 'FeatureCollection', features });
        }
      }
    } else {
      if (onSetSimGroupFeatures) onSetSimGroupFeatures(null);
    }
  }, [selectedGroupKey, locationGroups, hotspots, onSetSimGroupFeatures]);

  useEffect(() => {
    if (!selectedGroupKey) return;
    const el = groupRefs.current[selectedGroupKey];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedGroupKey]);

  useEffect(() => {
    if (viewMode !== 'hotspot' || !selectedHotspot) return;
    const el = hotspotItemRefs.current[selectedHotspot.idx];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedHotspot, viewMode]);

  useEffect(() => {
    if (!selectedHotspot) return;
    const stillVisible = hotspotList.some(hs => hs.idx === selectedHotspot.idx);
    if (!stillVisible) {
      onSelectHotspot(null);
    }
  }, [selectedHotspot, hotspotList, onSelectHotspot]);

  // Propagate checked hotspots to parent for map highlighting
  useEffect(() => {
    if (!onCheckedHotspotsChange) return;
    if (checkedIdxs.size === 0) {
      onCheckedHotspotsChange([]);
      return;
    }
    const checked = hotspotList.filter(hs => checkedIdxs.has(hs.idx));
    onCheckedHotspotsChange(checked);
  }, [checkedIdxs, hotspotList, onCheckedHotspotsChange]);

  // Handlers
  const handleToggleGroup = (key) => {
    const nextKey = selectedGroupKey === key ? null : key;
    setSelectedGroupKey(nextKey);
    setCheckedIdxs(new Set());
    const nextGroup = locationGroups.find(item => item.key === nextKey);
    const containsSelected = nextGroup?.hotspots?.some(hs => hs.idx === selectedHotspot?.idx);
    if (!nextKey || !containsSelected) {
      onSelectHotspot(null);
    }
  };

  const handleToggleCheck = (idx) => {
    setCheckedIdxs(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleRunFromGroup = () => {
    const group = locationGroups.find(g => g.key === selectedGroupKey);
    if (!group) return;
    const checked = group.hotspots.filter(h => checkedIdxs.has(h.idx));
    if (checked.length === 0) return;
    const primary = checked[0];
    const startDt = primary.datetime
      ? toInfernoUtcIso(new Date(primary.datetime))
      : toInfernoUtcIso(new Date());
    const points = checked.map((h, i) => ({
      lat: h.lat,
      lng: h.lng,
      id: `detection${i + 1}`,
    }));
    onRunSimulation({
      points,
      startDateTime: startDt,
      lat: primary.lat,
      lng: primary.lng,
      source: {
        mode: 'group',
        source_group_key: selectedGroupKey,
        source_hotspot_id: primary.id,
        source_hotspot_ids: checked.map(h => h.id),
        source_product_id: primary.product_id,
        source_supercluster_id: primary.properties?.stable_id || primary.properties?.cluster_id || null,
      },
    });
  };

  const handleRunFromHotspot = () => {
    if (!selectedHotspot) return;
    const startDt = selectedHotspot.datetime
      ? toInfernoUtcIso(new Date(selectedHotspot.datetime))
      : toInfernoUtcIso(new Date());
    onRunSimulation({
      lat: selectedHotspot.lat,
      lng: selectedHotspot.lng,
      startDateTime: startDt,
      source: {
        mode: 'hotspot',
        source_hotspot_id: selectedHotspot.id,
        source_hotspot_ids: [selectedHotspot.id],
        source_product_id: selectedHotspot.product_id,
        source_supercluster_id: selectedHotspot.properties?.stable_id || selectedHotspot.properties?.cluster_id || null,
      },
    });
  };

  const handleRunCustom = () => {
    const lat = parseFloat(customLat);
    const lng = parseFloat(customLng);
    if (isNaN(lat) || isNaN(lng)) return;
    setNswWarning(!isInsideNSW(lat, lng));
    const startDt = customDateTime
      ? toInfernoUtcIso(new Date(customDateTime))
      : toInfernoUtcIso(new Date());
    onRunSimulation({ lat, lng, startDateTime: startDt, source: { mode: 'custom' } });
  };

  const isRunning = simulationStatus === 'running';
  const STATIC_MODE = import.meta.env.VITE_STATIC_MODE === 'true';

  const canRunLocation = selectedGroupKey && checkedIdxs.size > 0;
  const canRunHotspot = viewMode === 'hotspot' && selectedHotspot;
  const canRunCustom = customDateTime && customLat !== '' && customLng !== ''
    && Number.isFinite(Number(customLat)) && Number.isFinite(Number(customLng));

  const handleDownloadSimulationResult = async () => {
    if (!simulationResult) return;
    
    setDownloadStatus('downloading');
    try {
      downloadSimulationResult(simulationResult);
      setDownloadStatus('success');
      setTimeout(() => setDownloadStatus(''), 2000);
    } catch (err) {
      console.error('Download failed:', err);
      setDownloadStatus('error');
      setTimeout(() => setDownloadStatus(''), 3000);
    }
  };

  return (
    <>
      <div className="sidebar-header">
        <h2>
          <span className="fire-icon">🔥</span>
          Fire Spread Simulation
          <span className="text-muted text-sm" style={{ fontWeight: 400, marginLeft: 4 }}>
            Inferno
          </span>
        </h2>
      </div>

      {serverHealth && serverHealth.status !== 'ok' && (
        <div className="sim-health-banner">
          ⚠️ <strong>Inferno server unreachable</strong>
          <div className="text-sm" style={{ marginTop: 2 }}>{serverHealth.message}</div>
        </div>
      )}

      <div className="sim-panel">
        {/* Top mode toggle: Hotspot vs Custom */}
        <div className="sim-mode-toggle">
          <button
            className={`sim-mode-btn ${!useCustom ? 'active' : ''}`}
            onClick={() => {
              setUseCustom(false);
              clearCustomPoint();
              clearCustomInputs();
            }}
          >
            🛰 From Hotspot
          </button>
          <button
            className={`sim-mode-btn ${useCustom ? 'active' : ''}`}
            onClick={() => {
              clearHotspotSelection();
              setUseCustom(true);
            }}
          >
            📍 Custom Point
          </button>
        </div>

        {!useCustom ? (
          <>
            {/* View mode sub-toggle */}
            <div className="sim-view-toggle">
              <button
                className={`sim-pill ${viewMode === 'location' ? 'active' : ''}`}
                onClick={() => {
                  clearCustomPoint();
                  setViewMode('location');
                  setSelectedGroupKey(null);
                  onSelectHotspot(null);
                }}
              >
                🏠 Select Group
              </button>
              <button
                className={`sim-pill ${viewMode === 'hotspot' ? 'active' : ''}`}
                onClick={() => {
                  clearCustomPoint();
                  setViewMode('hotspot');
                  setSelectedGroupKey(null);
                  if (onSetSimGroupFeatures) onSetSimGroupFeatures(null);
                }}
              >
                🛰 Select Individual
              </button>
            </div>

            {/* Filters */}
            <div className="sim-filters">
              <div className="sim-filter-row">
                <label>Time</label>
                <div className="sim-filter-pills">
                  {timeFilterOptions.map(tf => (
                    <button
                      key={tf.hours}
                      className={`sim-pill ${timeFilter === tf.hours ? 'active' : ''}`}
                      onClick={() => setTimeFilter(tf.hours)}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sim-filter-row">
                <label>Sort</label>
                <div className="sim-filter-pills">
                  <button
                    className={`sim-pill ${sortBy === 'time' ? 'active' : ''}`}
                    onClick={() => setSortBy('time')}
                  >
                    🕐 Newest
                  </button>
                  <button
                    className={`sim-pill ${sortBy === 'frp' ? 'active' : ''}`}
                    onClick={() => setSortBy('frp')}
                  >
                    🔥 Highest FRP
                  </button>
                </div>
              </div>
              <div className="sim-filter-count">
                {filteredHotspots.length} hotspots
                {filteredHotspots.length !== hotspotList.length && (
                  <span className="text-muted"> (of {hotspotList.length})</span>
                )}
                <span className="text-muted"> · {locationGroups.length} locations</span>
              </div>
            </div>

            {filteredHotspots.length === 0 ? (
              <div className="no-data" style={{ padding: '16px' }}>
                <p>No hotspots match filters</p>
                <p className="text-sm text-muted">
                  {hotspotList.length === 0
                    ? 'Switch to Real-Time mode first to load hotspot data, then return here.'
                    : 'Try widening the time filter or selecting a different sensor.'}
                </p>
              </div>
            ) : viewMode === 'location' ? (
              /* ============ LOCATION MODE ============ */
              <div className="sim-hotspot-list">
                {locationGroups.map(group => {
                  const isExpanded = selectedGroupKey === group.key;
                  return (
                    <div
                      key={group.key}
                      ref={(el) => {
                        if (el) groupRefs.current[group.key] = el;
                        else delete groupRefs.current[group.key];
                      }}
                      className={`sim-group-card ${isExpanded ? 'expanded' : ''}`}
                    >
                      <div className="sim-group-header" onClick={() => handleToggleGroup(group.key)}>
                        <div className="sim-group-name-row">
                          <span className="sim-group-arrow">{isExpanded ? '▼' : '▶'}</span>
                          <span className="sim-group-name">{group.name}</span>
                          <span className="sim-hs-count">{group.count}</span>
                        </div>
                        <div className="sim-group-stats">
                          {group.frpTotal != null && (
                            <>
                              {group.count > 1 && group.frpMin != null ? (
                                <span>FRP: {group.frpMin.toFixed(0)}–{group.frpMax.toFixed(0)} MW · Total: {group.frpTotal.toFixed(0)} MW</span>
                              ) : (
                                <span>FRP: {group.frpTotal.toFixed(1)} MW</span>
                              )}
                            </>
                          )}
                          {group.earliestTime && (
                            <span> · {timeAgo(group.earliestTime)}</span>
                          )}
                        </div>
                      </div>

                      {isExpanded && (
                        <div className="sim-group-expand">
                          {group.hotspots.map((hs, i) => {
                            const isChecked = checkedIdxs.has(hs.idx);
                            const color = PRODUCT_COLORS[hs.product_id] || '#ff6b35';
                            const isSelected = selectedHotspot?.idx === hs.idx;
                            return (
                              <div key={hs.idx} className={`sim-group-hs-item ${isSelected ? 'active' : ''}`}>
                                <label className="sim-hs-checkbox" onClick={e => e.stopPropagation()}>
                                  <input
                                    type="checkbox"
                                    name={`hotspot_${hs.idx}`}
                                    checked={isChecked}
                                    onChange={() => handleToggleCheck(hs.idx)}
                                  />
                                </label>
                                <span className="product-color-dot" style={{ background: color }} />
                                <div className="sim-hs-info" onClick={() => onSelectHotspot(hs, { flyTo: true })}>
                                  <div className="sim-hs-name">
                                    {hs.displayId || `Hotspot ${i + 1}`}
                                  </div>
                                  <div className="sim-hs-meta">
                                    {getProductLabel(hs.product_id)}
                                    {` · ${formatFrp(hs.frp)}`}
                                    {hs.datetime ? ` · ${fmtTime(hs.datetime)} · ${timeAgo(hs.datetime)}` : ''}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                          <div className="sim-group-hint">
                            {checkedIdxs.size} of {group.count} selected for simulation
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              /* ============ INDIVIDUAL HOTSPOT MODE ============ */
              <div className="sim-hotspot-list">
                {filteredHotspots.slice(0, 100).map(hs => {
                  const isSelected = selectedHotspot?.idx === hs.idx;
                  const color = PRODUCT_COLORS[hs.product_id] || '#ff6b35';
                  const num = hotspotNumbers[hs.idx];
                  const displayName = num
                    ? (hs.displayId || `${num.locationName} #${num.number}`)
                    : `${hs.lat.toFixed(3)}°, ${hs.lng.toFixed(3)}°`;
                  return (
                    <div
                      key={hs.idx}
                      ref={(el) => {
                        if (el) hotspotItemRefs.current[hs.idx] = el;
                        else delete hotspotItemRefs.current[hs.idx];
                      }}
                      className={`sim-hotspot-item ${isSelected ? 'active' : ''}`}
                      onClick={() => onSelectHotspot(hs, { flyTo: true })}
                    >
                      <span className="product-color-dot" style={{ background: color }} />
                      <div className="sim-hs-info">
                        <div className="sim-hs-name">
                          {displayName}
                        </div>
                        <div className="sim-hs-meta">
                          {getProductLabel(hs.product_id)}
                          {` · ${formatFrp(hs.frp)}`}
                          {hs.datetime ? ` · ${timeAgo(hs.datetime)}` : ''}
                        </div>
                      </div>
                      {hs.frp != null && (
                        <div className="sim-hs-frp">
                          {Number(hs.frp).toFixed(0)}
                          <span className="sim-hs-frp-unit">MW</span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {filteredHotspots.length > 100 && (
                  <div className="text-muted text-sm" style={{ padding: '8px 16px' }}>
                    Showing first 100 of {filteredHotspots.length} hotspots
                  </div>
                )}
              </div>
            )}

            {/* Selected info */}
            {viewMode === 'location' && selectedGroupKey && (
              <div className="sim-selected-info">
                <div className="detail-section-title">📍 {locationGroups.find(g => g.key === selectedGroupKey)?.name || selectedGroupKey}</div>
                {(() => {
                  const g = locationGroups.find(g => g.key === selectedGroupKey);
                  if (!g) return null;
                  return (
                    <>
                      <div className="detail-row">
                        <span className="detail-label">Hotspots</span>
                        <span className="detail-value">{g.count} hotspots</span>
                      </div>
                      <div className="detail-row">
                        <span className="detail-label">Coords</span>
                        <span className="detail-value font-mono" style={{ fontSize: 11 }}>
                          {g.centroidLat.toFixed(4)}°, {g.centroidLng.toFixed(4)}°
                        </span>
                      </div>
                      {g.frpTotal != null && g.count > 1 && (
                        <>
                          <div className="detail-row">
                            <span className="detail-label">FRP Range</span>
                            <span className="detail-value text-fire">
                              {g.frpMin.toFixed(1)} – {g.frpMax.toFixed(1)} MW
                            </span>
                          </div>
                          <div className="detail-row">
                            <span className="detail-label">Total FRP</span>
                            <span className="detail-value text-fire">{g.frpTotal.toFixed(1)} MW</span>
                          </div>
                        </>
                      )}
                      {g.frpTotal != null && g.count === 1 && (
                        <div className="detail-row">
                          <span className="detail-label">FRP</span>
                          <span className="detail-value text-fire">{g.frpTotal.toFixed(1)} MW</span>
                        </div>
                      )}
                      {g.earliestTime && (
                        <div className="detail-row">
                          <span className="detail-label">First Detection</span>
                          <span className="detail-value">{fmtDate(g.earliestTime)}</span>
                        </div>
                      )}
                    </>
                  );
                })()}
              </div>
            )}

            {viewMode === 'hotspot' && selectedHotspot && (
              <div className="sim-selected-info">
                <div className="detail-section-title">
                  📍 {hotspotNumbers[selectedHotspot.idx]
                    ? (selectedHotspot.displayId || `${hotspotNumbers[selectedHotspot.idx].locationName} #${hotspotNumbers[selectedHotspot.idx].number}`)
                    : 'Selected Hotspot'}
                </div>
                <div className="detail-row">
                  <span className="detail-label">Hotspot ID</span>
                  <span className="detail-value">{selectedHotspot.displayId || '—'}</span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Location</span>
                  <span className="detail-value">
                    <span className="font-mono" style={{ fontSize: 11 }}>
                      ({selectedHotspot.lat.toFixed(4)}°, {selectedHotspot.lng.toFixed(4)}°)
                    </span>
                  </span>
                </div>
                <div className="detail-row">
                  <span className="detail-label">Product</span>
                  <span className="detail-value">{getProductLabel(selectedHotspot.product_id)}</span>
                </div>
                {selectedHotspot.datetime && (
                  <div className="detail-row">
                    <span className="detail-label">Detection Time</span>
                    <span className="detail-value">{fmtDate(selectedHotspot.datetime)}</span>
                  </div>
                )}
                {selectedHotspot.frp != null && (
                  <div className="detail-row">
                    <span className="detail-label">FRP</span>
                    <span className="detail-value text-fire">{formatFrp(selectedHotspot.frp)}</span>
                  </div>
                )}
              </div>
            )}

            {/* 24hr age warning */}
            {(() => {
              const hs = viewMode === 'location'
                ? locationGroups.find(g => g.key === selectedGroupKey)?.hotspots?.[0]
                : selectedHotspot;
              if (hs?.datetime) {
                const ageMs = Date.now() - new Date(hs.datetime).getTime();
                if (ageMs > 24 * 60 * 60 * 1000) {
                  const ageHrs = Math.floor(ageMs / 3600000);
                  return (
                    <div className="sim-age-warning">
                      ⚠️ This hotspot is <strong>{ageHrs}h old</strong>. Weather data may not be available for dates greater than 24h in the past.
                    </div>
                  );
                }
              }
              return null;
            })()}

            {/* Run simulation */}
            {STATIC_MODE ? (
              <div className="sim-actions">
                <div className="sim-nsw-warning">
                  🛰️ <strong>Archived snapshot</strong> — running new fire simulations is disabled. Browse the pre-computed runs in the sidebar instead.
                </div>
              </div>
            ) : (
            <div className="sim-actions">
              {viewMode === 'location' ? (
                <button
                  className="sim-run-btn"
                  onClick={handleRunFromGroup}
                  disabled={!canRunLocation || isRunning}
                >
                  {isRunning ? (
                    <><span className="spinner-small" /> Running Simulation...</>
                  ) : (
                    `🔥 Run Simulation (${checkedIdxs.size} source${checkedIdxs.size !== 1 ? 's' : ''})`
                  )}
                </button>
              ) : (
                <button
                  className="sim-run-btn"
                  onClick={handleRunFromHotspot}
                  disabled={!canRunHotspot || isRunning}
                >
                  {isRunning ? (
                    <><span className="spinner-small" /> Running Simulation...</>
                  ) : (
                    '🔥 Run Fire Simulation'
                  )}
                </button>
              )}
              {isRunning && simulationProgress && (
                <div className="sim-progress-bar-container">
                  <div className="sim-progress-text">{simulationProgress}</div>
                  <div className="sim-progress-bar">
                    <div className="sim-progress-bar-fill" />
                  </div>
                </div>
              )}
            </div>
            )}
          </>
        ) : (
          /* ---- Custom point mode ---- */
          <>
            <div className="detail-section-title" style={{ padding: '8px 16px 4px' }}>Enter coordinates and time</div>
            <div className="sim-custom-form">
              <div className="sim-form-row">
                <label htmlFor="sim-lat">Latitude</label>
                <input id="sim-lat" name="latitude" type="number" step="any" placeholder="-33.8688" value={customLat} onChange={e => setCustomLat(e.target.value)} />
              </div>
              <div className="sim-form-row">
                <label htmlFor="sim-lng">Longitude</label>
                <input id="sim-lng" name="longitude" type="number" step="any" placeholder="151.2093" value={customLng} onChange={e => setCustomLng(e.target.value)} />
              </div>
              <button
                className="sim-flyto-btn"
                type="button"
                disabled={!customLat || !customLng || isNaN(parseFloat(customLat)) || isNaN(parseFloat(customLng))}
                onClick={() => {
                  const lat = parseFloat(customLat);
                  const lng = parseFloat(customLng);
                  if (Number.isFinite(lat) && Number.isFinite(lng)) {
                    onFlyTo?.({ center: [lng, lat], zoom: 12 });
                  }
                }}
              >
                📍 Fly to coordinates
              </button>
              <div className="sim-form-row">
                <label htmlFor="sim-start-time">Start Time (local)</label>
                <input
                  id="sim-start-time"
                  name="start_time"
                  type="datetime-local"
                  className="sim-datetime-input"
                  value={customDateTime}
                  onChange={e => setCustomDateTime(e.target.value)}
                />
                <span className="sim-form-status">
                  {customDateTime ? `Selected: ${fmtDate(customDateTime)}` : 'Select a time before running'}
                </span>
              </div>
              <button
                className={`sim-map-click-btn ${customPointMode ? 'active' : ''}`}
                onClick={() => {
                  const next = !customPointMode;
                  onSetCustomPointMode?.(next);
                  if (!next) onSetCustomSimPoint?.(null);
                }}
              >
                {customPointMode ? '🎯 Click map to place point (active)' : '📌 Click map to set coordinates'}
              </button>
              <div className="text-muted text-sm" style={{ padding: '4px 0' }}>
                Simulation uses weather data from 24h before to 72h after the start time.
              </div>
            </div>
            {STATIC_MODE ? (
              <div className="sim-actions">
                <div className="sim-nsw-warning">
                  🛰️ <strong>Archived snapshot</strong> — running new fire simulations is disabled.
                </div>
              </div>
            ) : (
              <div className="sim-actions">
                {nswWarning && (
                  <div className="sim-nsw-warning">
                    ⚠️ <strong>Outside NSW</strong> — This point is outside the NSW boundary. Simulation may be limited or unavailable.
                  </div>
                )}
                <button
                  className="sim-run-btn"
                  onClick={handleRunCustom}
                  disabled={!canRunCustom || isRunning}
                >
                  {isRunning ? (
                    <><span className="spinner-small" /> Running Simulation...</>
                  ) : (
                    '🔥 Run Fire Simulation'
                  )}
                </button>
                {isRunning && simulationProgress && (
                  <div className="sim-progress-bar-container">
                    <div className="sim-progress-text">{simulationProgress}</div>
                    <div className="sim-progress-bar">
                      <div className="sim-progress-bar-fill" />
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Simulation error */}
        {simulationStatus === 'error' && simulationError && (
          <div className="sim-error">
            <strong>⚠️ Simulation failed</strong>
            <div className="sim-error-detail">{simulationError}</div>
          </div>
        )}

        {/* Simulation results */}
        {simulationResult && (
          <div className="sim-results">
            <div className="detail-section-title">📊 Simulation Results</div>

            <div className="detail-row">
              <span className="detail-label">Location</span>
              <span className="detail-value font-mono">
                {simulationResult.lat?.toFixed(4)}°, {simulationResult.lng?.toFixed(4)}°
              </span>
            </div>
            <div className="detail-row">
              <span className="detail-label">Start Time</span>
              <span className="detail-value">{fmtDate(simulationResult.startDateTime)}</span>
            </div>

            {/* Fire summary table */}
            {simulationResult.results?.variables && (
              <div className="sim-summary-table">
                <div className="detail-section-title">🔥 Fire Summary</div>
                <table className="sim-table">
                  <tbody>
                    {simulationResult.results.variables.area_sim != null && (
                      <tr>
                        <td className="sim-table-label">Total Fire Area</td>
                        <td className="sim-table-value">
                          {Number(simulationResult.results.variables.area_sim).toFixed(1)} ha
                        </td>
                      </tr>
                    )}
                    {simulationResult.results.variables.area_high_intensity != null && (
                      <tr>
                        <td className="sim-table-label">High Intensity Area (&gt;10,000 kW)</td>
                        <td className="sim-table-value text-fire">
                          {Number(simulationResult.results.variables.area_high_intensity).toFixed(1)} ha
                        </td>
                      </tr>
                    )}
                    {simulationResult.results.variables.area_sim != null &&
                     simulationResult.results.variables.area_high_intensity != null &&
                     Number(simulationResult.results.variables.area_sim) > 0 && (
                      <tr>
                        <td className="sim-table-label">High Intensity Fraction</td>
                        <td className="sim-table-value">
                          {(Number(simulationResult.results.variables.area_high_intensity) / Number(simulationResult.results.variables.area_sim) * 100).toFixed(1)}%
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}

            {/* Impacted roads table */}
            {simulationResult.results?.roads?.json && (() => {
              const roadsGeoJson = normaliseRoadsGeoJson(typeof simulationResult.results.roads.json === 'string'
                ? JSON.parse(simulationResult.results.roads.json)
                : simulationResult.results.roads.json);
              if (!roadsGeoJson?.features?.length) return null;
              const roadRows = roadsGeoJson.features
                .map(f => {
                  const p = f.properties || {};
                  if (p.obsdateepoch == null) return null;
                  const name = p.name || p.road_name || p.NAME || p.ROAD_NAME || 'Unknown Road';
                  const impactTime = Number(p.obsdateepoch);
                  const durationSeconds = getRoadDurationSeconds(p);
                  return Number.isFinite(impactTime) ? { name, impactTime, durationSeconds } : null;
                })
                .filter(Boolean)
                .sort((a, b) => a.impactTime - b.impactTime);
              return (
                <div className="sim-roads-table">
                  <div className="detail-section-title">🛣️ Impacted Roads{roadRows.length ? ` (${roadRows.length})` : ''}</div>
                  {roadRows.length === 0 ? (
                    <div className="sim-roads-empty">No roads impacted</div>
                  ) : (
                    <div className="sim-roads-scroll">
                      <table className="sim-table">
                        <thead>
                          <tr>
                            <th>Road</th>
                            <th>Impact Time</th>
                            <th>Duration (s)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {roadRows.slice(0, 50).map((r, i) => (
                            <tr key={i}>
                              <td>{r.name}</td>
                              <td className="font-mono">{fmtEpoch(r.impactTime)}</td>
                              <td className="font-mono">{r.durationSeconds != null ? Math.round(r.durationSeconds) : '—'}</td>
                            </tr>
                          ))}
                          {roadRows.length > 50 && (
                            <tr><td colSpan={3} className="text-muted text-sm">...and {roadRows.length - 50} more</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Layer toggles */}
            <div className="sim-layers-info">
              <div className="detail-section-title">🗺️ Map Layers</div>
              <div
                className={`sim-layer-toggle ${activeSimLayers?.ignition ? 'active' : ''}`}
                onClick={() => onToggleSimLayer('ignition')}
              >
                <span className="sim-layer-dot" style={{ background: '#ff0000' }} />
                <span className="sim-layer-label">Ignition Point</span>
                <span className="sim-toggle-switch">{activeSimLayers?.ignition ? 'ON' : 'OFF'}</span>
              </div>
              {simulationResult.results?.isochrones?.json && (
                <div
                  className={`sim-layer-toggle ${activeSimLayers?.isochrones ? 'active' : ''}`}
                  onClick={() => onToggleSimLayer('isochrones')}
                >
                  <span className="sim-layer-dot" style={{ background: '#dd513a' }} />
                  <span className="sim-layer-label">Fire Isochrones (spread contours)</span>
                  <span className="sim-toggle-switch">{activeSimLayers?.isochrones ? 'ON' : 'OFF'}</span>
                </div>
              )}
              {simulationResult.results?.roads?.json && (
                <div
                  className={`sim-layer-toggle ${activeSimLayers?.roads ? 'active' : ''}`}
                  onClick={() => onToggleSimLayer('roads')}
                >
                  <span className="sim-layer-dot" style={{ background: '#38bdf8' }} />
                  <span className="sim-layer-label">Impacted Roads</span>
                  <span className="sim-toggle-switch">{activeSimLayers?.roads ? 'ON' : 'OFF'}</span>
                </div>
              )}
              {simulationResult.results?.min_arrival_time?.b64 && (
                <div
                  className={`sim-layer-toggle ${activeSimLayers?.arrival_time ? 'active' : ''}`}
                  onClick={() => onToggleSimLayer('arrival_time')}
                >
                  <span className="sim-layer-dot" style={{ background: '#60a5fa' }} />
                  <span className="sim-layer-label">Min Arrival Time (raster)</span>
                  <span className="sim-toggle-switch">{activeSimLayers?.arrival_time ? 'ON' : 'OFF'}</span>
                </div>
              )}
              {simulationResult.results?.max_intensity?.b64 && (
                <div
                  className={`sim-layer-toggle ${activeSimLayers?.intensity ? 'active' : ''}`}
                  onClick={() => onToggleSimLayer('intensity')}
                >
                  <span className="sim-layer-dot" style={{ background: '#f472b6' }} />
                  <span className="sim-layer-label">Max Intensity (raster)</span>
                  <span className="sim-toggle-switch">{activeSimLayers?.intensity ? 'ON' : 'OFF'}</span>
                </div>
              )}
              <div className="sim-layer-hint">Raster layers may appear blurry.</div>
            </div>

            <div className="sim-actions">
              <button className="sim-clear-btn" onClick={handleDownloadSimulationResult} disabled={downloadStatus === 'downloading'}>
                {downloadStatus === 'downloading' ? '↓ Downloading...' : downloadStatus === 'success' ? '✓ Downloaded' : downloadStatus === 'error' ? '✗ Failed' : '⬇ Download Result'}
              </button>
              <button className="sim-clear-btn" onClick={onClearSimulation}>
                Clear Results
              </button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* ================================================================
   SimulationLegend — shown on the map when simulation results are active
   ================================================================ */

const SIMULATION_LAYER_LABELS = {
  isochrones: 'Fire spread',
  roads: 'Roads',
  min_arrival_time: 'Arrival time',
  max_intensity: 'Intensity',
};

export function SimulationLegend({ simulationResult, activeSimLayers, title = 'Fire Simulation', loadState }) {
  if (!simulationResult) return null;

  const pendingLabels = (loadState?.pendingKeys || []).map((key) => SIMULATION_LAYER_LABELS[key] || key);
  const failedLabels = (loadState?.failedKeys || []).map((key) => SIMULATION_LAYER_LABELS[key] || key);

  return (
    <div className="map-legend sim-legend-box">
      <div className="map-legend-title">🔥 {title}</div>
      {pendingLabels.length > 0 && (
        <div className="map-legend-status">Updating: {pendingLabels.join(', ')}</div>
      )}
      {failedLabels.length > 0 && (
        <div className="map-legend-status muted">Unavailable: {failedLabels.join(', ')}</div>
      )}
      {activeSimLayers?.roads && (
        <>
          <div className="map-legend-subtitle">Roads</div>
          <div className="map-legend-roads-row">
            <span className="map-legend-swatch" style={{ background: '#ef4444' }} />
            <span>Impacted</span>
            <span className="map-legend-swatch" style={{ background: '#666' }} />
            <span>Not impacted</span>
          </div>
        </>
      )}
      {activeSimLayers?.isochrones && (
        <>
          <div className="map-legend-subtitle">Isochrones (Fire Spread)</div>
          <div className="sim-legend-gradient">
            <div className="sim-legend-gradient-bar" />
            <div className="sim-legend-gradient-labels">
              <span>Early</span>
              <span>Late</span>
            </div>
          </div>
        </>
      )}
      {activeSimLayers?.arrival_time && (
        <>
          <div className="map-legend-subtitle">Arrival Time</div>
          <div className="sim-legend-gradient">
            <div className="sim-legend-gradient-bar viridis" />
            <div className="sim-legend-gradient-labels">
              <span>Early</span>
              <span>Late</span>
            </div>
          </div>
        </>
      )}
      {activeSimLayers?.intensity && (
        <>
          <div className="map-legend-subtitle">Max Intensity</div>
          <div className="sim-legend-gradient">
            <div className="sim-legend-gradient-bar inferno-palette" />
            <div className="sim-legend-gradient-labels">
              <span>Low</span>
              <span>High</span>
            </div>
          </div>
        </>
      )}
      {activeSimLayers?.ignition && (
        <>
          <div className="map-legend-subtitle">Ignition Point</div>
          <div className="map-legend-roads-row">
            <span className="map-legend-swatch" style={{ background: '#ff0000', borderRadius: '50%', border: '2px solid #fff' }} />
            <span>Detection origin</span>
          </div>
        </>
      )}
      <div className="map-legend-note">Source: Inferno v2</div>
    </div>
  );
}
