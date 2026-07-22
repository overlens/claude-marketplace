// Package idpm2m obtains and caches an Overlens M2M access token.
//
// OAuth 2.0 client_credentials (RFC 6749 §4.4). No user, no refresh token, no cookies.
// The token lives 5 minutes; this client caches it in memory and refetches at exp - 30s,
// so you do NOT hit POST /auth/token on every outbound request.
//
// Stdlib only (net/http). The cache is guarded by a mutex so concurrent goroutines
// share a single fetch.
package idpm2m

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Client obtains and caches Overlens M2M tokens.
type Client struct {
	IDPBaseURL   string   // e.g. "https://idp.overlens.com.br"
	ClientID     string   // the registered M2M client_id, e.g. "fractals-service"
	ClientSecret string   // from POST /admin/clients (keep in a secret manager)
	Scopes       []string // e.g. []string{"fractals:debit", "fractals:read"}
	HTTP         *http.Client

	// SafetyMargin is how long before exp the token is treated as stale. Default 30s.
	SafetyMargin time.Duration

	mu        sync.Mutex
	token     string
	expiresAt time.Time
}

// GetToken returns a valid Bearer token, fetching a fresh one only when the cache is stale.
func (c *Client) GetToken(ctx context.Context) (string, error) {
	margin := c.SafetyMargin
	if margin == 0 {
		margin = 30 * time.Second
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	if c.token != "" && time.Until(c.expiresAt) > margin {
		return c.token, nil
	}
	return c.fetchToken(ctx)
}

// fetchToken assumes c.mu is held.
func (c *Client) fetchToken(ctx context.Context) (string, error) {
	form := url.Values{"grant_type": {"client_credentials"}}
	// Omit `scope` entirely to receive all the client's allowedScopes.
	if len(c.Scopes) > 0 {
		form.Set("scope", strings.Join(c.Scopes, " "))
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		c.IDPBaseURL+"/auth/token", strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	basic := base64.StdEncoding.EncodeToString([]byte(c.ClientID + ":" + c.ClientSecret))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Authorization", "Basic "+basic)

	httpClient := c.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		// Surface status for diagnostics; never log the secret.
		return "", fmt.Errorf("overlens M2M token request failed: %d %s", resp.StatusCode, body)
	}

	var payload struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int    `json:"expires_in"`
		Scope       string `json:"scope"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return "", err
	}

	c.token = payload.AccessToken
	c.expiresAt = time.Now().Add(time.Duration(payload.ExpiresIn) * time.Second)
	return c.token, nil
}

// Usage:
//
//   idp := &idpm2m.Client{
//       IDPBaseURL:   os.Getenv("IDP_BASE_URL"),
//       ClientID:     os.Getenv("IDP_M2M_CLIENT_ID"),
//       ClientSecret: os.Getenv("IDP_M2M_CLIENT_SECRET"),
//       Scopes:       strings.Split(os.Getenv("IDP_M2M_SCOPES"), ","),
//   }
//
//   token, err := idp.GetToken(ctx)
//   if err != nil { /* handle */ }
//   req, _ := http.NewRequestWithContext(ctx, http.MethodPost, apiURL+"/fractals/debit", body)
//   req.Header.Set("Authorization", "Bearer "+token)
