const fs = require('fs');
const path = require('path');

console.log('🔢 MEASUREMENT VALUE DECODER');
console.log('============================\n');

console.log('Withings stores measurements as: value × 10^unit\n');
console.log('COMMON MEASUREMENT TYPES:');
console.log('Type 1:  Weight (kg)');
console.log('Type 5:  Fat Free Mass (kg)');
console.log('Type 6:  Fat Ratio (%)');
console.log('Type 8:  Fat Mass Weight (kg)');
console.log('Type 76: Muscle Mass (%)');
console.log('Type 77: Hydration (%)');
console.log('Type 88: Bone Mass (kg)\n');

console.log('EXAMPLE FROM YOUR DATA:');
console.log('───────────────────────');
console.log('Value: 76250, Type: 1, Unit: -3');
console.log('Calculation: 76250 × 10^-3 = 76.250 kg\n');

console.log('ANALYZING YOUR FIRST MEASUREMENT:');
console.log('─────────────────────────────────');

// Simulate your first measurement values
const measurements = [
    { value: 76250, type: 1, unit: -3, desc: 'Weight: 76.25 kg' },
    { value: 1846, type: 8, unit: -2, desc: 'Fat Mass: 18.46 kg' },
    { value: 5482, type: 76, unit: -2, desc: 'Muscle Mass %: 54.82%' },
    { value: 4020, type: 77, unit: -2, desc: 'Hydration %: 40.20%' },
    { value: 296, type: 88, unit: -2, desc: 'Bone Mass: 2.96 kg' },
    { value: 24210, type: 6, unit: -3, desc: 'Fat Ratio: 24.21%' },
    { value: 57790, type: 5, unit: -3, desc: 'Fat Free Mass: 57.79 kg' }
];

measurements.forEach(m => {
    const converted = m.value * Math.pow(10, m.unit);
    console.log(`${m.desc}`);
    console.log(`  Raw: ${m.value} × 10^${m.unit} = ${converted.toFixed(2)}`);
    console.log('');
});

console.log('📈 BODY COMPOSITION SUMMARY:');
console.log('────────────────────────────');
const weight = 76250 * 0.001; // 76.25 kg
const fatRatio = 24210 * 0.001; // 24.21%
const fatMass = 1846 * 0.01; // 18.46 kg
const musclePercent = 5482 * 0.01; // 54.82%
const hydration = 4020 * 0.01; // 40.20%
const boneMass = 296 * 0.01; // 2.96 kg

console.log(`Weight: ${weight.toFixed(1)} kg`);
console.log(`Body Fat: ${fatRatio.toFixed(1)}% (${fatMass.toFixed(1)} kg)`);
console.log(`Lean Mass: ${(weight - fatMass).toFixed(1)} kg`);
console.log(`Muscle %: ${musclePercent.toFixed(1)}%`);
console.log(`Hydration: ${hydration.toFixed(1)}%`);
console.log(`Bone Mass: ${boneMass.toFixed(2)} kg (${(boneMass/weight*100).toFixed(1)}% of weight)`);