#!/usr/bin/env node
const { initiateAuth } = require('./auth');

const  tokenManager = require('./utils/token-manager');
const { syncToUserVitalsCli } = require('./data/save-data');

async function main() {
    const command = process.argv[2];
    
    switch(command) {
        case 'auth':
            console.log('🚀 Starting authentication process...');
            await initiateAuth();
            break;
            
        case 'get-data':
            console.log('📥 Syncing Withings → DynamoDB user_vitals (set COGNITO_USER_ID or pass uuid as arg)...');
            await syncToUserVitalsCli();
            break;
            
        case 'status':
            const tokens = tokenManager.getTokens();
            if (tokens.access_token) {
                console.log('✅ Authenticated');
                console.log(`User ID: ${tokens.userid}`);
                console.log(`Access Token: ${tokens.access_token.substring(0, 20)}...`);
                console.log(`Last Sync: ${tokens.last_sync || 'Never'}`);
                
                if (tokens.access_token_timestamp) {
                    const now = Math.floor(Date.now() / 1000);
                    const age = now - tokens.access_token_timestamp;
                    const expiresIn = 10800 - age; // 3 hours in seconds
                    console.log(`Token Age: ${Math.floor(age/60)} minutes`);
                    console.log(`Expires in: ${Math.floor(expiresIn/60)} minutes`);
                }
            } else {
                console.log('❌ Not authenticated');
                console.log('Run: node src/index.js auth');
            }
            break;
            
        default:
            console.log('Withings API Integration');
            console.log('=======================');
            console.log('Commands:');
            console.log('  node src/index.js auth     - Authenticate with Withings');
            console.log('  node src/index.js get-data [uuid] - Sync to user_vitals (DynamoDB)');
            console.log('  node src/index.js status   - Check authentication status');
            console.log('');
            console.log('Or use npm scripts:');
            console.log('  npm start                  - Run interactive menu');
            console.log('  npm run auth               - Start authentication');
            console.log('  npm run get-data           - Sync to user_vitals (needs COGNITO_USER_ID or arg)');
            break;
    }
}

// Interactive menu if no command provided
if (process.argv.length <= 2) {
    const readline = require('readline').createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    console.log('\n🔧 Withings API Integration Menu\n');
    console.log('1. Authenticate with Withings');
    console.log('2. Sync Withings → user_vitals (DynamoDB)');
    console.log('3. Check Status');
    console.log('4. Exit');
    
    readline.question('\nSelect an option (1-4): ', async (choice) => {
        switch(choice) {
            case '1':
                await initiateAuth();
                break;
            case '2':
                await syncToUserVitalsCli();
                break;
            case '3':
                const tokens = tokenManager.getTokens();
                if (tokens.access_token) {
                    console.log('\n✅ Authenticated');
                    console.log(`User ID: ${tokens.userid}`);
                    console.log(`Last Sync: ${tokens.last_sync || 'Never'}`);
                } else {
                    console.log('\n❌ Not authenticated');
                }
                readline.close();
                break;
            default:
                console.log('Goodbye! 👋');
                readline.close();
                process.exit(0);
        }
    });
} else {
    main().catch(console.error);
}