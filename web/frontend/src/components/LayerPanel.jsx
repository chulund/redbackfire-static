import { useEffect, useMemo, useState } from 'react';

const BASEMAPS = [
  { id: 'satellite', label: 'Satellite', style: 'mapbox://styles/mapbox/satellite-streets-v12' },
  { id: 'dark', label: 'Dark', style: 'mapbox://styles/mapbox/dark-v11' },
  { id: 'topographic', label: 'Topographic', style: 'mapbox://styles/mapbox/outdoors-v12' },
  { id: 'streets', label: 'Streets', style: 'mapbox://styles/mapbox/streets-v12' },
];

const SENSOR_ORDER = ['AHI'];

const OVERLAY_ICONS = {
  fmc: '🔥',
  fractional_cover: '🌿',
  water_observations: '💧',
  land_cover: '🗺',
  lga: '🏛',
  npws_fire_history: '🔥',
  bushfire_extents: '🗺',
  rfs_facilities: '🚒',
};

const SAVED_SIMULATION_LAYER_OPTIONS = [
  { key: 'ignition', label: 'Ignition Point' },
  { key: 'isochrones', label: 'Isochrones' },
  { key: 'roads', label: 'Impacted Roads' },
  { key: 'arrival_time', label: 'Arrival Time' },
  { key: 'intensity', label: 'Max Intensity' },
];

// Historical bundles never carry arrival_time / intensity rasters, so the
// historical layer panel hides those toggles to stop users enabling layers
// that can never load.
const HISTORICAL_SIMULATION_LAYER_OPTIONS = [
  { key: 'ignition', label: 'Ignition Point' },
  { key: 'isochrones', label: 'Isochrones' },
  { key: 'roads', label: 'Impacted Roads' },
];

function LegendGlyph({ type }) {
  if (type === 'supercluster') {
    return <span className="layer-legend-glyph layer-legend-glyph-supercluster" aria-hidden="true" />;
  }
  if (type === 'ignition') {
    return (
      <span className="layer-legend-glyph layer-legend-glyph-ignition" aria-hidden="true">
        <span className="layer-legend-glyph-ignition-core" />
      </span>
    );
  }
  if (type === 'lga') {
    return <span className="layer-legend-glyph layer-legend-glyph-lga" aria-hidden="true" />;
  }
  if (type === 'bushfire') {
    return <span className="layer-legend-glyph layer-legend-glyph-bushfire" aria-hidden="true" />;
  }
  if (type === 'rfs') {
    return <span className="layer-legend-glyph layer-legend-glyph-rfs" aria-hidden="true" />;
  }
  if (type === 'npws') {
    return <span className="layer-legend-glyph layer-legend-glyph-npws" aria-hidden="true" />;
  }
  return null;
}

function getLgaLabel(feature) {
  const props = feature?.properties || {};
  return props.abb_name || props.LGA_NAME || props.lga_name || props.name || props.NAME || null;
}

function OverlayStatusIndicator({ isLoading, errorMessage, isActive }) {
  if (!isActive) return null;
  if (isLoading) return <span className="layer-inline-loader">Loading…</span>;

  const isError = Boolean(errorMessage);
  return (
    <span className={`overlay-status-indicator ${isError ? 'error' : ''}`}>
      <span className="overlay-status-indicator-icon" aria-hidden="true">{isError ? '●' : '✓'}</span>
      <span className="overlay-status-indicator-bubble">{isError ? errorMessage : ''}</span>
    </span>
  );
}

function HelpModal({ open, onClose }) {
  if (!open) return null;

  return (
    <div className="layer-modal-backdrop" onClick={onClose}>
      <div
        className="layer-modal"
        role="dialog"
        aria-modal="true"
        aria-label="About this data"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="layer-modal-header">
          <h3>About This Data</h3>
          <button className="sidebar-close-btn" onClick={onClose} aria-label="Close help panel">×</button>
        </div>
        <div className="layer-modal-body">
          <section>
            <h4>What are hotspots?</h4>
            <p>Hotspots are thermal anomalies detected from satellite observations. They are useful operational screening signals, but they are not ground confirmation on their own.</p>
          </section>
          <section>
            <h4>Algorithm and source</h4>
            <p>BRIGHT detections come from Himawari-9 AHI at 10-minute cadence. The dashboard combines live BRIGHT 2.0 outputs from Lightsail S3 with BRIGHT 1.86 detections from the DEA hotspot service.</p>
            <p><a href="https://doi.org/10.3390/rs14112540" target="_blank" rel="noreferrer">BRIGHT FRP paper</a></p>
            <p><a href="https://hotspots.dea.ga.gov.au/" target="_blank" rel="noreferrer">DEA Hotspots</a></p>
          </section>
          <section>
            <h4>Versions</h4>
            <p>BRIGHT 2.0 is the live operational feed. BRIGHT 1.86 from DEA WFS remains available as corroborative context.</p>
          </section>
          <section>
            <h4>Fire Complexes</h4>
            <p>Fire complexes group nearby hotspots in space and time using ST-DBSCAN-style clustering so persistent fire activity can be assessed as one event rather than many raw points.</p>
          </section>
          <section>
            <h4>Ignition points</h4>
            <p>Ignition points represent the earliest mapped hotspot associated with each live fire complex.</p>
          </section>
          <section>
            <h4>Caveats</h4>
            <ul>
              <li>Latency is about 17 minutes at best for Himawari-derived hotspot delivery.</li>
              <li>Spatial resolution is about 2 km at nadir, so small fires may not be detected.</li>
              <li>False positives can occur from non-fire heat sources.</li>
              <li>False negatives can occur when fires are small, cool, or obscured.</li>
              <li>This dashboard is not for life-safety decisions.</li>
              <li>DEA access and support: earth.observation@ga.gov.au</li>
            </ul>
          </section>
        </div>
      </div>
    </div>
  );
}

export default function LayerPanel({
  open, onClose, layers, onToggleLayer, status,
  mode, allProducts, activeProducts, onToggleProduct, onToggleProductGroup,
  showAsPolygons, onTogglePolygons, polygonLoading, rtLoading, rtEventLoading, rtIgnitionLoading, productColors, rtMetadata,
  rtEventMetadata,
  deaLayerConfig, deaCacheStats, activeOverlays, overlayLoadingState, overlayErrorState, onToggleOverlay,
  lgaData, showLga, onToggleLga, onFlyToLga,
  activeSimLayers, onToggleSimLayer,
  showBushfireExtents, onToggleBushfireExtents, bushfireExtentsLoading,
  showRfsFacilities, onToggleRfsFacilities, rfsFacilitiesLoading,
  historicalMetadata,
}) {
  const [sectionsOpen, setSectionsOpen] = useState({
    basemap: false,
    clusters: false,
    savedSimulations: false,
    fires: false,
    products: true,
    weather: false,
    overlays: false,
  });
  const [infoOpen, setInfoOpen] = useState(false);
  const [lgaQuery, setLgaQuery] = useState('');

  useEffect(() => {
    if (!infoOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setInfoOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [infoOpen]);

  useEffect(() => {
    if (mode !== 'historical') return;
    setSectionsOpen(prev => ({
      ...prev,
      fires: true,
      savedSimulations: true,
    }));
  }, [mode]);

  const toggleSection = (key) => {
    setSectionsOpen(prev => ({ ...prev, [key]: !prev[key] }));
  };

  // Group products by sensor
  const groupedProducts = useMemo(() => {
    if (!allProducts || allProducts.length === 0) return [];
    const groups = {};
    for (const p of allProducts) {
      const g = p.group || p.sensor || 'Other';
      if (!groups[g]) groups[g] = [];
      groups[g].push(p);
    }
    // Sort by SENSOR_ORDER
    return SENSOR_ORDER
      .filter(s => groups[s])
      .map(s => ({ sensor: s, products: groups[s] }))
      .concat(
        Object.keys(groups)
          .filter(s => !SENSOR_ORDER.includes(s))
          .map(s => ({ sensor: s, products: groups[s] }))
      );
  }, [allProducts]);

  const matchingLgas = useMemo(() => {
    const query = lgaQuery.trim().toLowerCase();
    if (!query || !lgaData?.features?.length) return [];
    return lgaData.features
      .map(feature => ({ feature, label: getLgaLabel(feature) }))
      .filter(item => item.label && item.label.toLowerCase().includes(query))
      .slice(0, 8);
  }, [lgaData, lgaQuery]);

  return (
    <>
      <aside className={`layer-panel ${open ? '' : 'collapsed'}`}>
        <div className="layer-panel-header">
          <span>Layers</span>
          <div className="layer-panel-header-actions">
            <button
              className="layer-panel-info-btn"
              onClick={() => setInfoOpen(true)}
              title="About this data"
              aria-label="Open data help"
            >
              ?
            </button>
            <button className="sidebar-close-btn" onClick={onClose} title="Close layers">×</button>
          </div>
        </div>

      {/* Basemap section */}
      <div className="layer-section">
        <button type="button" className="layer-section-header" aria-expanded={sectionsOpen.basemap} onClick={() => toggleSection('basemap')}>
          <span>🗺️ Background map</span>
          <span aria-hidden="true">{sectionsOpen.basemap ? '▾' : '▸'}</span>
        </button>
        {sectionsOpen.basemap && (
          <div className="layer-section-body basemap-options">
            {BASEMAPS.map(bm => (
              <label key={bm.id} className="layer-toggle">
                <input
                  type="radio"
                  name="basemap"
                  checked={layers.basemap === bm.id}
                  onChange={() => onToggleLayer('basemap', bm.id)}
                />
                {bm.label}
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Weather section — removed in static archive build (OpenWeather dependency dropped) */}

        {/* Data Overlays section */}
        <div className="layer-section">
          <button type="button" className="layer-section-header" aria-expanded={sectionsOpen.overlays} onClick={() => toggleSection('overlays')}>
            <span>📡 Data Overlays</span>
            <span aria-hidden="true">{sectionsOpen.overlays ? '▾' : '▸'}</span>
          </button>
          {sectionsOpen.overlays && (
            <div className="layer-section-body">
              {deaLayerConfig?.layers ? (
                <>
                  {(() => {
                    const groups = {};
                    for (const l of deaLayerConfig.layers) {
                      const g = l.group || 'Other';
                      if (!groups[g]) groups[g] = [];
                      groups[g].push(l);
                    }
                    if (!groups.Administrative) groups.Administrative = [];
                    groups.Administrative.push({
                      id: 'lga',
                      label: 'NSW LGA Boundaries',
                      description: 'Administrative boundaries and labels for New South Wales LGAs.',
                      group: 'Administrative',
                      source: 'Local administrative boundary',
                    });
                    if (!groups['Fire Intelligence']) groups['Fire Intelligence'] = [];
                    groups['Fire Intelligence'].push({
                      id: 'bushfire_extents',
                      label: 'NSW Bushfire Extents (Real Time)',
                      description: 'Historical bushfire extent polygons for NSW from the National Bushfire Extents dataset.',
                      group: 'Fire Intelligence',
                      source: 'Geoscience Australia',
                    });
                    if (!groups['Fire Fighting Resources']) groups['Fire Fighting Resources'] = [];
                    groups['Fire Fighting Resources'].push({
                      id: 'rfs_facilities',
                      label: 'RFS Facilities',
                      description: 'NSW Rural Fire Service station locations.',
                      group: 'Fire Fighting Resources',
                      source: 'Geoscience Australia',
                    });
                    return Object.entries(groups).map(([groupName, groupLayers]) => (
                      <div key={groupName} className="overlay-group">
                        <div className="overlay-group-label">{groupName}</div>
                        {groupLayers.map(l => {
                          const icon = OVERLAY_ICONS[l.id] || '📊';
                          const isAdministrative = l.id === 'lga';
                          const isNpwsFireHistory = l.id === 'npws_fire_history';
                          const isBushfireExtents = l.id === 'bushfire_extents';
                          const isRfsFacilities = l.id === 'rfs_facilities';
                          const isExternalVector = isAdministrative || isBushfireExtents || isRfsFacilities;
                          const isActive = isAdministrative ? showLga
                            : isBushfireExtents ? showBushfireExtents
                            : isRfsFacilities ? showRfsFacilities
                            : activeOverlays?.includes(l.id);
                          const isLoading = isBushfireExtents ? bushfireExtentsLoading
                            : isRfsFacilities ? rfsFacilitiesLoading
                            : !isExternalVector ? overlayLoadingState?.[l.id] : false;
                          const errorMessage = !isExternalVector ? overlayErrorState?.[l.id] : null;
                          const handleToggle = () => {
                            if (isAdministrative) onToggleLga();
                            else if (isBushfireExtents) onToggleBushfireExtents();
                            else if (isRfsFacilities) onToggleRfsFacilities();
                            else onToggleOverlay(l.id);
                          };
                          return (
                            <div key={l.id} className="overlay-item-wrap">
                              <label className="layer-toggle overlay-toggle" title={l.description}>
                                <input
                                  type="checkbox"
                                  checked={isActive}
                                  onChange={handleToggle}
                                />
                                <span className="overlay-icon">{icon}</span>
                                <span className="overlay-label">{l.label}</span>
                                <OverlayStatusIndicator isLoading={isLoading} errorMessage={errorMessage} isActive={isActive} />
                              </label>
                              {isAdministrative && (
                                <div className="overlay-legend-note">
                                  <LegendGlyph type="lga" />
                                  <span>Local Government Area boundary</span>
                                </div>
                              )}
                              {isNpwsFireHistory && (
                                <div className="overlay-legend-note">
                                  <LegendGlyph type="npws" />
                                  <span>NPWS wildfire and prescribed-burn polygons filtered to the 2025-26 fire season</span>
                                </div>
                              )}
                              {isBushfireExtents && (
                                <div className="overlay-legend-note">
                                  <LegendGlyph type="bushfire" />
                                  <span>National Bushfire Extents (historical fire perimeters)</span>
                                </div>
                              )}
                              {isRfsFacilities && (
                                <div className="overlay-legend-note">
                                  <LegendGlyph type="rfs" />
                                  <span>NSW RFS fire station locations</span>
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ));
                  })()}
                  <div className="layer-subsection lga-search-subsection">
                    <div className="overlay-group-label">LGA Find</div>
                    <input
                      className="lga-search-input"
                      type="text"
                      value={lgaQuery}
                      onChange={(event) => setLgaQuery(event.target.value)}
                      placeholder="Search NSW LGA"
                    />
                    {matchingLgas.length > 0 && (
                      <div className="lga-search-results">
                        {matchingLgas.map(({ feature, label }) => (
                          <button
                            key={`${label}-${feature.id || label}`}
                            type="button"
                            className="lga-search-result"
                            onClick={() => {
                              onFlyToLga?.(feature);
                              setLgaQuery(label);
                            }}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="layer-note">
                    Data clipped to NSW · Layers stack with adjustable opacity
                  </div>
                  {/* {deaCacheStats && (
                    <div className="layer-note">
                      DEA cache: {deaCacheStats.hits || 0} hits · {deaCacheStats.misses || 0} misses · {deaCacheStats.writes || 0} writes
                    </div>
                  )} */}
                </>
              ) : (
                <div className="layer-note">Loading DEA layers...</div>
              )}
            </div>
          )}
        </div>

        {/* Real-time / Simulation: Product toggles grouped by sensor */}
        {(mode === 'realtime' || mode === 'simulation') && (
          <div className="layer-section">
            <button type="button" className="layer-section-header" aria-expanded={sectionsOpen.products} onClick={() => toggleSection('products')}>
              <span>🛰 Hotspot Products {rtLoading ? <span className="layer-inline-loader">Loading…</span> : null}</span>
              <span aria-hidden="true">{sectionsOpen.products ? '▾' : '▸'}</span>
            </button>
            {sectionsOpen.products && (
              <div className="layer-section-body">
                {groupedProducts.map(group => {
                  const groupIds = group.products.map(p => p.id);
                  const allActive = groupIds.every(id => activeProducts.includes(id));
                  const someActive = !allActive && groupIds.some(id => activeProducts.includes(id));
                  return (
                    <div key={group.sensor} className="product-group">
                      {mode === 'simulation' ? (
                        <div className="product-group-label product-group-label-static">{group.sensor}</div>
                      ) : (
                        <label className="product-group-label" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={allActive}
                            ref={el => { if (el) el.indeterminate = someActive; }}
                            onChange={() => onToggleProductGroup(group.sensor)}
                          />
                          {group.sensor}
                        </label>
                      )}
                      {group.products.map(p => {
                        const count = rtMetadata?.product_counts?.[p.id] ?? '—';
                        const color = productColors?.[p.id] || '#ff6b35';
                        return (
                          <label key={p.id} className="layer-toggle product-toggle">
                            <input
                              type={mode === 'simulation' ? 'radio' : 'checkbox'}
                              name={mode === 'simulation' ? 'simulation-product' : undefined}
                              checked={activeProducts.includes(p.id)}
                              onChange={() => onToggleProduct(p.id)}
                            />
                            {/* <span className="product-color-dot" style={{ background: color }} /> */}
                            <span className="product-label">{p.label}</span>
                            {/* <span className="product-count">{count}</span> */}
                          </label>
                        );
                      })}
                    </div>
                  );
                })}

                <div className="layer-subsection">
                  <label className="layer-toggle">
                    <input
                      type="checkbox"
                      checked={showAsPolygons}
                      onChange={(e) => onTogglePolygons(e.target.checked)}
                    />
                    <span>Show hotspot as pixel footprint</span>
                    {polygonLoading && <span className="polygon-loading-spinner" title="Converting to polygons…">⏳</span>}
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {(mode === 'realtime' || mode === 'historical') && (
          <div className="layer-section">
            <button type="button" className="layer-section-header" aria-expanded={sectionsOpen.savedSimulations} onClick={() => toggleSection('savedSimulations')}>
              <span>{mode === 'historical' ? 'Historical Fire Spread Simulations' : '💾 Saved Fire Spread Simulations'}</span>
              <span aria-hidden="true">{sectionsOpen.savedSimulations ? '▾' : '▸'}</span>
            </button>
            {sectionsOpen.savedSimulations && (
              <div className="layer-section-body">
                <label className="layer-toggle cluster-toggle">
                  <input
                    type="checkbox"
                    checked={layers.savedSimulations}
                    onChange={(e) => onToggleLayer('savedSimulations', e.target.checked)}
                  />
                  <span>{mode === 'historical' ? `Historical Simulations (${historicalMetadata?.available_layers?.simulations ?? 0} saved)` : 'Saved Simulations'}</span>
                </label>
                {layers.savedSimulations && (
                  <div className="saved-sim-layer-list">
                    {(mode === 'historical' ? HISTORICAL_SIMULATION_LAYER_OPTIONS : SAVED_SIMULATION_LAYER_OPTIONS).map((layer) => (
                      <label key={layer.key} className="layer-toggle saved-sim-layer-toggle">
                        <input
                          type="checkbox"
                          checked={Boolean(activeSimLayers?.[layer.key])}
                          onChange={(e) => onToggleSimLayer?.(layer.key, e.target.checked)}
                        />
                        <span>{layer.label}</span>
                      </label>
                    ))}
                  </div>
                )}
                <div className="layer-note">
                  {mode === 'historical'
                    ? 'Bundled daily-report simulations render on the historical map using the selected output layers.'
                    : 'Saved runs render on the realtime map using the selected simulation output layers.'}
                </div>
              </div>
            )}
          </div>
        )}

        {mode === 'realtime' && (
          <div className="layer-section">
            <button type="button" className="layer-section-header" aria-expanded={sectionsOpen.clusters} onClick={() => toggleSection('clusters')}>
              <span>{`📦 Live Fire Complex (${rtEventMetadata?.count || 0})`} {(rtEventLoading || rtIgnitionLoading) ? <span className="layer-inline-loader">Loading…</span> : null}</span>
              <span aria-hidden="true">{sectionsOpen.clusters ? '▾' : '▸'}</span>
            </button>
            {sectionsOpen.clusters && (
              <div className="layer-section-body">
                <label className="layer-toggle cluster-toggle">
                  <input
                    type="checkbox"
                    checked={layers.fireEvents}
                    onChange={(e) => onToggleLayer('fireEvents', e.target.checked)}
                  />
                  <LegendGlyph type="supercluster" />
                  <span>Fire complex polygons</span>
                </label>
                <label className="layer-toggle cluster-toggle">
                  <input
                    type="checkbox"
                    checked={layers.ignitions}
                    onChange={(e) => onToggleLayer('ignitions', e.target.checked)}
                  />
                  <LegendGlyph type="ignition" />
                  <span>Ignition points</span>
                </label>
                <div className="layer-note">
                  Live BRIGHT cluster geometry and ignition markers updated with the current monitoring window.
                </div>
              </div>
            )}
          </div>
        )}

        {mode === 'historical' && (
          <div className="layer-section">
            <button type="button" className="layer-section-header" aria-expanded={sectionsOpen.fires} onClick={() => toggleSection('fires')}>
              <span>{`Fires (${historicalMetadata?.available_layers?.events ?? 0} events)`}</span>
              <span aria-hidden="true">{sectionsOpen.fires ? '▾' : '▸'}</span>
            </button>
            {sectionsOpen.fires && (
              <div className="layer-section-body">
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={layers.fireEvents}
                    onChange={(e) => onToggleLayer('fireEvents', e.target.checked)}
                  />
                  Fire event perimeters
                </label>
                <label className="layer-toggle">
                  <input
                    type="checkbox"
                    checked={layers.hotspots}
                    onChange={(e) => onToggleLayer('hotspots', e.target.checked)}
                  />
                  Hotspot footprints + points
                </label>
                <div className="layer-note">
                  Historical layers are loaded from the published daily report bundle in S3.
                </div>
              </div>
            )}
          </div>
        )}
      </aside>
      <HelpModal open={infoOpen} onClose={() => setInfoOpen(false)} />
    </>
  );
}

export { BASEMAPS };
