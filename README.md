# CITC Training Dashboard Proxy

Secure Node.js proxy for the Construction Industry Training Centre (CITC) three-location dashboard. The primary CITC highlight colour sampled from [citc.com.au](https://citc.com.au) is `#3569b4`.

## Prerequisites
- Node.js 16 or newer
- Access to an aXcelerate tenant with API credentials

## Setup
1. Install dependencies:
   ```bash
   npm install
   ```
2. Configure environment variables by copying `.env.example`:
   ```bash
   cp .env.example .env              # macOS/Linux
   copy .env.example .env            # Windows PowerShell
   ```
3. Edit `.env` and add your aXcelerate details (`AXC_BASE`, `AXC_API_TOKEN`, `AXC_WS_TOKEN`). Do **not** commit secrets.

## Running the Server
```bash
npm start
```
The server defaults to port `3001` (override with `PORT`).

## Endpoints
- `GET /api/health` – simple readiness probe.
- `GET /api/sync` – fetches course instances and enrolment/invoice data for the specified date range.

### Query Parameters for `/api/sync`
- `start` (required) – `YYYY-MM-DD`
- `end` (required) – `YYYY-MM-DD`
- `locations` (optional) – pipe-separated list of locations; defaults to `Mount Gambier|Port Pirie|Whyalla`
- `revenueMode` (optional) – `enrolment` (default) or `invoice`

### Example Requests
```bash
curl http://localhost:3001/api/health

curl "http://localhost:3001/api/sync?start=2024-04-01&end=2024-04-30&locations=Mount%20Gambier|Port%20Pirie&revenueMode=enrolment"

curl "http://localhost:3001/api/sync?start=2024-04-01&end=2024-04-30&revenueMode=invoice"
```

### Example Response Shape
```json
{
  "cached": false,
  "updated": "2024-04-01T12:34:56.000Z",
  "range": { "start": "2024-04-01", "end": "2024-04-30" },
  "data": {
    "Mount Gambier": [
      {
        "instanceID": "12345",
        "trainingCategory": "Forklift",
        "startDate": "2024-04-22",
        "endDate": "2024-04-26",
        "numbers": 8,
        "capacity": 10,
        "revenue": 14360
      }
    ],
    "Port Pirie": [],
    "Whyalla": []
  }
}
```

## Behaviour Notes
- Responses are cached in-memory for `CACHE_TTL_SECONDS` (default 25s).
- Enrolment and invoice calls are throttled to `CONCURRENCY_LIMIT` parallel requests (default 8).
- `revenueMode=invoice` aggregates line totals when invoices expose unit price/quantity; otherwise the enrolment cost sum is used as a fallback.
- Input validation returns HTTP 400 on malformed dates or unsupported revenue modes; upstream API issues bubble up as 5xx with a generic message.

## Recommended Next Steps
1. Add Redis (or another external store) for cache persistence.
2. Layer authentication (e.g. JWT) before exposing the proxy publicly.
3. Containerise and deploy behind HTTPS with structured logging and monitoring.
