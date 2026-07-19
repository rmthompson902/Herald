'use strict';

const fs = require('fs');

/**
 * Loads and validates config/zone-map.json: Dante output channel number -> zone name.
 * This is the one manual zone configuration in the system (see project plan).
 */
function loadZoneMap(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);

  const zoneMap = new Map();
  for (const [channel, zoneName] of Object.entries(parsed)) {
    if (channel === '_comment') continue;
    const channelNumber = Number(channel);
    if (!Number.isInteger(channelNumber) || channelNumber < 1) {
      throw new Error(`zone-map.json: invalid channel key "${channel}" (must be a positive integer)`);
    }
    if (typeof zoneName !== 'string' || zoneName.trim() === '') {
      throw new Error(`zone-map.json: invalid zone name for channel ${channel}`);
    }
    zoneMap.set(channelNumber, zoneName);
  }

  if (zoneMap.size === 0) {
    throw new Error('zone-map.json: no channel -> zone entries found');
  }

  return zoneMap;
}

module.exports = { loadZoneMap };
