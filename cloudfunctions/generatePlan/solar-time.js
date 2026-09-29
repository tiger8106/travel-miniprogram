// 通用的 NOAA 近似太阳时刻（北京时间）。地形、天气及景区开放时间仍以公告为准。
function solarEventMinute(dateStr, latitude, longitude, sunset) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  const current = Date.UTC(year, month - 1, day);
  if (new Date(current).toISOString().slice(0, 10) !== dateStr) return null;
  const dayOfYear = Math.floor((current - Date.UTC(year, 0, 1)) / 86400000) + 1;
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1);
  const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma)
    + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma)
    + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma)
    + 0.00148 * Math.sin(3 * gamma);
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const latRad = lat * Math.PI / 180;
  const cosHour = (Math.cos(90.833 * Math.PI / 180) - Math.sin(latRad) * Math.sin(declination))
    / (Math.cos(latRad) * Math.cos(declination));
  if (cosHour < -1 || cosHour > 1) return null;
  const hourAngle = Math.acos(cosHour) * 180 / Math.PI;
  const value = 720 - 4 * lon - equation + 8 * 60 + (sunset ? 4 : -4) * hourAngle;
  return Math.max(0, Math.min(1439, Math.round(value)));
}

module.exports = { solarEventMinute };
