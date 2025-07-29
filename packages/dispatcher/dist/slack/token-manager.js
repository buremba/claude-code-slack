"use strict";
// Token manager for handling Slack OAuth token rotation
Object.defineProperty(exports, "__esModule", { value: true });
exports.SlackTokenManager = void 0;
class SlackTokenManager {
    clientId;
    clientSecret;
    refreshToken;
    currentToken;
    tokenExpiresAt;
    refreshTimer;
    constructor(clientId, clientSecret, refreshToken, initialToken) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.refreshToken = refreshToken;
        this.currentToken = initialToken;
        // Assume token expires in 12 hours if not specified
        this.tokenExpiresAt = Date.now() + (11 * 60 * 60 * 1000); // 11 hours to be safe
        // Schedule token refresh
        this.scheduleTokenRefresh();
    }
    async refreshAccessToken() {
        console.log('Refreshing Slack access token...');
        const params = new URLSearchParams({
            client_id: this.clientId,
            client_secret: this.clientSecret,
            grant_type: 'refresh_token',
            refresh_token: this.refreshToken
        });
        try {
            const response = await fetch('https://slack.com/api/oauth.v2.access', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: params.toString()
            });
            const data = await response.json();
            if (data.ok) {
                this.currentToken = data.access_token;
                // Update refresh token if a new one is provided
                if (data.refresh_token) {
                    this.refreshToken = data.refresh_token;
                }
                // Calculate expiration time
                const expiresIn = data.expires_in || (12 * 60 * 60); // Default to 12 hours
                this.tokenExpiresAt = Date.now() + (expiresIn * 1000);
                console.log(`✅ Token refreshed successfully. Expires in ${expiresIn} seconds`);
                // Reschedule next refresh
                this.scheduleTokenRefresh();
                return this.currentToken;
            }
            else {
                throw new Error(`Failed to refresh token: ${data.error}`);
            }
        }
        catch (error) {
            console.error('Error refreshing token:', error);
            throw error;
        }
    }
    scheduleTokenRefresh() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        // Refresh 30 minutes before expiration
        const refreshIn = this.tokenExpiresAt - Date.now() - (30 * 60 * 1000);
        if (refreshIn > 0) {
            console.log(`Scheduling token refresh in ${Math.round(refreshIn / 1000 / 60)} minutes`);
            this.refreshTimer = setTimeout(() => {
                this.refreshAccessToken().catch(error => {
                    console.error('Failed to refresh token:', error);
                    // Retry in 5 minutes
                    setTimeout(() => this.refreshAccessToken(), 5 * 60 * 1000);
                });
            }, refreshIn);
        }
        else {
            // Token already expired or about to expire, refresh immediately
            this.refreshAccessToken().catch(error => {
                console.error('Failed to refresh token:', error);
            });
        }
    }
    getCurrentToken() {
        return this.currentToken;
    }
    async getValidToken() {
        // Check if token is about to expire (within 30 minutes)
        if (Date.now() > this.tokenExpiresAt - (30 * 60 * 1000)) {
            await this.refreshAccessToken();
        }
        return this.currentToken;
    }
    stop() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
    }
}
exports.SlackTokenManager = SlackTokenManager;
//# sourceMappingURL=token-manager.js.map