const axios = require('axios');
const config = require('../config.json');
const tokenManager = require('./utils/token-manager');
const { exchangeCodeForTokens } = require('./auth');
const crypto = require('crypto');
const dynamodb = require('./aws/dynamodb-client');

/** Positive int from env, or default (used for day windows and pagination caps). */
function envInt(name, defaultValue) {
    const raw = process.env[name];
    if (raw == null || raw === '') return defaultValue;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

class WithingsAPI {
    constructor() {
        this.baseURL = config.api_endpoint;
        this.tokens = tokenManager.getTokens();
    }

    // Simple signature function (same as in auth.js)
    sign(params) {
        const params_to_sign = {
            action: params.action,
            client_id: config.client_id
        };
        
        if (params.timestamp) {
            params_to_sign.timestamp = params.timestamp;
        }
        if (params.nonce) {
            params_to_sign.nonce = params.nonce;
        }
        
        // Sort parameters alphabetically
        const sorted_keys = Object.keys(params_to_sign).sort();
        const sorted_values = sorted_keys.map(key => params_to_sign[key]).join(',');
        
        const hmac = crypto.createHmac('sha256', config.client_secret);
        hmac.update(sorted_values);
        return hmac.digest("hex");
    }

    getCurrentTimestamp() {
        return Math.round(Date.now() / 1000);
    }

    async getNonce(timestamp) {
        try {
            const params = {
                action: 'getnonce',
                client_id: config.client_id,
                timestamp: timestamp
            };
            
            params.signature = this.sign(params);
            
            const response = await axios.post(`${this.baseURL}/v2/signature`, params);
            return response.data.body.nonce;
        } catch (error) {
            console.error('Error getting nonce:', error.response?.data || error.message);
            throw error;
        }
    }

    async ensureValidToken() {
        const tokens = tokenManager.getTokens();

        if (!tokens.access_token) {
            throw new Error('No access token found. Please run authentication first: npm run auth');
        }

        if (tokenManager.isTokenExpired(tokens.access_token_timestamp)) {
            console.log('🔄 Access token expired, attempting to refresh...');
            await this.refreshAccessToken();
        }

        // Always read fresh from tokenManager — this.tokens is a stale constructor snapshot
        return tokenManager.getTokens().access_token;
    }

    async refreshAccessToken() {
        try {
            const tokens = tokenManager.getTokens();
            
            if (!tokens.refresh_token) {
                throw new Error('No refresh token available. Please re-authenticate.');
            }
            
            const timestamp = this.getCurrentTimestamp();
            const nonce = await this.getNonce(timestamp);
            
            const params = {
                action: 'requesttoken',
                client_id: config.client_id,
                grant_type: 'refresh_token',
                refresh_token: tokens.refresh_token,
                nonce: nonce,
                timestamp: timestamp
            };
            
            params.signature = this.sign(params);
            
            const response = await axios.post(`${this.baseURL}/v2/oauth2`, params);
            const { userid, access_token, refresh_token, scope, expires_in, csrf_token, token_type } = response.data.body;
            
            // Update tokens
            const newTokens = {
                userid,
                access_token,
                refresh_token,
                scope,
                expires_in,
                csrf_token,
                token_type,
                access_token_timestamp: timestamp,
                refresh_token_timestamp: timestamp
            };
            
            tokenManager.updateTokens(newTokens);
            console.log('✅ Access token refreshed!');

            // Persist refreshed tokens to DynamoDB so they survive server restarts
            const cognitoUserId = tokenManager.getTokens().cognitoUserId;
            if (cognitoUserId) {
                dynamodb.saveTokens({
                    UserID: cognitoUserId,
                    AccessToken: access_token,
                    RefreshToken: refresh_token,
                    Expires: expires_in || 10800,
                    APIName: 'Withings',
                    token_type: token_type || 'bearer',
                    WithingsUserid: String(userid),
                }).catch(err => console.warn('Failed to persist refreshed tokens to DynamoDB:', err.message));
            }
            
            return newTokens;
        } catch (error) {
            console.error('❌ Error refreshing token:', error.response?.data || error.message);
            throw error;
        }
    }

    async makeRequest(action, params = {}) {
        const accessToken = await this.ensureValidToken();
        console.log(`📡 Making API request: ${action}`);
        const response = await axios.post(
            `${this.baseURL}/v2/user`,
            new URLSearchParams({ action, ...params }),
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        return response.data;
    }

    async makeMeasureRequest(action, params = {}) {
        const accessToken = await this.ensureValidToken();
        console.log(`📡 Making measure request: ${action}`);
        const response = await axios.post(
            `${this.baseURL}/v2/measure`,
            new URLSearchParams({ action, ...params }),
            { headers: { 'Authorization': `Bearer ${accessToken}` } }
        );
        return response.data;
    }

    // User Information
    async getUserInfo() {
        return this.makeRequest('getbyuserid');
    }

    // Device Information
    async getDevices() {
        return this.makeRequest('getdevice');
    }

    // Activity Data (startdateymd/enddateymd = YYYY-MM-DD). Paginates until Withings reports no more rows.
    async getActivity(params = {}) {
        const days = envInt('WITHINGS_ACTIVITY_DAYS', 90);
        const maxPages = envInt('WITHINGS_API_MAX_PAGES', 100);
        const base = {
            startdateymd: this.getDateDaysAgo(days),
            enddateymd: this.getCurrentDate(),
            ...params,
        };
        const activities = [];
        let offset = base.offset != null ? Number(base.offset) : 0;
        let lastStatus = 0;
        let page = 0;
        let more = true;
        while (more && page < maxPages) {
            page += 1;
            const data = await this.makeMeasureRequest('getactivity', { ...base, offset });
            const body = data.body || {};
            lastStatus = data.status != null ? data.status : lastStatus;
            const batch = Array.isArray(body.activities) ? body.activities : [];
            activities.push(...batch);
            more = body.more === 1 || body.more === true;
            offset = body.offset != null ? Number(body.offset) : offset + batch.length;
            if (!more || batch.length === 0) break;
        }
        if (page >= maxPages) {
            console.warn(`⚠️ getactivity stopped at max pages (${maxPages}); set WITHINGS_API_MAX_PAGES or narrow WITHINGS_ACTIVITY_DAYS.`);
        }
        return { status: lastStatus, body: { activities, more: false, offset: activities.length } };
    }

    // Body Metrics - getmeas. startdate/enddate = unix seconds. Paginates measuregrps.
    // meastypes: 1=weight, 4=height, 5=fat free mass, 6=fat ratio, 8=fat mass, 76=muscle, 77=hydration, 88=bone, 9/10/11=BP+pulse, 12/71=temp, 54=SpO2, 226=BMR, 227=metabolic age
    async getBodyMetrics(params = {}) {
        const days = envInt('WITHINGS_MEASURE_DAYS', 365);
        const maxPages = envInt('WITHINGS_API_MAX_PAGES', 100);
        const base = {
            startdate: this.getTimestampDaysAgo(days),
            enddate: this.getCurrentTimestamp(),
            category: 1,
            meastypes: '1,4,5,6,8,9,10,11,12,54,71,76,77,88,226,227',
            ...params,
        };
        const measuregrps = [];
        let offset = base.offset != null ? Number(base.offset) : 0;
        let lastBody = {};
        let lastStatus = 0;
        let page = 0;
        let more = true;
        while (more && page < maxPages) {
            page += 1;
            const data = await this.makeMeasureRequest('getmeas', { ...base, offset });
            const body = data.body || {};
            lastBody = body;
            lastStatus = data.status != null ? data.status : lastStatus;
            const batch = Array.isArray(body.measuregrps) ? body.measuregrps : [];
            measuregrps.push(...batch);
            more = body.more === 1 || body.more === true;
            offset = body.offset != null ? Number(body.offset) : offset + batch.length;
            if (!more || batch.length === 0) break;
        }
        if (page >= maxPages) {
            console.warn(`⚠️ getmeas stopped at max pages (${maxPages}); set WITHINGS_API_MAX_PAGES or narrow WITHINGS_MEASURE_DAYS.`);
        }
        return {
            status: lastStatus,
            body: { ...lastBody, measuregrps, more: false, offset: measuregrps.length },
        };
    }

    // Sleep v2 — getsummary. Paginates series when Withings sets more=1.
    async getSleepData(params = {}) {
        const accessToken = await this.ensureValidToken();
        const days = envInt('WITHINGS_SLEEP_DAYS', 90);
        const maxPages = envInt('WITHINGS_API_MAX_PAGES', 100);
        const base = {
            action: 'getsummary',
            startdateymd: this.getDateDaysAgo(days),
            enddateymd: this.getCurrentDate(),
            ...params,
        };
        const series = [];
        let offset = base.offset != null ? Number(base.offset) : 0;
        let lastData = {};
        let page = 0;
        let more = true;
        console.log('📡 Making sleep request(s): getsummary');
        while (more && page < maxPages) {
            page += 1;
            const response = await axios.post(
                `${this.baseURL}/v2/sleep`,
                new URLSearchParams({ ...base, offset }),
                { headers: { Authorization: `Bearer ${accessToken}` } }
            );
            lastData = response.data;
            const body = lastData.body || {};
            const batch = Array.isArray(body.series) ? body.series : [];
            series.push(...batch);
            more = body.more === 1 || body.more === true;
            offset = body.offset != null ? Number(body.offset) : offset + batch.length;
            if (!more || batch.length === 0) break;
        }
        if (page >= maxPages) {
            console.warn(`⚠️ getsummary stopped at max pages (${maxPages}); set WITHINGS_API_MAX_PAGES or narrow WITHINGS_SLEEP_DAYS.`);
        }
        const status = lastData.status != null ? lastData.status : 0;
        const rest = { ...(lastData.body || {}) };
        delete rest.series;
        return { status, body: { ...rest, series, more: false, offset: series.length } };
    }

    // Heart Rate Data
    async getHeartRate(params = {}) {
        try {
            const accessToken = await this.ensureValidToken();
            
            const defaultParams = {
                startdate: this.getTimestampDaysAgo(1), // Last 24 hours
                enddate: this.getCurrentTimestamp(),
                action: 'get'
            };
            
            const requestParams = { ...defaultParams, ...params };
            
            console.log(`📡 Making heart rate request`);
            
            const response = await axios.post(`${this.baseURL}/heart`, requestParams, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            });
            
            return response.data;
        } catch (error) {
            console.error('❌ Heart Rate API Error:', error.response?.data || error.message);
            throw error;
        }
    }

    // Helper methods for dates
    getCurrentDate() {
        return new Date().toISOString().split('T')[0];
    }

    getDateDaysAgo(days) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        return date.toISOString().split('T')[0];
    }

    getTimestampDaysAgo(days) {
        const date = new Date();
        date.setDate(date.getDate() - days);
        return Math.floor(date.getTime() / 1000);
    }

    // Get all data
    async getAllData() {
        try {
            console.log('📊 Fetching all Withings data...');
            const [
                userInfo,
                devices,
                activity,
                bodyMetrics,
                sleepData
            ] = await Promise.all([
                this.getUserInfo(),
                this.getDevices(),
                this.getActivity(),
                this.getBodyMetrics(),
                this.getSleepData()
            ]);
            // Debug: log raw API statuses and body shapes to diagnose empty data
            console.log('🔍 Raw API statuses — user:%d devices:%d activity:%d metrics:%d sleep:%d',
                userInfo.status, devices.status, activity.status, bodyMetrics.status, sleepData.status);
            console.log('🔍 activity.body keys:', Object.keys(activity.body || {}));
            console.log('🔍 activity.body.activities length:', (activity.body?.activities || []).length);
            console.log('🔍 metrics.body keys:', Object.keys(bodyMetrics.body || {}));
            console.log('🔍 metrics.body.measuregrps length:', (bodyMetrics.body?.measuregrps || []).length);
            console.log('🔍 sleep.body keys:', Object.keys(sleepData.body || {}));
            console.log('🔍 sleep.body.series length:', (sleepData.body?.series || []).length);

            const allData = {
                timestamp: this.getCurrentTimestamp(),
                fetched_at: new Date().toISOString(),
                user: userInfo.body,
                devices: devices.body,
                activity: activity.body,
                metrics: bodyMetrics.body,
                sleep: sleepData.body
            };
            console.log('✅ All data fetched successfully!');
            return allData;
        } catch (error) {
            console.error('❌ Error fetching all data:', error.message);
            throw error;
        }
    }

    // Get specific data ranges
    async getDataForLastNDays(days = 7) {
        const endDate = this.getCurrentDate();
        const startDate = this.getDateDaysAgo(days);
        const endTimestamp = this.getCurrentTimestamp();
        const startTimestamp = this.getTimestampDaysAgo(days);

        console.log(`📅 Fetching data for last ${days} days (${startDate} to ${endDate})`);
        
        try {
            const [activity, bodyMetrics, sleepData] = await Promise.all([
                this.getActivity({ startdateymd: startDate, enddateymd: endDate }),
                this.getBodyMetrics({ startdate: startTimestamp, enddate: endTimestamp }),
                this.getSleepData({ startdateymd: startDate, enddateymd: endDate })
            ]);

            return {
                timestamp: this.getCurrentTimestamp(),
                fetched_at: new Date().toISOString(),
                date_range: { start_date: startDate, end_date: endDate, days: days },
                activity: activity.body,
                metrics: bodyMetrics.body,
                sleep: sleepData.body
            };
        } catch (error) {
            console.error(`❌ Error fetching data for last ${days} days:`, error.message);
            throw error;
        }
    }
}

module.exports = new WithingsAPI();