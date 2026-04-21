function getHotspotProp(props = {}, keys = []) {
  for (const key of keys) {
    const value = props?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function parseCompactTimestamp(value) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  const text = String(value).trim();
  if (!text) return null;

  const compactMatch = text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/);
  if (compactMatch) {
    const [, year, month, day, hour, minute, second] = compactMatch;
    return new Date(Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    ));
  }

  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatCompactTimestamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const yy = String(date.getUTCFullYear()).slice(-2);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${yy}${month}${day}${hour}${minute}`;
}

function normalisePixelPart(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return String(Math.trunc(numeric)).padStart(4, '0');
}

export function getSourceHotspotId(props = {}, hotspot = null) {
  const featureId = hotspot?.id;
  return getHotspotProp(props, ['hotspot_id', 'detection_id', 'source_id', 'id', 'uuid', 'fid'])
    || featureId
    || hotspot?.idx
    || 'Unknown';
}

export function getDisplayHotspotId(props = {}, hotspot = null) {
  const sourceId = getSourceHotspotId(props, hotspot);
  const productId = getHotspotProp(props, ['product_id']) || hotspot?.product_id;

  if (productId !== 'bright_s3') return sourceId;

  const compactFromBackend = getHotspotProp(props, ['compact_hotspot_id']);
  if (compactFromBackend) return compactFromBackend;

  const pixelCol = normalisePixelPart(getHotspotProp(props, ['pixel_col', 'pixel_column', 'col', 'x']));
  const pixelRow = normalisePixelPart(getHotspotProp(props, ['pixel_row', 'pixel_line', 'row', 'y']));
  const timestamp = parseCompactTimestamp(getHotspotProp(props, ['datetime', 'dt', 'hotspot_datetime']));
  const compactTime = formatCompactTimestamp(timestamp);

  if (!pixelCol || !pixelRow || !compactTime) return sourceId;

  return `${pixelCol}${pixelRow}_${compactTime}`;
}