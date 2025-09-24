require('dotenv').config();

const express = require('express');
const axios = require('axios');
const pLimit = require('p-limit');

const app = express();

const {
  AXC_BASE,
  AXC_API_TOKEN,
  AXC_WS_TOKEN,
  PORT: PORT_ENV,
  CONCURRENCY_LIMIT: CONCURRENCY_LIMIT_ENV,
  CACHE_TTL_SECONDS: CACHE_TTL_SECONDS_ENV,
} = process.env;

const PORT = Number(PORT_ENV) || 3001;
const CONCURRENCY_LIMIT = Math.max(1, Number(CONCURRENCY_LIMIT_ENV) || 8);
const CACHE_TTL_SECONDS = Math.max(1, Number(CACHE_TTL_SECONDS_ENV) || 25);

const DEFAULT_LOCATIONS = ['Mount Gambier', 'Port Pirie', 'Whyalla'];
const VALID_REVENUE_MODES = new Set(['enrolment', 'invoice']);

if (!AXC_BASE || !AXC_API_TOKEN || !AXC_WS_TOKEN) {
  console.warn('[setup] AXC_BASE, AXC_API_TOKEN, and AXC_WS_TOKEN must be set for upstream requests.');
}

const concurrencyLimiter = pLimit(CONCURRENCY_LIMIT);

const axiosClient = axios.create({
  baseURL: AXC_BASE,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  },
});

if (AXC_API_TOKEN && AXC_WS_TOKEN) {
  const authHeader = Buffer.from(`${AXC_API_TOKEN}:${AXC_WS_TOKEN}`).toString('base64');
  axiosClient.interceptors.request.use((config) => {
    const nextConfig = config;
    nextConfig.headers = nextConfig.headers || {};
    nextConfig.headers.Authorization = `Basic ${authHeader}`;
    return nextConfig;
  });
}

const cacheStore = new Map();

// Serve a simple static demo UI from / (public/index.html)
app.use(express.static('public'));

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/sync', async (req, res) => {
  const { start, end } = req.query;
  const locationsParam = req.query.locations;
  const revenueMode = req.query.revenueMode ? String(req.query.revenueMode).toLowerCase() : 'enrolment';
  const demoFlag = String(req.query.demo || '').toLowerCase();
  const useDemo = demoFlag === '1' || demoFlag === 'true' || (!AXC_BASE || !AXC_API_TOKEN || !AXC_WS_TOKEN);

  if (!isValidDate(start) || !isValidDate(end)) {
    return res.status(400).json({ error: 'start and end must be provided in YYYY-MM-DD format' });
  }

  if (!VALID_REVENUE_MODES.has(revenueMode)) {
    return res.status(400).json({ error: "revenueMode must be 'enrolment' or 'invoice'" });
  }

  const locations = parseLocations(locationsParam);

  // If demo mode, return mock data in the same shape
  if (useDemo) {
    console.log('[sync] demo mode', { start, end, revenueMode, locations });
    const data = buildDemoData(start, end, locations);
    return res.json({
      cached: false,
      updated: new Date().toISOString(),
      range: { start, end },
      data,
    });
  }
  console.log('[sync] live mode', { start, end, revenueMode, locations });
  const cacheKey = buildCacheKey(start, end, locations, revenueMode);
  const cached = getFromCache(cacheKey);

  if (cached) {
    return res.json({
      cached: true,
      updated: cached.updated,
      range: { start, end },
      data: cached.data,
    });
  }

  try {
    const data = {};
    for (const location of locations) {
      const instances = await fetchInstances(location, start, end);
      const cards = await Promise.all(
        instances.map((instance) =>
          buildCard(instance, revenueMode).catch((error) => {
            console.error(`[sync] Failed to build card for instance`, { location, error: sanitiseError(error) });
            return null;
          })
        )
      );
      data[location] = cards.filter(Boolean);
    }

    const updated = new Date().toISOString();
    const payload = {
      cached: false,
      updated,
      range: { start, end },
      data,
    };
    setCache(cacheKey, { data, updated });
    res.json(payload);
  } catch (error) {
    console.error('[sync] Upstream error', sanitiseError(error));
    res.status(getStatusCode(error)).json({ error: 'Failed to synchronise data' });
  }
});

app.listen(PORT, () => {
  console.log(`CITC proxy listening on port ${PORT}`);
});

function buildCacheKey(start, end, locations, revenueMode) {
  return [start, end, locations.join('|'), revenueMode].join('::');
}

function setCache(key, value) {
  cacheStore.set(key, { ...value, expiresAt: Date.now() + CACHE_TTL_SECONDS * 1000 });
}

function getFromCache(key) {
  const entry = cacheStore.get(key);
  if (!entry) {
    return null;
  }
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
  return { data: entry.data, updated: entry.updated };
}

/**
 * Fetch course instances for a location within the provided date range.
 * @param {string} location
 * @param {string} start
 * @param {string} end
 * @returns {Promise<Array<Object>>}
 */
async function fetchInstances(location, start, end) {
  const body = {
    type: 'w',
    location,
    startDate_min: start,
    startDate_max: end,
    purgeCache: true,
    displayLength: 200,
  };

  const response = await requestWithRetry(() => axiosClient.post('/course/instance/search', body));
  return normaliseArrayPayload(response.data);
}

/**
 * Build a dashboard card from an upstream course instance.
 * @param {Object} instance
 * @param {'enrolment'|'invoice'} revenueMode
 * @returns {Promise<Object|null>}
 */
async function buildCard(instance, revenueMode) {
  const instanceID = getInstanceIdentifier(instance);
  if (!instanceID) {
    console.warn('[sync] Skipping instance without identifier');
    return null;
  }

  const { enrolments, enrolmentRevenue, invoiceRevenue } = await fetchEnrolmentInfo(instanceID, revenueMode);

  const trainingCategory =
    pickFirstString(instance, ['TRAININGCATEGORY', 'TRAINING_CATEGORY', 'ACTIVITYNAME', 'COURSETITLE', 'Name']) || 'Unknown';

  const startDate = pickFirstString(instance, ['STARTDATE', 'START', 'START_DATE', 'STARTTIME']) || null;
  const endDate = pickFirstString(instance, ['ENDDATE', 'FINISHDATE', 'END', 'END_DATE', 'FINISHTIME']) || null;

  const numbers =
    pickFirstNumber(instance, ['NUMBERS', 'NUMBER', 'ENROLMENTS', 'TOTALENROLMENTS', 'TOTALENROLLED']) ??
    enrolments.length;

  const capacity = pickFirstNumber(instance, ['CAPACITY', 'MAXPARTICIPANTS', 'MAXENROLMENTS', 'CLASSCAPACITY']) ?? null;

  const revenue =
    revenueMode === 'invoice'
      ? invoiceRevenue ?? enrolmentRevenue
      : enrolmentRevenue;

  return {
    instanceID,
    trainingCategory,
    startDate,
    endDate,
    numbers,
    capacity,
    revenue,
  };
}

/**
 * Fetch enrolments and optional invoice totals for an instance.
 * @param {string|number} instanceID
 * @param {'enrolment'|'invoice'} revenueMode
 */
async function fetchEnrolmentInfo(instanceID, revenueMode) {
  const response = await requestWithRetry(() =>
    concurrencyLimiter(() => axiosClient.get('/course/enrolments', { params: { type: 'w', instanceID } }))
  );
  const enrolments = normaliseArrayPayload(response.data);
  const enrolmentRevenue = enrolments.reduce(
    (total, enrolment) => total + (parseNumber(pickFirstValue(enrolment, ['cost', 'COST', 'Cost', 'FEE', 'AMOUNT'])) || 0),
    0
  );

  let invoiceRevenue = null;

  if (revenueMode === 'invoice') {
    const invoiceIds = collectInvoiceIds(enrolments);
    if (invoiceIds.size > 0) {
      const invoiceTotals = await Promise.all(
        Array.from(invoiceIds).map((invoiceId) =>
          requestWithRetry(() =>
            concurrencyLimiter(() => axiosClient.get(`/accounting/invoice/${encodeURIComponent(invoiceId)}`))
          )
            .then((resp) => invoiceTotalFromPayload(resp.data))
            .catch((error) => {
              console.error('[invoice] Failed to fetch invoice', { invoiceId, error: sanitiseError(error) });
              return null;
            })
        )
      );

      const summed = invoiceTotals
        .filter((val) => typeof val === 'number' && !Number.isNaN(val))
        .reduce((acc, val) => acc + val, 0);
      if (summed > 0) {
        invoiceRevenue = summed;
      }
    }
  }

  return { enrolments, enrolmentRevenue, invoiceRevenue };
}

function collectInvoiceIds(enrolments) {
  const fields = ['invoiceNum', 'InvoiceNum', 'INVOICENUM', 'invoiceID', 'InvoiceID', 'INVOICEID', 'invoiceNumber', 'INVOICENUMBER'];
  const ids = new Set();

  enrolments.forEach((enrolment) => {
    fields.forEach((field) => {
      const value = enrolment[field];
      if (value == null) {
        return;
      }
      if (Array.isArray(value)) {
        value.forEach((item) => addInvoiceId(ids, item));
      } else {
        addInvoiceId(ids, value);
      }
    });
  });

  return ids;
}

function addInvoiceId(set, value) {
  const trimmed = String(value).trim();
  if (trimmed) {
    set.add(trimmed);
  }
}

/**
 * Attempt to derive an invoice total from multiple payload shapes.
 * @param {*} payload
 * @returns {number|null}
 */
function invoiceTotalFromPayload(payload) {
  const candidate = normaliseInvoicePayload(payload);
  if (!candidate) {
    return null;
  }

  const totalFields = ['TOTALAMOUNT', 'TOTAL', 'TOTALGROSS', 'TOTALNET', 'TOTALDUE', 'TOTALPAID', 'GrossTotal', 'NetTotal'];
  for (const field of totalFields) {
    const value = parseNumber(candidate[field]);
    if (value) {
      return value;
    }
  }

  const lines =
    candidate.INVOICELINES ||
    candidate.invoiceLines ||
    candidate.lines ||
    candidate.LINES ||
    candidate.LineItems ||
    candidate.lineItems ||
    candidate.ITEMS ||
    candidate.items ||
    [];

  const lineArray = Array.isArray(lines) ? lines : [];

  const lineSum = lineArray.reduce((sum, line) => sum + deriveLineTotal(line), 0);
  if (lineSum > 0) {
    return lineSum;
  }

  const amount = parseNumber(candidate.AMOUNT || candidate.Amount);
  if (amount) {
    return amount;
  }

  return null;
}

function deriveLineTotal(line) {
  if (!line) {
    return 0;
  }

  const totalFields = ['TOTAL', 'TOTALGROSS', 'LINEAMOUNT', 'LINE_TOTAL', 'EXTENDEDAMOUNT', 'Amount'];
  for (const field of totalFields) {
    const value = parseNumber(line[field]);
    if (value) {
      return value;
    }
  }

  const qty = parseNumber(line.QTY || line.QUANTITY || line.qty || line.quantity) || 1;
  const price =
    parseNumber(line.UNITPRICEGROSS || line.UNITPRICE || line.UNITPRICEINC || line.PRICE || line.Price || line.RATE || line.Rate) ||
    0;

  return qty * price;
}

/**
 * Run a request with retry and exponential backoff for transient issues.
 * @param {() => Promise<*>} factory
 * @param {number} retries
 */
async function requestWithRetry(factory, retries = 2) {
  let attempt = 0;
  let delay = 200;
  while (true) {
    try {
      return await factory();
    } catch (error) {
      const status = error.response?.status;
      const shouldRetry = (!status || status >= 500) && attempt < retries;
      if (!shouldRetry) {
        throw error;
      }
      await wait(delay);
      delay *= 2;
      attempt += 1;
    }
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isValidDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function parseLocations(param) {
  if (!param) {
    return DEFAULT_LOCATIONS.slice();
  }
  const parts = String(param)
    .split('|')
    .map((item) => item.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts : DEFAULT_LOCATIONS.slice();
}

function normaliseArrayPayload(payload) {
  if (!payload) {
    return [];
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  if (Array.isArray(payload.DATA)) {
    return payload.DATA;
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.rows)) {
    return payload.rows;
  }

  if (Array.isArray(payload.results)) {
    return payload.results;
  }

  if (typeof payload === 'object') {
    const firstArray = Object.values(payload).find(Array.isArray);
    if (Array.isArray(firstArray)) {
      return firstArray;
    }
  }

  return [];
}

function normaliseInvoicePayload(payload) {
  if (!payload) {
    return null;
  }

  if (Array.isArray(payload) && payload.length > 0) {
    return payload[0];
  }

  if (payload.DATA) {
    if (Array.isArray(payload.DATA) && payload.DATA.length > 0) {
      return payload.DATA[0];
    }
    if (typeof payload.DATA === 'object' && payload.DATA !== null) {
      return payload.DATA;
    }
  }

  if (payload.data) {
    if (Array.isArray(payload.data) && payload.data.length > 0) {
      return payload.data[0];
    }
    if (typeof payload.data === 'object' && payload.data !== null) {
      return payload.data;
    }
  }

  if (typeof payload === 'object') {
    return payload;
  }

  return null;
}

function getInstanceIdentifier(instance) {
  return (
    instance?.INSTANCEID ??
    instance?.instanceID ??
    instance?.InstanceID ??
    instance?.ID ??
    instance?.id ??
    instance?.InstanceId ??
    null
  );
}

function pickFirstString(object, keys) {
  for (const key of keys) {
    const value = object?.[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function pickFirstNumber(object, keys) {
  for (const key of keys) {
    const num = parseNumber(object?.[key]);
    if (num !== null && !Number.isNaN(num)) {
      return num;
    }
  }
  return null;
}

function pickFirstValue(object, keys) {
  for (const key of keys) {
    if (object && Object.prototype.hasOwnProperty.call(object, key)) {
      return object[key];
    }
  }
  return null;
}

function parseNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const numeric = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function sanitiseError(error) {
  return {
    status: error?.response?.status ?? null,
    message: error?.message ?? 'Unknown error',
  };
}

function getStatusCode(error) {
  const status = error?.response?.status;
  if (status && status >= 400 && status < 600) {
    return status;
  }
  return 502;
}

/**
 * Build demo data that mimics the dashboard cards for the three locations.
 * Dates and values loosely match the example screenshot.
 */
function buildDemoData(start, end, locations) {
  const within = (s) => !s || !end || !start ? true : true; // keep simple for demo
  const sessionRows = [
    { startDate: '2024-04-22', endDate: '2024-04-26', numbers: 3, capacity: 10 },
    { startDate: '2024-10-27', endDate: '2024-10-31', numbers: 8, capacity: 10 },
    { startDate: '2024-11-20', endDate: '2024-11-24', numbers: 10, capacity: 10 },
  ];

  const coursesByLocation = {
    Regency: ['Dogging', 'White Card (General Construction Induction)', 'Forklift'],
    'Mount Gambier': ['Dogging', 'Forklift', 'CN Crane'],
    'Port Pirie': ['Dogging', 'Forklift', 'CN Crane'],
    'Whyalla': ['Skid Steer', 'Forklift', 'Dogging'],
  };

  const priceFull = 1795; // as per screenshot labels

  const result = {};
  for (const loc of locations) {
    const courseList = coursesByLocation[loc] || ['ForkLift'];
    const cards = [];
    let idCounter = 1000;
    for (const course of courseList) {
      for (const row of sessionRows) {
        if (!within(row.startDate)) continue;
        const revenue = row.numbers * priceFull;
        cards.push({
          instanceID: `${loc}-${course}-${idCounter++}`,
          trainingCategory: course,
          startDate: row.startDate,
          endDate: row.endDate,
          numbers: row.numbers,
          capacity: row.capacity,
          revenue,
        });
      }
    }
    result[loc] = cards;
  }
  return result;
}
