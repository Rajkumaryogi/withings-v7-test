/**
 * Transform Withings API data to Vitals7 API format.
 * vitalType strings MUST match vitals7-app `VitalType` enum (kebab-case) — see vitals.constant.ts / @types/vitals.ts.
 *
 * Withings measure types:
 *   1=weight(kg), 4=height(m), 5=fatFreeMass(kg), 6=fatRatio(%), 8=fatMass(kg),
 *   9=diastolicBP(mmHg), 10=systolicBP(mmHg), 11=heartPulse(bpm),
 *   12=bodyTemp(°C), 54=SPO2(%), 71=bodyTemp(°C),
 *   76=muscleMass(kg), 77=bodyWater(%), 88=boneMass(kg),
 *   226=BMR(kcal), 227=metabolicAge(years)
 *
 * Types not in VitalType (e.g. fat mass, muscle mass) are not sent.
 */

/** Must stay in sync with vitals7-app VitalType enum */
const ALLOWED_VITAL_TYPES = new Set([
  'blood-pressure-systolic',
  'blood-pressure-diastolic',
  'heart-rate',
  'body-temperature',
  'weight',
  'height',
  'bmi',
  'blood-glucose',
  'oxygen-saturation',
  'respiratory-rate',
  'cholesterol-total',
  'cholesterol-ldl',
  'cholesterol-hdl',
  'body-fat-percentage',
  'steps',
  'sleep-hours',
  'water-intake',
]);

const KG_TO_LBS = 2.20462;
const M_TO_IN = 39.3701;

function formatDate(timestamp) {
  if (!timestamp) return new Date().toISOString();
  const date = typeof timestamp === 'number' ? new Date(timestamp * 1000) : new Date(timestamp);
  return date.toISOString();
}

function sourceId(prefix, grpid, type) {
  return `withings_${prefix}_${grpid}_${type}`;
}

/**
 * Drop vitals with unknown types or invalid values. Returns null if nothing left (caller should not POST).
 */
function sanitizePayload(payload) {
  if (!payload || !Array.isArray(payload.vitals)) return null;
  const vitals = payload.vitals.filter(
    (v) =>
      v &&
      typeof v.vitalType === 'string' &&
      ALLOWED_VITAL_TYPES.has(v.vitalType) &&
      typeof v.value === 'number' &&
      !Number.isNaN(v.value) &&
      Number.isFinite(v.value)
  );
  if (vitals.length === 0) return null;
  return { ...payload, vitals };
}

function celsiusToFahrenheit(c) {
  return (c * 9) / 5 + 32;
}

/**
 * One measure group (getmeas) can have multiple measure types. Emit one Vitals7 record per logical reading.
 */
function measuresToVitals7Payloads(grp, userId, recordedBy = 'Withings') {
  const payloads = [];
  const date = grp.date || grp.created;
  const grpid = grp.grpid ?? grp.id ?? date;
  const measures = grp.measures || [];
  const decoded = {};
  measures.forEach((m) => {
    const typ = m.type ?? m.measure_type;
    const val = m.value ?? m.val;
    const unit = m.unit != null ? m.unit : 0;
    if (typ == null) return;
    const value = (val != null ? val : 0) * Math.pow(10, unit);
    decoded[typ] = value;
  });

  // Body composition from scale — only VitalType-supported metrics
  if (decoded[1] != null) {
    const weightKg = decoded[1];
    const vitals = [
      {
        vitalType: 'weight',
        value: +(weightKg * KG_TO_LBS).toFixed(2),
        units: 'lbs',
      },
    ];
    if (decoded[6] != null) {
      vitals.push({
        vitalType: 'body-fat-percentage',
        value: +decoded[6].toFixed(2),
        units: '%',
      });
    }
    if (decoded[4] != null && decoded[4] > 0) {
      const bmi = weightKg / (decoded[4] * decoded[4]);
      vitals.push({ vitalType: 'bmi', value: +bmi.toFixed(1), units: 'kg/m²' });
    }
    const p = sanitizePayload({
      user_id: userId,
      vitals,
      recordedBy,
      recordedAt: formatDate(date),
      deviceUsed: 'Withings Scale',
      recordingContext: 'home_measurement',
      sourceId: sourceId('weight', grpid, '1'),
    });
    if (p) payloads.push(p);
  }

  // Standalone height (m → inches for Vitals7 UI)
  if (decoded[4] != null && decoded[1] == null) {
    const p = sanitizePayload({
      user_id: userId,
      vitals: [
        {
          vitalType: 'height',
          value: +(decoded[4] * M_TO_IN).toFixed(2),
          units: 'inches',
        },
      ],
      recordedBy,
      recordedAt: formatDate(date),
      deviceUsed: 'Withings Scale',
      recordingContext: 'home_measurement',
      sourceId: sourceId('height', grpid, '4'),
    });
    if (p) payloads.push(p);
  }

  // Blood pressure
  if (decoded[10] != null || decoded[9] != null) {
    const vitals = [];
    if (decoded[10] != null) {
      vitals.push({ vitalType: 'blood-pressure-systolic', value: decoded[10], units: 'mmHg' });
    }
    if (decoded[9] != null) {
      vitals.push({ vitalType: 'blood-pressure-diastolic', value: decoded[9], units: 'mmHg' });
    }
    if (decoded[11] != null) {
      vitals.push({ vitalType: 'heart-rate', value: decoded[11], units: 'bpm' });
    }
    const p = sanitizePayload({
      user_id: userId,
      vitals,
      recordedBy,
      recordedAt: formatDate(date),
      deviceUsed: 'Withings BP Monitor',
      recordingContext: 'home_measurement',
      sourceId: sourceId('bp', grpid, '9'),
    });
    if (p) payloads.push(p);
  }

  // SpO2
  if (decoded[54] != null) {
    const p = sanitizePayload({
      user_id: userId,
      vitals: [{ vitalType: 'oxygen-saturation', value: decoded[54], units: '%' }],
      recordedBy,
      recordedAt: formatDate(date),
      deviceUsed: 'Withings Pulse Oximeter',
      recordingContext: 'home_measurement',
      sourceId: sourceId('spo2', grpid, '54'),
    });
    if (p) payloads.push(p);
  }

  // Temperature (°C from Withings → °F for Vitals7 UI)
  const tempC = decoded[71] ?? decoded[12];
  if (tempC != null) {
    const p = sanitizePayload({
      user_id: userId,
      vitals: [
        {
          vitalType: 'body-temperature',
          value: +celsiusToFahrenheit(tempC).toFixed(1),
          units: '°F',
        },
      ],
      recordedBy,
      recordedAt: formatDate(date),
      deviceUsed: 'Withings Thermometer',
      recordingContext: 'home_measurement',
      sourceId: sourceId('temp', grpid, '71'),
    });
    if (p) payloads.push(p);
  }

  return payloads;
}

/**
 * Activity — only `steps` is a VitalType; calories/distance are omitted.
 */
function activityToVitals7Payloads(activities, userId, recordedBy = 'Withings') {
  const payloads = [];
  (activities || []).forEach((a) => {
    const date = a.date;
    const steps = a.steps ?? a.steps_total ?? 0;
    if (steps <= 0) return;
    const p = sanitizePayload({
      user_id: userId,
      vitals: [{ vitalType: 'steps', value: steps, units: 'count' }],
      recordedBy,
      recordedAt: formatDate(date),
      deviceUsed: 'Withings Activity',
      recordingContext: 'daily_activity',
      sourceId: sourceId('activity', a.id ?? date, 'steps'),
    });
    if (p) payloads.push(p);
  });
  return payloads;
}

/**
 * Sleep — VitalType uses `sleep-hours` (decimal hours).
 */
function sleepToVitals7Payloads(sleepBody, userId, recordedBy = 'Withings') {
  const payloads = [];
  const series = sleepBody?.series || [];
  series.forEach((s) => {
    const start = s.startdate;
    const end = s.enddate;
    const totalSleep = s.data?.total_sleep_time ?? s.total_sleep_time ?? (end && start ? end - start : 0);
    if (totalSleep <= 0) return;
    const hours = +(totalSleep / 3600).toFixed(2);
    const p = sanitizePayload({
      user_id: userId,
      vitals: [{ vitalType: 'sleep-hours', value: hours, units: 'hours' }],
      recordedBy,
      recordedAt: formatDate(start),
      deviceUsed: 'Withings Sleep',
      recordingContext: 'sleep',
      sourceId: sourceId('sleep', s.id ?? start ?? Date.now(), 'sleep'),
    });
    if (p) payloads.push(p);
  });
  return payloads;
}

/**
 * Build all Vitals7 payloads from Withings API response (getAllData shape).
 */
function allPayloads(allData, userId, recordedBy = 'Withings') {
  const payloads = [];
  const measuregrps =
    allData.metrics?.measuregrps ||
    allData.metrics?.body?.measuregrps ||
    allData.metrics?.measuregroups ||
    [];
  measuregrps.forEach((grp) => {
    payloads.push(...measuresToVitals7Payloads(grp, userId, recordedBy));
  });
  const activities = Array.isArray(allData.activity)
    ? allData.activity
    : (allData.activity?.activities ?? allData.activity?.body?.activities ?? []);
  payloads.push(...activityToVitals7Payloads(activities, userId, recordedBy));
  const sleepBody = allData.sleep?.body ?? allData.sleep ?? {};
  const series = sleepBody.series ?? sleepBody;
  if (Array.isArray(series) && series.length > 0) {
    payloads.push(...sleepToVitals7Payloads({ series }, userId, recordedBy));
  } else if (sleepBody.series) {
    payloads.push(...sleepToVitals7Payloads(sleepBody, userId, recordedBy));
  }
  return payloads;
}

module.exports = {
  formatDate,
  sourceId,
  ALLOWED_VITAL_TYPES,
  sanitizePayload,
  measuresToVitals7Payloads,
  activityToVitals7Payloads,
  sleepToVitals7Payloads,
  allPayloads,
};
