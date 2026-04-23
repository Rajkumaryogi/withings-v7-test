const fs = require('fs');
const path = require('path');

console.log('🏥 PERSONAL HEALTH DASHBOARD');
console.log('════════════════════════════\n');

const dataDir = './data';
const files = fs.readdirSync(dataDir)
    .filter(f => f.includes('withings-complete-'))
    .sort()
    .reverse();

if (files.length === 0) {
    console.log('No data files found');
    process.exit(0);
}

const data = JSON.parse(fs.readFileSync(path.join(dataDir, files[0]), 'utf8'));

// Get latest measurement
const latestGroup = data.metrics?.measuregrps?.[0];
if (!latestGroup) {
    console.log('No measurements found');
    process.exit(0);
}

// Extract values
const measures = {};
latestGroup.measures.forEach(m => {
    const value = m.value * Math.pow(10, m.unit);
    switch(m.type) {
        case 1: measures.weight = value; break;
        case 5: measures.fatFreeMass = value; break;
        case 6: measures.fatRatio = value; break;
        case 8: measures.fatMass = value; break;
        case 76: measures.musclePercent = value; break;
        case 77: measures.hydration = value; break;
        case 88: measures.boneMass = value; break;
    }
});

const measurementTime = new Date(latestGroup.date * 1000);

// Display Dashboard
console.log(`📅 Last Measurement: ${measurementTime.toLocaleString()}`);
console.log('');

// Weight Section
console.log('⚖️  WEIGHT');
console.log('─────────');
if (measures.weight) {
    console.log(`   ${measures.weight.toFixed(2)} kg`);
    console.log(`   ${(measures.weight * 2.20462).toFixed(1)} lbs`);
    
    // BMI Estimate (assuming average height)
    const estimatedHeight = 1.75; // meters - adjust this!
    const bmi = measures.weight / (estimatedHeight * estimatedHeight);
    console.log(`   Estimated BMI: ${bmi.toFixed(1)}`);
    
    if (bmi < 18.5) console.log('   📊 Status: Underweight');
    else if (bmi < 25) console.log('   📊 Status: Normal weight');
    else if (bmi < 30) console.log('   📊 Status: Overweight');
    else console.log('   📊 Status: Obese');
}
console.log('');

// Body Composition
console.log('🎯 BODY COMPOSITION');
console.log('──────────────────');
if (measures.fatRatio) {
    console.log(`   Body Fat: ${measures.fatRatio.toFixed(1)}%`);
    
    // Fat status based on typical ranges
    if (measures.fatRatio < 8) console.log('   📊 Status: Essential fat');
    else if (measures.fatRatio < 20) console.log('   📊 Status: Athletic');
    else if (measures.fatRatio < 25) console.log('   📊 Status: Fit');
    else if (measures.fatRatio < 32) console.log('   📊 Status: Average');
    else console.log('   📊 Status: Above average');
}

if (measures.fatMass) {
    console.log(`   Fat Mass: ${measures.fatMass.toFixed(1)} kg`);
}

if (measures.fatFreeMass) {
    console.log(`   Lean Mass: ${measures.fatFreeMass.toFixed(1)} kg`);
}
console.log('');

// Muscle & Hydration
console.log('💪 MUSCLE & HYDRATION');
console.log('─────────────────────');
if (measures.musclePercent) {
    console.log(`   Muscle %: ${measures.musclePercent.toFixed(1)}%`);
}

if (measures.hydration) {
    console.log(`   Hydration: ${measures.hydration.toFixed(1)}%`);
    if (measures.hydration < 50) console.log('   💧 Status: Could drink more water');
    else if (measures.hydration < 60) console.log('   💧 Status: Well hydrated');
    else console.log('   💧 Status: Very well hydrated');
}
console.log('');

// Bone Mass
console.log('🦴 BONE HEALTH');
console.log('──────────────');
if (measures.boneMass) {
    console.log(`   Bone Mass: ${measures.boneMass.toFixed(2)} kg`);
    if (measures.weight) {
        const bonePercent = (measures.boneMass / measures.weight * 100).toFixed(1);
        console.log(`   Bone % of weight: ${bonePercent}%`);
    }
}
console.log('');

// Device Info
console.log('📱 CONNECTED DEVICE');
console.log('───────────────────');
if (data.devices?.devices?.[0]) {
    const device = data.devices.devices[0];
    console.log(`   Type: ${device.type}`);
    console.log(`   Model: ${device.model || 'Body+ Scale'}`);
    console.log(`   Battery: ${device.battery}`);
    const lastUsed = new Date(device.last_session_date * 1000);
    console.log(`   Last Used: ${lastUsed.toLocaleDateString()}`);
}

// Recommendations
console.log('\n💡 RECOMMENDATIONS');
console.log('─────────────────');
console.log('1. Measure daily at the same time (morning after bathroom)');
console.log('2. Stay consistent with hydration before measuring');
console.log('3. Track trends weekly rather than daily fluctuations');
console.log('4. Combine with activity data for complete health picture');
console.log('5. Consider pairing with Withings activity tracker for steps/sleep');

// Next data fetch reminder
console.log('\n⏰ NEXT DATA FETCH:');
console.log('Sync to DynamoDB: COGNITO_USER_ID=<uuid> npm run get-data');
console.log('Or schedule: 0 8 * * * cd $(pwd) && COGNITO_USER_ID=<uuid> npm run get-data');