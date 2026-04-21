import { useState, useEffect, useRef, useCallback } from 'react';
import * as api from '../api';
import { startPoll, stopPoll } from '../utils/poll';

/**
 * Hook: poll pipeline status every `interval` ms.
 */
export function useStatus(interval = 30000) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  const fetchStatus = useCallback(async () => {
    try {
      const data = await api.getStatus();
      setStatus(data);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const id = startPoll(fetchStatus, interval);
    return () => stopPoll(id);
  }, [fetchStatus, interval]);

  return { status, error, refresh: fetchStatus };
}

/**
 * Hook: load fire events, re-fetch on `refreshKey` change.
 * Supports optional runDir or reportDate for historical sources.
 */
export function useFireEvents(refreshKey, { runDir = null, reportDate = null, enabled = true } = {}) {
  const [events, setEvents] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) {
      setEvents(null);
      setError(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    api.getFireEvents(runDir, reportDate)
      .then(data => {
        if (!cancelled) {
          setEvents(data);
          setError(null);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('Events fetch failed:', err);
          setError(err);
          setEvents(null);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, runDir, reportDate, enabled]);

  return { events, loading, error };
}

/**
 * Hook: load hotspots, re-fetch on filters change.
 * Supports optional runDir or reportDate for historical sources.
 */
export function useHotspots(refreshKey, filters = {}) {
  const [hotspots, setHotspots] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const enabled = filters.enabled ?? true;

  useEffect(() => {
    if (!enabled) {
      setHotspots(null);
      setError(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    api.getHotspots(filters)
      .then(data => {
        if (!cancelled) {
          setHotspots(data);
          setError(null);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('Hotspots fetch failed:', err);
          setError(err);
          setHotspots(null);
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, filters.eventId, filters.timeMin, filters.timeMax, filters.runDir, filters.reportDate, enabled]);

  return { hotspots, loading, error };
}

/**
 * Hook: load time range.
 */
export function useTimeRange(refreshKey, { runDir = null, reportDate = null, enabled = true } = {}) {
  const [range, setRange] = useState({ min: null, max: null });
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) {
      setRange({ min: null, max: null });
      setError(null);
      return undefined;
    }

    api.getTimeRange(runDir, reportDate)
      .then(data => {
        setRange(data);
        setError(null);
      })
      .catch(err => {
        console.error('TimeRange fetch failed:', err);
        setError(err);
        setRange({ min: null, max: null });
      });
  }, [refreshKey, runDir, reportDate, enabled]);

  return { ...range, error };
}

/**
 * Hook: poll for data updates.
 * Returns a refreshKey that increments every `interval` ms.
 */
export function usePolling(interval = 30000) {
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const id = startPoll(() => setRefreshKey(k => k + 1), interval);
    return () => stopPoll(id);
  }, [interval]);

  return refreshKey;
}

/**
 * Hook: load available published report dates for historical day picker.
 */
export function useHistoricalDates(refreshKey, enabled = true) {
  const [dates, setDates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) {
      setDates([]);
      setError(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    api.getHistoricalDates()
      .then(data => {
        if (!cancelled) {
          setDates(data.dates || []);
          setError(null);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('Historical dates fetch failed:', err);
          setDates([]);
          setError(err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshKey, enabled]);

  return { dates, loading, error };
}

/**
 * Hook: load selected-day metadata for the S3 historical bundle.
 */
export function useHistoricalDay(refreshKey, reportDate = null, enabled = true) {
  const [day, setDay] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) {
      setDay(null);
      setError(null);
      setLoading(false);
      return undefined;
    }

    let cancelled = false;
    setLoading(true);
    api.getHistoricalDay(reportDate)
      .then(data => {
        if (!cancelled) {
          setDay(data);
          setError(null);
        }
      })
      .catch(err => {
        if (!cancelled) {
          console.error('Historical day fetch failed:', err);
          setError(err);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshKey, reportDate, enabled]);

  return { day, loading, error };
}

/**
 * Hook: load available real-time products (satellite toggles).
 */
export function useRealtimeProducts() {
  const [products, setProducts] = useState([]);

  useEffect(() => {
    api.getRealtimeProducts()
      .then(data => setProducts(data.products || []))
      .catch(err => console.error('Products fetch failed:', err));
  }, []);

  return products;
}

/**
 * Hook: fetch real-time superclusters / fire events from S3.
 */
export function useRealtimeEvents(refreshKey, startUtc = null, endUtc = null) {
  const [events, setEvents] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getRealtimeEvents(startUtc, endUtc)
      .then(data => {
        if (!cancelled) {
          setEvents(data);
          setMetadata(data.metadata || null);
        }
      })
      .catch(err => {
        if (!cancelled) console.error('RT events fetch failed:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshKey, startUtc, endUtc]);

  return { events, metadata, loading };
}

/**
 * Hook: fetch real-time ignition points from S3.
 */
export function useRealtimeIgnitions(refreshKey, startUtc = null, endUtc = null) {
  const [ignitions, setIgnitions] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getRealtimeIgnitions(startUtc, endUtc)
      .then(data => {
        if (!cancelled) {
          setIgnitions(data);
          setMetadata(data.metadata || null);
        }
      })
      .catch(err => {
        if (!cancelled) console.error('RT ignitions fetch failed:', err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [refreshKey, startUtc, endUtc]);

  return { ignitions, metadata, loading };
}

/**
 * Hook: fetch real-time hotspots with product filters.
 * Polls every `interval` ms (default 30s).
 */
export function useRealtimeHotspots(refreshKey, activeProducts = ['bright_ahi'], asPolygons = false, hours = 12) {
  const [hotspots, setHotspots] = useState(null);
  const [metadata, setMetadata] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (activeProducts.length === 0) {
      setHotspots({ type: 'FeatureCollection', features: [] });
      setMetadata({ product_counts: {}, total: 0 });
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    api.getRealtimeHotspots(activeProducts, asPolygons, hours)
      .then(data => {
        if (!cancelled) {
          setHotspots(data);
          setMetadata(data.metadata || null);
        }
      })
      .catch(err => { if (!cancelled) console.error('RT hotspots fetch failed:', err); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey, activeProducts.join(','), asPolygons, hours]);

  return { hotspots, metadata, loading };
}

/**
 * Hook: fetch real-time status (XPRIZE day info, UTC/AEST times).
 */
export function useRealtimeStatus(interval = 10000) {
  const [rtStatus, setRtStatus] = useState(null);

  useEffect(() => {
    const fetch = () => {
      api.getRealtimeStatus()
        .then(setRtStatus)
        .catch(err => console.error('RT status fetch failed:', err));
    };
    fetch();
    const id = startPoll(fetch, interval);
    return () => stopPoll(id);
  }, [interval]);

  return rtStatus;
}

/**
 * Hook: fetch available DEA WMS overlay layers (fire intelligence).
 * Refreshes every hour to pick up new FMC dates.
 */
export function useDeaLayers() {
  const [deaLayers, setDeaLayers] = useState(null);

  useEffect(() => {
    const fetchLayers = () => {
      api.getDeaLayers()
        .then(data => setDeaLayers(data))
        .catch(err => console.error('DEA layers fetch failed:', err));
    };
    fetchLayers();
    // Refresh every hour to pick up new FMC dates
    const id = startPoll(fetchLayers, 3600000);
    return () => stopPoll(id);
  }, []);

  return deaLayers;
}

export function useDeaCacheStats(interval = 15000) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    const fetchStats = () => {
      api.getDeaCacheStats()
        .then(setStats)
        .catch(err => console.error('DEA cache stats fetch failed:', err));
    };

    fetchStats();
    const id = startPoll(fetchStats, interval);
    return () => stopPoll(id);
  }, [interval]);

  return stats;
}

export function useSavedSimulationRuns(refreshKey, params = {}) {
  const [payload, setPayload] = useState({ runs: [], diagnostics: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const hasExistingRuns = Boolean(payload.runs?.length);
    if (hasExistingRuns) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    api.getSavedSimulationRuns(params)
      .then((data) => {
        if (!cancelled) {
          setPayload(data);
          setLoading(false);
          setRefreshing(false);
        }
      })
      .catch((err) => {
        console.error('Saved simulation run fetch failed:', err);
        if (!cancelled) {
          setPayload(prev => ({
            runs: prev.runs || [],
            diagnostics: { ...(prev.diagnostics || {}), error: err.message },
          }));
          setLoading(false);
          setRefreshing(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [refreshKey, JSON.stringify(params)]);

  return { runs: payload.runs || [], diagnostics: payload.diagnostics, loading, refreshing };
}

/**
 * Hook: fetch NSW LGA boundary GeoJSON (once).
 */
export function useLgaBoundaries() {
  const [lgaData, setLgaData] = useState(null);

  useEffect(() => {
    api.getLgaBoundaries()
      .then(data => setLgaData(data))
      .catch(err => console.error('LGA fetch failed:', err));
  }, []);

  return lgaData;
}

/**
 * Hook: fetch national bushfire extents (NRT) filtered to NSW.
 * Refreshes every 15 minutes.
 */
export function useBushfireExtents(enabled = false) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    const fetchData = () => {
      api.getBushfireExtents()
        .then(result => { if (!cancelled) { setData(result); setLoading(false); } })
        .catch(err => { if (!cancelled) { console.error('Bushfire extents fetch failed:', err); setLoading(false); } });
    };
    fetchData();
    const id = startPoll(fetchData, 900000);
    return () => { cancelled = true; stopPoll(id); };
  }, [enabled]);

  return { data, loading };
}

/**
 * Hook: fetch RFS facilities filtered to NSW.
 * Fetches once when enabled, cached server-side.
 */
export function useRfsFacilities(enabled = false) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    api.getRfsFacilities()
      .then(result => { if (!cancelled) { setData(result); setLoading(false); } })
      .catch(err => { if (!cancelled) { console.error('RFS facilities fetch failed:', err); setLoading(false); } });
    return () => { cancelled = true; };
  }, [enabled]);

  return { data, loading };
}

/**
 * Hook: fetch NPWS fire history polygons for a selected fire season.
 * Refreshes every 15 minutes while enabled.
 */
export function useNpwsFireHistory(enabled = false, fireYear = 202526) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setLoading(true);
    setError(null);

    const fetchData = () => {
      api.getNpwsFireHistory(fireYear)
        .then(result => {
          if (!cancelled) {
            setData(result);
            setLoading(false);
            setError(null);
          }
        })
        .catch(err => {
          if (!cancelled) {
            console.error('NPWS fire history fetch failed:', err);
            setLoading(false);
            setError(err);
          }
        });
    };

    fetchData();
    const id = startPoll(fetchData, 900000);
    return () => {
      cancelled = true;
      stopPoll(id);
    };
  }, [enabled, fireYear]);

  return { data, loading, error };
}

/**
 * Hook: fetch saved simulation runs linked to a given supercluster or hotspot.
 * Queries by stable_id first (catches all sims for the fire event); falls back
 * to hotspot_id when no stable_id is available.
 * Re-fetches when the IDs change, cancels stale requests automatically.
 */
export function useLinkedSimulations(stableId, hotspotId) {
  const [simulations, setSimulations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const queryKey = stableId || hotspotId;
    if (!queryKey) {
      setSimulations([]);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const params = stableId
      ? { source_supercluster_id: String(stableId) }
      : { source_hotspot_id: String(hotspotId) };

    api.getSavedSimulationRuns(params)
      .then((data) => {
        if (!cancelled) {
          setSimulations(data?.runs || data || []);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Linked simulation fetch failed:', err);
          setError(err.message || 'Failed to load simulations');
          setSimulations([]);
          setLoading(false);
        }
      });

    return () => { cancelled = true; };
  }, [stableId, hotspotId]);

  return { simulations, loading, error };
}
