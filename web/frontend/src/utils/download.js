/**
 * Download utilities for exporting simulation and hotspot data as GeoJSON
 */

/**
 * Format timestamp for filename (YYYYMMDD_HHMMSS)
 */
function formatTimestampForFilename() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${mins}${ss}`;
}

/**
 * Download a GeoJSON object as a file
 * @param {object} geoJson - GeoJSON FeatureCollection or Feature
 * @param {string} filename - Filename without extension (will add .geojson)
 */
export function downloadGeoJSON(geoJson, filename) {
  if (!geoJson) {
    console.warn('downloadGeoJSON: geoJson is null or undefined');
    return;
  }

  const json = typeof geoJson === 'object' ? geoJson : JSON.parse(geoJson);
  const blob = new Blob([JSON.stringify(json, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.geojson`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Extract vector layers from simulation result payload
 * Returns object with extracted layers: { ignition, isochrones, roads }
 */
export function extractSimulationLayers(simulationResult) {
  if (!simulationResult) return { ignition: null, isochrones: null, roads: null };

  const layers = {
    ignition: null,
    isochrones: null,
    roads: null,
  };

  // Ignition point (always singular point)
  if (Number.isFinite(simulationResult.lat) && Number.isFinite(simulationResult.lng)) {
    layers.ignition = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            type: 'Ignition Point',
            datetime: simulationResult.startDateTime || '',
          },
          geometry: {
            type: 'Point',
            coordinates: [simulationResult.lng, simulationResult.lat],
          },
        },
      ],
    };
  }

  // Isochrones (fire spread contours)
  if (simulationResult.results?.isochrones?.json) {
    try {
      const json = typeof simulationResult.results.isochrones.json === 'string'
        ? JSON.parse(simulationResult.results.isochrones.json)
        : simulationResult.results.isochrones.json;
      if (json?.features?.length > 0) {
        layers.isochrones = json;
      }
    } catch (err) {
      console.warn('Failed to parse isochrones:', err);
    }
  }

  // Roads (impacted roads)
  if (simulationResult.results?.roads?.json) {
    try {
      const json = typeof simulationResult.results.roads.json === 'string'
        ? JSON.parse(simulationResult.results.roads.json)
        : simulationResult.results.roads.json;
      if (json?.features?.length > 0) {
        layers.roads = json;
      }
    } catch (err) {
      console.warn('Failed to parse roads:', err);
    }
  }

  return layers;
}

/**
 * Download all available simulation layers as separate GeoJSON files
 * @param {object} simulationResult - Simulation result payload
 * @param {string} runId - Run ID for filename (optional)
 */
export function downloadSimulationResult(simulationResult, runId = null) {
  if (!simulationResult) {
    console.warn('downloadSimulationResult: simulationResult is null');
    return [];
  }

  const timestamp = formatTimestampForFilename();
  const idPart = runId ? `_${runId}` : '';
  const downloadedFiles = [];

  const layers = extractSimulationLayers(simulationResult);

  // Download ignition point
  if (layers.ignition?.features?.length) {
    const filename = `simulation_ignition${idPart}_${timestamp}`;
    downloadGeoJSON(layers.ignition, filename);
    downloadedFiles.push(`${filename}.geojson`);
  }

  // Download isochrones
  if (layers.isochrones?.features?.length) {
    const filename = `simulation_isochrones${idPart}_${timestamp}`;
    downloadGeoJSON(layers.isochrones, filename);
    downloadedFiles.push(`${filename}.geojson`);
  }

  // Download roads
  if (layers.roads?.features?.length) {
    const filename = `simulation_roads${idPart}_${timestamp}`;
    downloadGeoJSON(layers.roads, filename);
    downloadedFiles.push(`${filename}.geojson`);
  }

  return downloadedFiles;
}

/**
 * Download realtime hotspots for a given product
 * @param {object} hotspots - FeatureCollection of hotspots
 * @param {string} product - Product ID (bright_ahi or bright_s3)
 * @param {number} hours - Monitoring window in hours
 */
export function downloadRealtimeHotspots(hotspots, product, hours = 12) {
  if (!hotspots?.features?.length) {
    return null;
  }

  const productLabel = product === 'bright_s3' ? 'bright_s3' : 'bright_ahi';
  const timestamp = formatTimestampForFilename();
  const filename = `hotspots_${productLabel}_${hours}h_${timestamp}`;

  downloadGeoJSON(hotspots, filename);
  return `${filename}.geojson`;
}
