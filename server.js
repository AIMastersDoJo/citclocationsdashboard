require('dotenv').config();
const express = require('express');
const axios = require('axios');
const qs = require('qs');
const pLimit = require('p-limit');

const app = express();
const limit = pLimit(10);

const {
  AXC_BASE,
  AXC_API_TOKEN,
  AXC_WS_TOKEN,
  PORT: PORT_ENV
} = process.env;

const PORT = Number(PORT_ENV) || 3001;

const axiosClient = axios.create({
  baseURL: AXC_BASE,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
    apitoken: AXC_API_TOKEN,
    wstoken: AXC_WS_TOKEN
  }
});

const CACHE = new Map();
function setCache(key, value, ttl = 3600_000) {
  CACHE.set(key, { value, expires: Date.now() + ttl });
}
function getCache(key) {
  const item = CACHE.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    CACHE.delete(key);
    return null;
  }
  return item.value;
}

app.use(express.static("public"));

// Health
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

/* ----------------------------------------------------------
   1) GET ALL COURSES with type=w & displayLength=1000
---------------------------------------------------------- */
app.get("/api/courses", async (req, res) => {
  const cacheKey = "courses::all";
  const cached = getCache(cacheKey);
  if (cached) {
    return res.json({ cached: true, data: cached });
  }

  try {
    const response = await axiosClient.get('/courses', {
      params: {
        type: 'w',
        displayLength: 1000
      }
    });

    const rows = normalize(response.data);

    const mapped = rows.map(r => ({
      id: r.ID,
      name: r.SHORTDESCRIPTION || r.DESCRIPTION || r.NAME || `Course ${r.ID}`
    }));

    mapped.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" }));

    setCache(cacheKey, mapped, 12 * 3600 * 1000); // 12 hours

    return res.json({ cached: false, data: mapped });

  } catch (err) {
    console.error("[/api/courses] error", err?.message || err);
    res.status(500).json({ error: "Failed to load courses" });
  }
});

/* ----------------------------------------------------------
   2) GET INSTANCES FOR A COURSE (ALL, NO DATE FILTER)
---------------------------------------------------------- */
app.get("/api/course/instances", async (req, res) => {
  const courseID = req.query.courseID;
  if (!courseID) return res.status(400).json({ error: "courseID is required" });

  //const cacheKey = `instances_${courseID}`;
  //const cached = getCache(cacheKey);
  //if (cached) return res.json({ cached: true, data: cached });

  try {
    const r = await limit(() =>
      axiosClient.get("/course/instances", {
        params: {
          id: courseID,
          type: "w"
        }
      })
    );

    const rows = normalize(r.data);

    const mapped = rows.map(inst => {
      return {
        instanceID: inst.INSTANCEID,
        courseName: inst.NAME,
        location: normalizeLocation(inst.LOCATION),
        startDate: (inst.STARTDATE || "").split(" ")[0],
        endDate: (inst.FINISHDATE || "").split(" ")[0],
        capacity: inst.MAXPARTICIPANTS,
        numbers: inst.PARTICIPANTS,
        availableSeats: inst.PARTICIPANTVACANCY,
        cost: inst.COST,
        citb: inst.CUSTOMFIELD_CITB_PRICE 
          ? String(inst.CUSTOMFIELD_CITB_PRICE).replace(/\s+/g, '') 
          : null
      };
    });

    //setCache(cacheKey, mapped, 10 * 60_000);

    res.json({ cached: false, data: mapped });

  } catch (err) {
    console.error("[instances]", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to load instances" });
  }
});

const NORMALIZE_LOCATION = {
  "REGENCY PARK": "Regency Park",
  "REGENCY": "Regency Park",
  "CITC - Regency Park": "Regency Park",

  "PORT PIRIE": "Port Pirie",
  "PIRIE": "Port Pirie",

  "WHYALLA NORRIE": "Whyalla",
  "WHYALLA": "Whyalla",
  "WHYALLA CITY COUNCIL": "Whyalla",

  "MOUNT GAMBIER": "Mount Gambier",
  "GAMBIER": "Mount Gambier"
};

function normalizeLocation(loc) {
  if (!loc) return "Unknown";
  const key = loc.trim().toUpperCase();
  return NORMALIZE_LOCATION[key] || loc;
}

/* ----------------------------------------------------------
   Utility
---------------------------------------------------------- */
function normalize(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.DATA)) return payload.DATA;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.rows)) return payload.rows;
  const arr = Object.values(payload).find(Array.isArray);
  return Array.isArray(arr) ? arr : [];
}


app.listen(PORT, () => {
  console.log("CITC proxy running on port", PORT);
});
