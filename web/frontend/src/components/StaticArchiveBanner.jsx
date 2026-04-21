const ARCHIVE_REPORT_DATE = import.meta.env.VITE_ARCHIVE_REPORT_DATE || '2026-04-09';

export default function StaticArchiveBanner() {
  return (
    <div className="static-archive-banner" role="note" aria-label="Static archive notice">
      <strong>Static archive</strong>
      <span>
        {' '}— Static version of Team Redback site for XPRIZE Wildfire Track B final competition
        held in NSW from 7 to 20 April 2026. Frozen snapshot of competition day{' '}
        <strong>{ARCHIVE_REPORT_DATE}</strong>. Live satellite polling, on-demand Inferno fire
        simulation, and custom bundle download are disabled. Mapbox basemap, archived fire
        events, historical hotspots, pre-computed simulations, NSW LGA overlays, layer toggles,
        and map-driven navigation remain interactive. Contact:{' '}
        <a href="mailto:simon.jones@rmit.edu.au">simon.jones@rmit.edu.au</a>.
      </span>
    </div>
  );
}
