# Results, errors and smoke test

## `submitLead` result

`submitLead` always resolves to `{ status, eventId, error? }` — it never throws.

| `status` | Meaning | What to do |
|---|---|---|
| `accepted` | Lead received and routed to the workflow. | Nothing. |
| `unmatched` | Lead received, but no active workflow claims this slug yet. It is stored and reprocessed when the trigger exists. | Ask the team to create/activate the workflow, or check the slug in the URL. |
| `already_processed` | Same `eventId` already received (double click / retry). | Nothing — dedup working. |
| `failed` | Could not confirm delivery. See `error`. | See below. A resubmit reuses the same `eventId`. |

## `error` values on `failed`

| `error` | Cause | Fix |
|---|---|---|
| `invalid_origin` | The page's origin is not in the Events allowlist. Always the case on `localhost`. | Ask the team to add the exact origin (scheme + host; `www.` counts separately). |
| `invalid_payload` | Missing/invalid `email`, or empty `url`. | Check the email field mapping; validate the email before calling. |
| `invalid_json` / `payload_too_large` | Body not JSON or over 10 KB. | Should not happen with the SDK — check that nothing huge is passed as `name`/`phone`. |
| `rate_limited` | More than 30 leads/min from one IP. | Expected during load tests; real visitors never hit it. |
| `http_<status>` | Other HTTP error (e.g. `http_404` = wrong path/host in the trigger URL). | Re-check the URL the team provided. |
| `network_error` | DNS/CORS/offline, or a placeholder URL. | Check the URL; confirm the request in DevTools → Network. |
| `fetch_unavailable` | Running without `fetch` (SSR or very old browser). | Make sure `submitLead` runs in the browser. |

## Nothing is sent at all

- Variable empty in the **deployed build**: on Next.js/Vite/Astro the value is baked at build
  time — after setting it in the hosting panel you must **redeploy**.
- Wrong variable prefix (`NEXT_PUBLIC_`, `VITE_`, `PUBLIC_`) → the browser never sees it.
- Client created inside a server-only file, or `submitLead` called from a server action.

## Production smoke test (for the user, after the team answers and the redeploy)

1. Open the published LP with test UTMs, e.g.
   `https://<lp>/?utm_source=teste&utm_campaign=integracao`.
2. Open DevTools → Network, fill the form with recognizable test data and submit.
3. A `POST` to `/webhooks/leads/<slug>` must appear. Its response should be
   `{"status":"accepted",…}` (or `unmatched` if the workflow is not active yet).
   `403` = origin not allowlisted.
4. Ask the Events team to confirm the lead appeared in Events (and in the destination, e.g. the
   spreadsheet), then delete the test data.
5. Optional honeypot check: in the console run
   `document.querySelector('input[name="website"]').value = "bot"` and submit — the response is
   still `200`, but no lead should appear in Events.
