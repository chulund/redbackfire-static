// Download helpers for FRP plot: PNG from inline SVG, CSV from points.

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadChartPng(svgEl, filename = 'frp_plot.png', scale = 2) {
  if (!svgEl) return Promise.reject(new Error('No SVG element'));
  const clone = svgEl.cloneNode(true);
  if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const width = Number(svgEl.getAttribute('width')) || svgEl.clientWidth || 800;
  const height = Number(svgEl.getAttribute('height')) || svgEl.clientHeight || 400;
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  const xml = new XMLSerializer().serializeToString(clone);
  const svgBlob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(svgUrl);
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('Canvas toBlob failed'));
        triggerDownload(blob, filename);
        resolve();
      }, 'image/png');
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(svgUrl);
      reject(err);
    };
    img.src = svgUrl;
  });
}

export function downloadPointsCsv(points, filename = 'frp_points.csv') {
  const header = ['hotspot_id', 'detection_time_utc', 'frp_mw', 'source', 'lat', 'lng'];
  const lines = [header.join(',')];
  for (const p of points) {
    const row = [
      csvEscape(p.hotspot_id),
      p.detection_time instanceof Date ? p.detection_time.toISOString() : String(p.detection_time ?? ''),
      p.frp_mw != null ? String(p.frp_mw) : '',
      csvEscape(p.source),
      Number.isFinite(p.lat) ? p.lat.toFixed(6) : '',
      Number.isFinite(p.lng) ? p.lng.toFixed(6) : '',
    ];
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  triggerDownload(blob, filename);
}

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
