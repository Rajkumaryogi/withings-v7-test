/**
 * Upsert Vitals7-style readings into DynamoDB user_vitals (same item_key semantics as vitals7api-vitals).
 */
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const awsClient = require('./aws-client');

const USER_VITALS_TABLE = process.env.USER_VITALS_TABLE || 'user_vitals';

function recordedAtEpochFromIso(iso) {
  if (!iso || typeof iso !== 'string') return Math.floor(Date.now() / 1000);
  const s = iso.trim().replace('Z', '+00:00');
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return Math.floor(Date.now() / 1000);
  return Math.floor(d.getTime() / 1000);
}

function normalizeSourceId(sourceId) {
  if (sourceId == null || String(sourceId).trim() === '') return '';
  return String(sourceId).trim().replace(/#/g, '_').slice(0, 180);
}

function deterministicSourceId(payload) {
  const vitals = (payload.vitals || [])
    .filter((v) => v && typeof v === 'object')
    .map((v) => ({
      vitalType: String(v.vitalType || ''),
      value: String(v.value ?? ''),
      units: String(v.units || ''),
    }))
    .sort((a, b) => a.vitalType.localeCompare(b.vitalType));
  const blob = JSON.stringify({
    vitals,
    recordedAt: payload.recordedAt,
    recordedBy: payload.recordedBy,
  });
  return `auto_${crypto.createHash('sha256').update(blob).digest('hex').slice(0, 28)}`;
}

/**
 * @param {string} cognitoUserId
 * @param {Array<{ vitals: Array<{vitalType:string,value:number|string,units:string}>, recordedAt:string, recordedBy?:string, deviceUsed?:string, sourceId?:string, notes?:string, recordingContext?:string }>} payloads
 * @returns {Promise<number>}
 */
async function savePayloadsToUserVitals(cognitoUserId, payloads) {
  if (!cognitoUserId || !payloads?.length) return 0;

  const createdEpoch = Math.floor(Date.now() / 1000);
  let written = 0;

  for (const payload of payloads) {
    if (!payload || !Array.isArray(payload.vitals) || payload.vitals.length === 0) continue;

    let sid = normalizeSourceId(payload.sourceId);
    if (!sid) sid = deterministicSourceId(payload);
    sid = sid.replace(/#/g, '_').slice(0, 180);

    const recordedEpoch = recordedAtEpochFromIso(payload.recordedAt);
    const recordedBy = String(payload.recordedBy || 'device');
    const deviceUsed = payload.deviceUsed || undefined;
    const notes = payload.notes || undefined;
    const recordingContext = payload.recordingContext || undefined;

    for (const vital of payload.vitals) {
      if (!vital || typeof vital !== 'object') continue;
      const vtype = String(vital.vitalType || '').trim();
      if (!vtype) continue;

      const rowId = randomUUID();
      const itemKey = `VIT#${vtype}#SRC#${sid}#${vtype}`;

      const item = {
        user_id: cognitoUserId,
        item_key: itemKey,
        id: rowId,
        vitalType: vtype,
        value: String(vital.value ?? ''),
        units: String(vital.units || ''),
        recordedAt: recordedEpoch,
        recordedBy,
        created_at: createdEpoch,
        created_by: cognitoUserId,
        sourceId: sid,
      };
      if (deviceUsed) item.deviceUsed = deviceUsed;
      if (notes) item.notes = notes;
      if (recordingContext) item.recordingContext = recordingContext;

      try {
        const existing = await awsClient.get({
          TableName: USER_VITALS_TABLE,
          Key: { user_id: cognitoUserId, item_key: itemKey },
        });
        const prev = existing.Item;
        if (prev && String(prev.value ?? '') === String(item.value)) continue;
        if (prev) {
          item.id = prev.id || item.id;
          item.created_at = prev.created_at ?? item.created_at;
          item.created_by = prev.created_by ?? item.created_by;
        }
        await awsClient.put({ TableName: USER_VITALS_TABLE, Item: item });
        written += 1;
      } catch (e) {
        console.warn('user_vitals put failed:', e.message);
      }
    }
  }

  return written;
}

module.exports = { savePayloadsToUserVitals };
