export const HOTSPOT_OBSERVATION_THRESHOLD_MINUTES = 10;
export const HOTSPOT_OBSERVATION_THRESHOLD_MS = HOTSPOT_OBSERVATION_THRESHOLD_MINUTES * 60 * 1000;

export const HOTSPOT_ACTIVE_COLOR = '#ff3333';
export const HOTSPOT_OLD_COLOR = '#8b9098';

export const HOTSPOT_PRODUCT_SHAPES = {
  bright_s3: 'circle',
  bright_ahi: 'triangle',
};

export function getHotspotObservationTime(props = {}) {
  return props.datetime ?? props.dt ?? props.hotspot_datetime ?? null;
}

export function isHotspotOlderThanThreshold(props = {}, now = Date.now()) {
  const observationTime = getHotspotObservationTime(props);
  if (!observationTime) return false;

  const timestamp = new Date(observationTime).getTime();
  if (Number.isNaN(timestamp)) return false;

  return now - timestamp > HOTSPOT_OBSERVATION_THRESHOLD_MS;
}

export function getHotspotAgeColor(props = {}, now = Date.now()) {
  return isHotspotOlderThanThreshold(props, now) ? HOTSPOT_OLD_COLOR : HOTSPOT_ACTIVE_COLOR;
}

export function getHotspotMarkerShape(productId) {
  return HOTSPOT_PRODUCT_SHAPES[productId] || 'circle';
}

export function getHotspotMarkerIconName(props = {}, now = Date.now(), prefix = 'hotspot-triangle') {
  return `${prefix}-${isHotspotOlderThanThreshold(props, now) ? 'grey' : 'red'}`;
}