function parseImpactEpoch(value) {
  if (value === undefined || value === null || value === '') return null;

  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric > 1e12 ? Math.round(numeric / 1000) : Math.round(numeric);
  }

  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) return null;
  return Math.round(parsed / 1000);
}

export function getRoadImpactEpoch(props = {}) {
  const candidates = [
    props.obsdateepoch,
    props.time,
    props.impact_time,
    props.arrival_time,
    props.min_arrival_time,
    props.time_of_impact,
    props.impacttime,
    props.arrival,
    props.eta,
  ];

  for (const candidate of candidates) {
    const epoch = parseImpactEpoch(candidate);
    if (epoch != null) return epoch;
  }

  return null;
}

export function normaliseRoadsGeoJson(roadsGeoJson) {
  if (!roadsGeoJson?.features?.length) return roadsGeoJson;

  return {
    ...roadsGeoJson,
    features: roadsGeoJson.features.map((feature) => {
      const properties = { ...(feature.properties || {}) };
      const obsdateepoch = getRoadImpactEpoch(properties);
      properties.obsdateepoch = obsdateepoch;
      if (obsdateepoch != null) {
        properties.impacted = true;
      }
      return {
        ...feature,
        properties,
      };
    }),
  };
}