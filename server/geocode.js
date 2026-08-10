// Geocode a US ZIP code to latitude/longitude.
//
// Uses Zippopotam.us — a free, key-less public API that resolves US ZIPs to
// coordinates. We geocode once when the tenant saves their ZIP and cache the
// result on the tenant row; the frontend's per-load weather fetch then uses the
// stored lat/lon directly (Open-Meteo forecast, also key-less).
//
// Node 22 provides a global fetch, so no HTTP dependency is needed.

const ZIP_RE = /^\d{5}$/;

/**
 * @param {string} zip 5-digit US ZIP
 * @returns {Promise<{latitude:number, longitude:number, place:string}|null>}
 *          null if the ZIP is malformed, not found, or the lookup fails.
 */
async function geocodeZip(zip) {
  const clean = String(zip || '').trim().slice(0, 5);
  if (!ZIP_RE.test(clean)) return null;

  try {
    const res = await fetch(`https://api.zippopotam.us/us/${clean}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null; // 404 for unknown ZIPs

    const data = await res.json();
    const place = Array.isArray(data.places) ? data.places[0] : null;
    if (!place) return null;

    const latitude = parseFloat(place.latitude);
    const longitude = parseFloat(place.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    return {
      latitude,
      longitude,
      place: [place['place name'], place['state abbreviation']].filter(Boolean).join(', '),
    };
  } catch {
    return null; // network error / timeout — caller treats as "couldn't geocode"
  }
}

module.exports = { geocodeZip, ZIP_RE };
