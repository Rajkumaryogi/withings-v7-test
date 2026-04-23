const fs = require('fs');
const path = require('path');

const dataDir = './data';
const latestFile = fs.readdirSync(dataDir)
    .filter(f => f.includes('withings-complete-'))
    .sort()
    .reverse()[0];

console.log('⚖️ WITHINGS BODY+ SCALE ANALYSIS');
console.log('=================================\n');

const data = JSON.parse(fs.readFileSync(path.join(dataDir, latestFile), 'utf8'));

// Device Information
console.log('📱 DEVICE: Withings Body+ Scale');
console.log(`Device ID: ${data.devices.devices[0].deviceid}`);
console.log(`Battery: ${data.devices.devices[0].battery}`);
console.log(`First Use: ${new Date(data.devices.devices[0].first_session_date * 1000).toLocaleDateString()}`);
console.log(`Last Use: ${new Date(data.devices.devices[0].last_session_date * 1000).toLocaleString()}`);
console.log('');

// Measurement Types Reference
const measureTypes = {
    1: { name: 'Weight', unit: 'kg', convert: val => (val * 0.001).toFixed(2) },
    4: { name: 'Height', unit: 'meter', convert: val => (val * 0.01).toFixed(2) },
    5: { name: 'Fat Free Mass', unit: 'kg', convert: val => (val * 0.001).toFixed(2) },
    6: { name: 'Fat Ratio', unit: '%', convert: val => (val * 0.001).toFixed(1) },
    8: { name: 'Fat Mass', unit: 'kg', convert: val => (val * 0.01).toFixed(2) },
    9: { name: 'Muscle Mass', unit: 'kg', convert: val => (val * 0.001).toFixed(2) },
    76: { name: 'Muscle Mass %', unit: '%', convert: val => (val * 0.01).toFixed(1) },
    77: { name: 'Hydration %', unit: '%', convert: val => (val * 0.01).toFixed(1) },
    88: { name: 'Bone Mass', unit: 'kg', convert: val => (val * 0.01).toFixed(2) },
    91: { name: 'Pulse Wave Velocity', unit: 'm/s', convert: val => val.toFixed(1) }
};

// Analyze each measurement group
console.log('📈 MEASUREMENTS FOUND:\n');

if (data.metrics?.measuregrps) {
    data.metrics.measuregrps.forEach((group, index) => {
        const measurementDate = new Date(group.date * 1000);
        console.log(`MEASUREMENT ${index + 1}: ${measurementDate.toLocaleString()}`);
        console.log('─'.repeat(50));
        
        // Organize measurements by category
        const measurements = {};
        
        group.measures.forEach(measure => {
            const typeInfo = measureTypes[measure.type] || { 
                name: `Type ${measure.type}`, 
                unit: 'units',
                convert: val => val.toFixed(2)
            };
            
            const convertedValue = typeInfo.convert(measure.value);
            measurements[typeInfo.name] = {
                value: convertedValue,
                unit: typeInfo.unit,
                raw: measure.value,
                unitPower: measure.unit
            };
        });
        
        // Display in a nice format
        if (measurements['Weight']) {
            console.log(`⚖️  Weight: ${measurements['Weight'].value} ${measurements['Weight'].unit}`);
        }
        
        if (measurements['Fat Ratio']) {
            console.log(`🎯 Body Fat: ${measurements['Fat Ratio'].value}%`);
            if (measurements['Fat Mass']) {
                console.log(`   Fat Mass: ${measurements['Fat Mass'].value} kg`);
            }
        }
        
        if (measurements['Fat Free Mass']) {
            console.log(`💪 Lean Mass: ${measurements['Fat Free Mass'].value} kg`);
        }
        
        if (measurements['Muscle Mass %']) {
            console.log(`🏋️  Muscle %: ${measurements['Muscle Mass %'].value}%`);
        }
        
        if (measurements['Hydration %']) {
            console.log(`💧 Hydration: ${measurements['Hydration %'].value}%`);
        }
        
        if (measurements['Bone Mass']) {
            console.log(`�� Bone Mass: ${measurements['Bone Mass'].value} kg`);
        }
        
        console.log('');
        
        // Show raw data for debugging
        console.log('   Raw Data:');
        group.measures.forEach(measure => {
            const typeInfo = measureTypes[measure.type] || { name: `Type ${measure.type}`, unit: 'units' };
            console.log(`   - ${typeInfo.name}: ${measure.value} × 10^${measure.unit} ${typeInfo.unit}`);
        });
        
        console.log('\n');
    });
    
    // Calculate differences between measurements
    if (data.metrics.measuregrps.length >= 2) {
        console.log('📊 COMPARISON BETWEEN MEASUREMENTS:');
        console.log('─'.repeat(50));
        
        const first = data.metrics.measuregrps[0];
        const second = data.metrics.measuregrps[1];
        
        const firstDate = new Date(first.date * 1000);
        const secondDate = new Date(second.date * 1000);
        const timeDiff = Math.abs(secondDate - firstDate);
        const minutesDiff = Math.floor(timeDiff / (1000 * 60));
        
        console.log(`Time between measurements: ${minutesDiff} minutes\n`);
        
        // Compare weight
        const firstWeight = first.measures.find(m => m.type === 1);
        const secondWeight = second.measures.find(m => m.type === 1);
        
        if (firstWeight && secondWeight) {
            const weight1 = firstWeight.value * Math.pow(10, firstWeight.unit);
            const weight2 = secondWeight.value * Math.pow(10, secondWeight.unit);
            const diff = weight2 - weight1;
            
            console.log(`Weight Change: ${diff > 0 ? '+' : ''}${diff.toFixed(3)} kg`);
            console.log(`  (${weight1.toFixed(2)} kg → ${weight2.toFixed(2)} kg)`);
        }
    }
} else {
    console.log('No measurements found');
}

// Health insights
console.log('💡 HEALTH INSIGHTS:');
console.log('─'.repeat(50));
console.log('• Your Withings Body+ scale provides comprehensive body composition');
console.log('• Measurements include weight, body fat %, muscle mass, hydration, and bone mass');
console.log('• For accurate trends, measure at the same time each day (preferably morning)');
console.log('• Stay hydrated - optimal hydration is typically 50-65% for adults');
console.log('• Healthy body fat ranges vary by age and gender (typically 8-25% for men)');
