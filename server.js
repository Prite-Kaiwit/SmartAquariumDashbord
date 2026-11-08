require('dotenv').config();

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'db.json');
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || 'smart_aquarium';
const AQUARIUM_DEVICE_ID = process.env.AQUARIUM_DEVICE_ID || 'aquarium-1';
const READING_INTERVAL_MS = process.env.READING_INTERVAL_MS ? parseInt(process.env.READING_INTERVAL_MS, 10) : 30 * 1000; // บันทึกลง database ทุก 30 วินาที
const MAX_LOCAL_READINGS = 7 * 24 * 60;
const TELEGRAM_NOTIFICATION_TYPES = ["LOW", "HIGH", "SENSOR_ERROR", "OFFLINE"];
const IS_VERCEL = process.env.VERCEL === '1';
const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;
const requestContext = new AsyncLocalStorage();

app.use(cors());
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(__dirname));

// Serve index.html for root route
app.get('/', (req, res) => {
  const publicIndexPath = path.join(__dirname, 'public', 'index.html');
  const rootIndexPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(publicIndexPath)) {
    return res.sendFile(publicIndexPath);
  }
  if (fs.existsSync(rootIndexPath)) {
    return res.sendFile(rootIndexPath);
  }
  res.sendFile(path.resolve('index.html'));
});

// Default In-Memory / File Database State
let dbFallback = {
  settings: {
    esp32ApiKey: "",
    telegramBotToken: "",
    telegramChatId: "",
    telegramEnabled: false,
    telegramNotificationTypes: TELEGRAM_NOTIFICATION_TYPES,
    pollingIntervalSec: 3,
    offlineTimeoutSec: 60
  },
  thresholds: {
    ph: { min: 6.5, max: 8.0, hysteresis: 0.1, cooldownMin: 10, unit: "-" },
    temp: { min: 24.0, max: 30.0, hysteresis: 0.5, cooldownMin: 10, unit: "°C" },
    tds: { min: 100, max: 400, hysteresis: 10, cooldownMin: 10, unit: "ppm" },
    turbidity: { min: null, max: 2500, hysteresis: 50, cooldownMin: 10, unit: "ADC" }
  },
  devices: {
    light: {
      name: "light",
      actualState: "ON",
      desiredState: "ON",
      mode: "schedule",
      schedule: { startTime: "08:00", endTime: "18:00", days: [0, 1, 2, 3, 4, 5, 6] },
      lastChangeAt: new Date().toISOString()
    },
    heater: {
      name: "heater",
      actualState: "OFF",
      desiredState: "OFF",
      mode: "auto",
      targetTemp: 26.0,
      hysteresis: 0.5,
      maxOnMinutes: 120,
      accumulatedMinsToday: 45,
      lastChangeAt: new Date().toISOString()
    }
  },
  latest: {
    ph: 0,
    temp: 0,
    tds: 0,
    turbidityRaw: 0,
    sensorOk: { ph: false, temp: false, tds: false, turbidity: false },
    rssi: null,
    uptimeSec: null,
    status: "OFFLINE",
    lastSeen: null,
    latencyMs: null
  },
  pendingCommands: [],
  readings: [],
  pendingReadings: [],
  alerts: [],
  commands: []
};

function currentDb() {
  return requestContext.getStore()?.db || dbFallback;
}

const db = new Proxy(Object.create(null), {
  get(_target, property) {
    return currentDb()[property];
  },
  set(_target, property, value) {
    currentDb()[property] = value;
    return true;
  }
});

// Load database if file exists
if (!IS_VERCEL && fs.existsSync(DB_FILE)) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    dbFallback = { ...dbFallback, ...loaded };
    console.log('[Database] Loaded state from db.json');
  } catch (err) {
    console.error('[Database] Error loading db.json, using defaults:', err.message);
  }
}

if (!Array.isArray(dbFallback.pendingReadings)) dbFallback.pendingReadings = [];
if (process.env.ESP32_API_KEY) {
  dbFallback.settings.esp32ApiKey = process.env.ESP32_API_KEY;
}

let shouldMigrateSettings = false;
if (dbFallback.settings.telegramBotToken && dbFallback.settings.telegramBotToken.includes("...")) {
  dbFallback.settings.telegramBotToken = "";
  dbFallback.settings.telegramEnabled = false;
  if (dbFallback.settings.telegramChatId === "987654321") dbFallback.settings.telegramChatId = "";
  shouldMigrateSettings = true;
}
if (!Array.isArray(dbFallback.settings.telegramNotificationTypes)) {
  dbFallback.settings.telegramNotificationTypes = TELEGRAM_NOTIFICATION_TYPES;
  shouldMigrateSettings = true;
}
if (!dbFallback.settings.telegramBotToken || !dbFallback.settings.telegramChatId) {
  if (dbFallback.settings.telegramEnabled) shouldMigrateSettings = true;
  dbFallback.settings.telegramEnabled = false;
}
dbFallback.alerts.forEach(alert => {
  if (alert.notifyStatus === undefined) {
    alert.notifySent = false;
    alert.notifyStatus = "disabled";
    shouldMigrateSettings = true;
  }
});

function saveDB() {
  if (IS_VERCEL) {
    const context = requestContext.getStore();
    if (context) context.dirty = true;
    return Boolean(context);
  }

  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(currentDb(), null, 2));
    return true;
  } catch (err) {
    console.error('[Database] Save error:', err.message);
    return false;
  }
}

if (shouldMigrateSettings) saveDB();

let mongoClient = null;
let readingsCollection = null;
let appStateCollection = null;
let mongoConnected = false;
let databaseInitializationPromise = null;
let lastPersistedReadingAt = 0;
let lastReadingAttemptAt = 0;
let lastPersistenceError = null;

function mergeState(defaults, stored) {
  return {
    ...defaults,
    ...stored,
    settings: { ...defaults.settings, ...stored.settings },
    thresholds: { ...defaults.thresholds, ...stored.thresholds },
    devices: { ...defaults.devices, ...stored.devices },
    latest: { ...defaults.latest, ...stored.latest }
  };
}

async function persistCloudState(context) {
  const result = await appStateCollection.replaceOne(
    { _id: 'main', revision: context.revision },
    { _id: 'main', revision: context.revision + 1, data: context.db }
  );
  if (result.matchedCount !== 1) {
    throw new Error('Application state changed concurrently; retry the request');
  }
  context.revision += 1;
}

async function initializeCloudState(mongoDb) {
  appStateCollection = mongoDb.collection('app_state');
  let stateDocument = await appStateCollection.findOne({ _id: 'main' });
  if (!stateDocument) {
    try {
      const initialState = mergeState(dbFallback, {});
      initialState.settings.esp32ApiKey = '';
      await appStateCollection.insertOne({ _id: 'main', revision: 1, data: initialState });
      stateDocument = { revision: 1, data: initialState };
    } catch (err) {
      if (err.code !== 11000) throw err;
      stateDocument = await appStateCollection.findOne({ _id: 'main' });
    }
  }
  if (!stateDocument) throw new Error('Could not initialize persistent application state');
  if (stateDocument.data.settings?.esp32ApiKey) {
    await appStateCollection.updateOne(
      { _id: 'main' },
      { $unset: { 'data.settings.esp32ApiKey': '' } }
    );
    delete stateDocument.data.settings.esp32ApiKey;
  }
  dbFallback = mergeState(dbFallback, stateDocument.data);
  dbFallback.settings.esp32ApiKey = '';
}

async function ensureDatabaseInitialized() {
  if (!databaseInitializationPromise) {
    databaseInitializationPromise = initializeDatabase().catch((err) => {
      databaseInitializationPromise = null;
      throw err;
    });
  }
  return databaseInitializationPromise;
}

function secureEquals(received, expected) {
  if (typeof received !== 'string' || typeof expected !== 'string') return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

app.use('/api', async (req, res, next) => {
  try {
    await ensureDatabaseInitialized();

    let context;
    if (IS_VERCEL) {
      const stateDocument = await appStateCollection.findOne({ _id: 'main' });
      if (!stateDocument) throw new Error('Persistent application state is unavailable');
      const requestDb = mergeState(dbFallback, stateDocument.data);
      requestDb.settings.esp32ApiKey = '';
      context = {
        db: requestDb,
        revision: stateDocument.revision,
        dirty: false
      };
    } else {
      context = { db: dbFallback, revision: null, dirty: false };
    }

    const sendJson = res.json.bind(res);
    res.json = (body) => {
      if (!IS_VERCEL || !context.dirty) return sendJson(body);
      persistCloudState(context)
        .then(() => sendJson(body))
        .catch((err) => {
          console.error(`[Database] Could not persist application state: ${err.message}`);
          if (!res.headersSent) {
            res.status(503);
            sendJson({ success: false, error: 'Could not save application state; retry the request' });
          }
        });
      return res;
    };

    const safeMethod = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
    const isEsp32Ingest = req.method === 'POST' && req.path === '/readings';
    const isProtectedSettingsRead = req.method === 'GET' && req.path === '/settings';
    if ((!safeMethod || isProtectedSettingsRead) && !isEsp32Ingest && (IS_VERCEL || DASHBOARD_API_KEY)) {
      const receivedKey = req.headers['x-dashboard-api-key'];
      if (!DASHBOARD_API_KEY || !secureEquals(receivedKey, DASHBOARD_API_KEY)) {
        return res.status(401).json({ success: false, error: 'Dashboard API key is missing or invalid' });
      }
    }

    requestContext.run(context, next);
  } catch (err) {
    console.error(`[Database] Could not prepare API request: ${err.message}`);
    res.status(503).json({ success: false, error: 'API database is unavailable' });
  }
});

async function writeMongoReading(reading) {
  const document = { ...reading, ts: new Date(reading.ts) };
  await readingsCollection.updateOne(
    { deviceId: AQUARIUM_DEVICE_ID, ts: document.ts },
    { $setOnInsert: document },
    { upsert: true }
  );
}

async function isMongoOnline() {
  if (!mongoClient) return false;
  try {
    await mongoClient.db(MONGODB_DB).command({ ping: 1 });
    mongoConnected = true;
    return true;
  } catch (err) {
    mongoConnected = false;
    return false;
  }
}

async function flushPendingReadings() {
  if (db.pendingReadings.length === 0) return;

  const queuedReadings = db.pendingReadings;
  await readingsCollection.bulkWrite(queuedReadings.map(reading => {
    const document = { ...reading, deviceId: AQUARIUM_DEVICE_ID, ts: new Date(reading.ts) };
    return {
      updateOne: {
        filter: { deviceId: AQUARIUM_DEVICE_ID, ts: document.ts },
        update: { $setOnInsert: document },
        upsert: true
      }
    };
  }));
  db.pendingReadings = [];
  if (!saveDB()) {
    db.pendingReadings = queuedReadings;
    throw new Error('Could not clear the local MongoDB reading queue');
  }
  console.log(`[Database] Replayed ${queuedReadings.length} queued readings to MongoDB.`);
}

async function initializeDatabase() {
  if (IS_VERCEL && !MONGODB_URI) {
    throw new Error('MONGODB_URI must be configured for Vercel deployments');
  }
  if (IS_VERCEL && !process.env.ESP32_API_KEY) {
    throw new Error('ESP32_API_KEY must be configured for Vercel deployments');
  }
  if (IS_VERCEL && !DASHBOARD_API_KEY) {
    throw new Error('DASHBOARD_API_KEY must be configured for Vercel deployments');
  }

  if (!MONGODB_URI) {
    if (db.pendingReadings.length > 0) {
      db.readings.push(...db.pendingReadings);
      db.pendingReadings = [];
      if (db.readings.length > MAX_LOCAL_READINGS) {
        db.readings = db.readings.slice(-MAX_LOCAL_READINGS);
      }
      if (!saveDB()) throw new Error('Could not restore queued readings to local history');
    }
    const lastLocalReading = db.readings[db.readings.length - 1];
    if (lastLocalReading) {
      lastPersistedReadingAt = Date.parse(lastLocalReading.ts) || 0;
      lastReadingAttemptAt = lastPersistedReadingAt;
    }
    console.log('[Database] MONGODB_URI is not set; using db.json for readings.');
    return;
  }

  mongoClient = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  try {
    await mongoClient.connect();
    const mongoDb = mongoClient.db(MONGODB_DB);
    readingsCollection = mongoDb.collection('readings');
    await readingsCollection.createIndex({ deviceId: 1, ts: 1 });
    if (IS_VERCEL) {
      await initializeCloudState(mongoDb);
    } else {
      await flushPendingReadings();
    }

    const existingCount = await readingsCollection.countDocuments({ deviceId: AQUARIUM_DEVICE_ID });
    if (existingCount === 0 && db.readings.length > 0) {
      const legacyReadings = db.readings
        .filter(reading => Number.isFinite(Date.parse(reading.ts)))
        .map(reading => ({
          updateOne: {
            filter: { deviceId: AQUARIUM_DEVICE_ID, ts: new Date(reading.ts) },
            update: {
              $setOnInsert: {
                ...reading,
                deviceId: AQUARIUM_DEVICE_ID,
                ts: new Date(reading.ts)
              }
            },
            upsert: true
          }
        }));
      if (legacyReadings.length > 0) {
        await readingsCollection.bulkWrite(legacyReadings);
        console.log(`[Database] Imported ${legacyReadings.length} legacy readings into MongoDB.`);
      }
    }

    const lastReading = await readingsCollection.findOne(
      { deviceId: AQUARIUM_DEVICE_ID },
      { sort: { ts: -1 }, projection: { ts: 1 } }
    );
    if (lastReading) {
      lastPersistedReadingAt = new Date(lastReading.ts).getTime();
      lastReadingAttemptAt = lastPersistedReadingAt;
    }
    mongoConnected = true;
    console.log(`[Database] Connected to MongoDB database "${MONGODB_DB}".`);
  } catch (err) {
    mongoConnected = false;
    if (IS_VERCEL) throw err;
    const mongoDb = mongoClient.db(MONGODB_DB);
    readingsCollection = mongoDb.collection('readings');
    console.warn(`[Database] Initial MongoDB connection failed: ${err.message}. Database marked offline; data sending is stopped.`);
  }
}

async function persistReadingIfDue(now) {
  const nowMs = now.getTime();
  if (nowMs - lastPersistedReadingAt < READING_INTERVAL_MS) {
    return {
      provider: readingsCollection ? 'mongodb' : 'json',
      status: 'waiting',
      nextDueInSec: Math.ceil((READING_INTERVAL_MS - (nowMs - lastPersistedReadingAt)) / 1000)
    };
  }

  const reading = {
    deviceId: AQUARIUM_DEVICE_ID,
    ts: now,
    ph: db.latest.ph,
    temp: db.latest.temp,
    tds: db.latest.tds,
    turbidityRaw: db.latest.turbidityRaw,
    sensorOk: { ...db.latest.sensorOk },
    rssi: db.latest.rssi,
    uptimeSec: db.latest.uptimeSec,
    status: db.latest.status,
    lastSeen: db.latest.lastSeen,
    latencyMs: db.latest.latencyMs
  };

  lastReadingAttemptAt = nowMs;

  // MongoDB mode
  if (readingsCollection) {
    // If database is offline, check connection; if still offline, STOP sending data!
    if (!mongoConnected) {
      const isOnline = await isMongoOnline();
      if (!isOnline) {
        console.warn('[Database] MongoDB is offline. Stopped sending data to database.');
        return {
          provider: 'mongodb',
          status: 'offline',
          saved: false,
          message: 'Database is offline; data sending is stopped.'
        };
      }
    }

    try {
      if (db.pendingReadings.length > 0) {
        await flushPendingReadings();
      }
      await writeMongoReading(reading);
      mongoConnected = true;
      lastPersistedReadingAt = nowMs;
      lastPersistenceError = null;
      return { provider: 'mongodb', status: 'stored', saved: true };
    } catch (err) {
      mongoConnected = false;
      lastPersistenceError = err;
      console.error(`[Database] MongoDB offline during write: ${err.message}. Stopped sending data to database.`);
      return {
        provider: 'mongodb',
        status: 'offline',
        saved: false,
        message: 'Database went offline; stopped sending data.',
        error: err.message
      };
    }
  } else {
    // Local JSON fallback (only when MONGODB_URI is not configured)
    db.readings.push({ ...reading, ts: now.toISOString() });
    const discardedReading = db.readings.length > MAX_LOCAL_READINGS ? db.readings.shift() : null;
    if (!saveDB()) {
      db.readings.pop();
      if (discardedReading) db.readings.unshift(discardedReading);
      throw new Error('Could not write reading to db.json');
    }
    lastPersistedReadingAt = nowMs;
    lastPersistenceError = null;
    return { provider: 'json', status: 'stored', saved: true };
  }
}

function getPublicSettings() {
  const { telegramBotToken, esp32ApiKey, ...settings } = db.settings;
  return {
    ...settings,
    telegramBotTokenConfigured: Boolean(telegramBotToken)
  };
}

async function sendTelegramMessage(text) {
  const { telegramBotToken, telegramChatId } = db.settings;
  if (!telegramBotToken || !telegramChatId) {
    throw new Error("Telegram Bot Token or Chat ID is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IS_VERCEL ? 4000 : 8000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: telegramChatId, text }),
      signal: controller.signal
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.description || `Telegram API returned HTTP ${response.status}`);
    }
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendTelegramAlert(alert) {
  const { telegramEnabled, telegramNotificationTypes } = db.settings;
  if (!telegramEnabled || !telegramNotificationTypes.includes(alert.type)) {
    alert.notifyStatus = "disabled";
    saveDB();
    return;
  }

  const text = [
    "🚨 แจ้งเตือนคุณภาพน้ำ",
    `ประเภท: ${alert.type}`,
    `พารามิเตอร์: ${alert.parameter}`,
    `ค่าที่วัดได้: ${alert.value}`,
    `เกณฑ์: ${alert.thresholdMin ?? "-"} ถึง ${alert.thresholdMax ?? "-"}`,
    `รายละเอียด: ${alert.message}`,
    `เวลา: ${new Date(alert.ts).toLocaleString("th-TH")}`
  ].join("\n");

  try {
    await sendTelegramMessage(text);
    alert.notifySent = true;
    alert.notifyStatus = "sent";
    saveDB();
    console.log(`[Telegram] Alert ${alert.id} sent`);
  } catch (err) {
    alert.notifySent = false;
    alert.notifyStatus = "failed";
    saveDB();
    console.error(`[Telegram] Alert ${alert.id} failed: ${err.message}`);
  }
}

// ----------------------------------------------------------------
// 1. HARDWARE ENDPOINT (ESP32 Polling & Command Queue)
// ----------------------------------------------------------------
app.post('/api/readings', async (req, res) => {
  const apiKey = req.headers['x-api-key'];
  const expectedApiKey = process.env.ESP32_API_KEY || db.settings.esp32ApiKey;
  const dashboardKey = req.headers['x-dashboard-api-key'];
  if (!expectedApiKey) {
    return res.status(503).json({ success: false, error: "ESP32 API key is not configured" });
  }
  if (!secureEquals(apiKey, expectedApiKey) && !secureEquals(dashboardKey, DASHBOARD_API_KEY)) {
    return res.status(401).json({ success: false, error: "Invalid API Key" });
  }

  const payload = req.body || {};
  const now = new Date();

  // Update latest readings
  db.latest = {
    ph: typeof payload.ph === 'number' ? payload.ph : db.latest.ph,
    temp: typeof payload.temp === 'number' ? payload.temp : db.latest.temp,
    tds: typeof payload.tds === 'number' ? payload.tds : db.latest.tds,
    turbidityRaw: typeof payload.turbidityRaw === 'number' ? payload.turbidityRaw : db.latest.turbidityRaw,
    sensorOk: payload.sensorOk || db.latest.sensorOk,
    rssi: payload.rssi || -65,
    uptimeSec: payload.uptimeSec || db.latest.uptimeSec + 3,
    lastSeen: now.toISOString(),
    latencyMs: Math.floor(Math.random() * 20) + 30
  };

  // Sync actual state if reported by ESP32
  if (payload.actualStates) {
    if (payload.actualStates.light) db.devices.light.actualState = payload.actualStates.light;
    if (payload.actualStates.heater) db.devices.heater.actualState = payload.actualStates.heater;
  }

  // Evaluate Safety Interlocks
  await evaluateSafetyAndControl(now);

  let storage;
  try {
    storage = await persistReadingIfDue(now);
  } catch (err) {
    console.error(`[Database] Could not persist sensor reading: ${err.message}`);
    storage = {
      provider: readingsCollection ? 'mongodb' : 'json',
      status: 'offline',
      saved: false,
      error: err.message
    };
  }

  // Collect pending commands for ESP32
  const commandsToDispatch = [...db.pendingCommands];
  db.pendingCommands = [];

  saveDB();

  res.json({
    success: true,
    serverTime: now.toISOString(),
    pollingIntervalSec: db.settings.pollingIntervalSec,
    commands: commandsToDispatch,
    storage
  });
});

// Safety Engine Logic
async function evaluateSafetyAndControl(now) {
  const l = db.latest;
  const th = db.thresholds;
  const heater = db.devices.heater;
  const sensorErrors = ["temp", "ph", "tds"].filter(parameter => !l.sensorOk[parameter]);
  let hasOutOfRangeReading = false;
  const alertTasks = [];

  sensorErrors.forEach(parameter => {
    alertTasks.push(createAlert(parameter, l[parameter], th[parameter].min, th[parameter].max, "SENSOR_ERROR", `เซนเซอร์ ${parameter.toUpperCase()} ขัดข้อง`));
  });

  if (sensorErrors.length > 0) {
    if (heater.actualState === "ON" || heater.desiredState === "ON") {
      heater.actualState = "OFF";
      heater.desiredState = "OFF";
      db.pendingCommands.push({ device: "heater", command: "OFF", reason: "SENSOR_ERROR" });
      addCommandLog("heater", "OFF", "failsafe", "BLOCKED: เซนเซอร์เสีย สั่งตัดฮีตเตอร์ทันที");
    }
  }

  const temperatureValid = l.sensorOk.temp;
  const overheat = temperatureValid && l.temp >= 30.0;
  if (overheat) {
    if (heater.actualState === "ON" || heater.desiredState === "ON") {
      heater.actualState = "OFF";
      heater.desiredState = "OFF";
      db.pendingCommands.push({ device: "heater", command: "OFF", reason: "OVERHEAT_EMERGENCY" });
      addCommandLog("heater", "OFF", "failsafe", "BLOCKED: Overheat Emergency (Temp >= 30°C)");
    }
  }

  if (temperatureValid && !overheat && sensorErrors.length === 0 && heater.mode === "auto") {
    const lowBound = heater.targetTemp - heater.hysteresis;
    const highBound = heater.targetTemp + heater.hysteresis;

    if (l.temp < lowBound && heater.desiredState !== "ON") {
      heater.desiredState = "ON";
      heater.actualState = "ON";
      db.pendingCommands.push({ device: "heater", command: "ON", reason: "AUTO_TEMP_LOW" });
      addCommandLog("heater", "ON", "auto", `อุณหภูมิต่ำกว่า ${lowBound.toFixed(1)}°C เปิดฮีตเตอร์`);
    } else if (l.temp >= highBound && heater.desiredState !== "OFF") {
      heater.desiredState = "OFF";
      heater.actualState = "OFF";
      db.pendingCommands.push({ device: "heater", command: "OFF", reason: "AUTO_TEMP_REACHED" });
      addCommandLog("heater", "OFF", "auto", `อุณหภูมิถึงเป้าหมาย ${highBound.toFixed(1)}°C ปิดฮีตเตอร์`);
    }
  }

  const parameters = [
    { key: "temp", label: "อุณหภูมิ" },
    { key: "ph", label: "pH" },
    { key: "tds", label: "TDS" }
  ];
  parameters.forEach(({ key, label }) => {
    if (!l.sensorOk[key]) return;

    const value = l[key];
    const threshold = th[key];
    if (threshold.min !== null && value < threshold.min) {
      hasOutOfRangeReading = true;
      alertTasks.push(createAlert(key, value, threshold.min, threshold.max, "LOW", `${label} ต่ำกว่าเกณฑ์ที่กำหนด`));
    } else if (value > threshold.max) {
      hasOutOfRangeReading = true;
      const message = key === "temp" && overheat
        ? "อุณหภูมิน้ำสูงแตะ 30°C"
        : `${label} สูงกว่าเกณฑ์ที่กำหนด`;
      alertTasks.push(createAlert(key, value, threshold.min, threshold.max, "HIGH", message));
    }
  });

  l.status = sensorErrors.length > 0
    ? "SENSOR_ERROR"
    : hasOutOfRangeReading
      ? "ABNORMAL"
      : "NORMAL";
  await Promise.all(alertTasks);
}

async function createAlert(param, val, min, max, type, msg) {
  const tenMinsAgo = Date.now() - 600000;
  const recent = db.alerts.find(a => a.parameter === param && a.type === type && new Date(a.ts).getTime() > tenMinsAgo);
  if (recent) return; // Cooldown

  const alert = {
    id: "alt-" + Date.now(),
    ts: new Date().toISOString(),
    parameter: param,
    value: val,
    thresholdMin: min,
    thresholdMax: max,
    type: type,
    message: msg,
    acknowledged: false,
    notifySent: false,
    notifyStatus: "pending"
  };
  db.alerts.unshift(alert);
  await sendTelegramAlert(alert);
}

function addCommandLog(device, cmd, source, reason) {
  db.commands.unshift({
    id: "cmd-" + Date.now(),
    ts: new Date().toISOString(),
    device: device,
    command: cmd,
    source: source,
    result: reason.includes("BLOCKED") ? "BLOCKED" : "SUCCESS",
    reason: reason
  });
}

// ----------------------------------------------------------------
// 2. WEB CLIENT REST ENDPOINTS
// ----------------------------------------------------------------

// Latest Readings
app.get('/api/readings/latest', async (req, res) => {
  // Check heartbeat timeout (60s)
  const diffSec = (Date.now() - new Date(db.latest.lastSeen).getTime()) / 1000;
  if (diffSec > db.settings.offlineTimeoutSec && db.latest.status !== "OFFLINE") {
    db.latest.status = "OFFLINE";
    await createAlert("system", Math.floor(diffSec), null, db.settings.offlineTimeoutSec, "OFFLINE", "ไม่ได้รับข้อมูลจาก ESP32 เกินเวลาที่กำหนด");
    saveDB();
  }
  res.json({ success: true, data: db.latest });
});

// Historical Readings
app.get('/api/readings', async (req, res) => {
  const range = ['1h', '24h', '7d'].includes(req.query.range) ? req.query.range : '1h';
  const rangeMs = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': 7 * 24 * 60 * 60 * 1000 }[range];
  const cutoff = new Date(Date.now() - rangeMs);

  try {
    let readings;
    if (readingsCollection) {
      if (!mongoConnected) {
        return res.status(503).json({ success: false, error: "MongoDB is not connected" });
      }
      readings = await readingsCollection
        .find({ deviceId: AQUARIUM_DEVICE_ID, ts: { $gte: cutoff } }, { projection: { _id: 0, deviceId: 0 } })
        .sort({ ts: 1 })
        .toArray();
    } else {
      readings = db.readings.filter(reading => new Date(reading.ts) >= cutoff);
    }
    res.json({
      success: true,
      range,
      data: readings.map(reading => ({
        ...reading,
        ts: new Date(reading.ts).toISOString()
      }))
    });
  } catch (err) {
    if (readingsCollection) mongoConnected = false;
    console.error(`[Database] Could not load historical readings: ${err.message}`);
    res.status(503).json({ success: false, error: "Could not load historical readings from the database" });
  }
});

app.get('/api/health', async (req, res) => {
  let isDbOnline = mongoConnected;
  if (readingsCollection) {
    isDbOnline = await isMongoOnline();
  }
  res.json({
    success: true,
    database: {
      provider: readingsCollection ? 'mongodb' : 'json',
      status: readingsCollection ? (isDbOnline ? 'connected' : 'offline') : 'active',
      databaseName: readingsCollection ? MONGODB_DB : 'db.json',
      intervalSec: READING_INTERVAL_MS / 1000,
      sendingPausedWhenOffline: true
    }
  });
});

// Thresholds
app.get('/api/thresholds', (req, res) => {
  res.json({ success: true, data: db.thresholds });
});

app.put('/api/thresholds', (req, res) => {
  const { parameter, min, max, hysteresis, cooldownMin } = req.body;
  if (parameter && db.thresholds[parameter]) {
    if (min !== undefined) db.thresholds[parameter].min = min;
    if (max !== undefined) db.thresholds[parameter].max = max;
    if (hysteresis !== undefined) db.thresholds[parameter].hysteresis = hysteresis;
    if (cooldownMin !== undefined) db.thresholds[parameter].cooldownMin = cooldownMin;
    saveDB();
    return res.json({ success: true, data: db.thresholds });
  }
  res.status(400).json({ success: false, error: "Invalid parameter" });
});

app.post('/api/thresholds/reset', (req, res) => {
  db.thresholds = {
    ph: { min: 6.5, max: 8.0, hysteresis: 0.1, cooldownMin: 10, unit: "-" },
    temp: { min: 24.0, max: 30.0, hysteresis: 0.5, cooldownMin: 10, unit: "°C" },
    tds: { min: 100, max: 400, hysteresis: 10, cooldownMin: 10, unit: "ppm" },
    turbidity: { min: null, max: 2500, hysteresis: 50, cooldownMin: 10, unit: "ADC" }
  };
  saveDB();
  res.json({ success: true, message: "Reset to defaults", data: db.thresholds });
});

// Alerts
app.get('/api/alerts', (req, res) => {
  res.json({ success: true, count: db.alerts.length, data: db.alerts });
});

app.patch('/api/alerts/:id/ack', (req, res) => {
  const item = db.alerts.find(a => a.id === req.params.id);
  if (item) {
    const previousAcknowledged = item.acknowledged;
    const previousAcknowledgedAt = item.acknowledgedAt;
    item.acknowledged = true;
    item.acknowledgedAt = new Date().toISOString();
    if (!saveDB()) {
      item.acknowledged = previousAcknowledged;
      if (previousAcknowledgedAt === undefined) delete item.acknowledgedAt;
      else item.acknowledgedAt = previousAcknowledgedAt;
      return res.status(500).json({ success: false, error: "Could not save alert acknowledgement" });
    }
    return res.json({ success: true, data: item });
  }
  res.status(404).json({ success: false, error: "Alert not found" });
});

app.patch('/api/alerts/acknowledge-all', (req, res) => {
  const acknowledgedAt = new Date().toISOString();
  const unacknowledged = db.alerts.filter(alert => !alert.acknowledged);
  unacknowledged.forEach(alert => {
    alert.acknowledged = true;
    alert.acknowledgedAt = acknowledgedAt;
  });
  if (unacknowledged.length > 0 && !saveDB()) {
    unacknowledged.forEach(alert => {
      alert.acknowledged = false;
      delete alert.acknowledgedAt;
    });
    return res.status(500).json({ success: false, error: "Could not save alert acknowledgements" });
  }
  res.json({ success: true, count: unacknowledged.length });
});

app.get('/api/alerts/export-csv', (req, res) => {
  let csv = "Timestamp,Parameter,Value,Threshold_Min,Threshold_Max,Type,Message,Acknowledged,Notify_Sent\n";
  db.alerts.forEach(a => {
    csv += `"${a.ts}","${a.parameter}",${a.value},${a.thresholdMin || ''},${a.thresholdMax || ''},"${a.type}","${a.message}",${a.acknowledged},${a.notifySent}\n`;
  });
  res.header('Content-Type', 'text/csv');
  res.attachment(`aquarium_alerts_${new Date().toISOString().slice(0, 10)}.csv`);
  res.send(csv);
});

// Devices (Relays)
app.get('/api/devices', (req, res) => {
  res.json({ success: true, data: db.devices });
});

app.post('/api/devices/:name/command', (req, res) => {
  const name = req.params.name;
  const { command } = req.body;

  if (!db.devices[name]) return res.status(404).json({ success: false, error: "Device not found" });

  if (name === 'heater' && command === 'ON') {
    if (db.latest.temp >= 30.0) {
      addCommandLog("heater", "ON", "manual", "BLOCKED: Overheat Emergency (Temp >= 30°C)");
      return res.status(400).json({ success: false, error: "BLOCKED: Temperature >= 30°C" });
    }
  }

  db.devices[name].desiredState = command;
  db.devices[name].actualState = command;
  db.devices[name].lastChangeAt = new Date().toISOString();

  db.pendingCommands.push({ device: name, command: command, reason: "MANUAL_WEB_COMMAND" });
  addCommandLog(name, command, "manual", "ผู้ดูแลระบบสั่งงานผ่านหน้าเว็บ");

  saveDB();
  res.json({ success: true, device: name, state: command });
});

app.put('/api/devices/:name/config', (req, res) => {
  const name = req.params.name;
  if (!db.devices[name]) return res.status(404).json({ success: false, error: "Device not found" });

  db.devices[name] = { ...db.devices[name], ...req.body };
  saveDB();
  res.json({ success: true, data: db.devices[name] });
});

app.get('/api/commands', (req, res) => {
  res.json({ success: true, count: db.commands.length, data: db.commands.slice(0, 50) });
});

// Settings & Telegram Test
app.get('/api/settings', (req, res) => {
  res.json({ success: true, data: getPublicSettings() });
});

app.put('/api/settings', (req, res) => {
  const { telegramBotToken, telegramChatId, telegramEnabled, telegramNotificationTypes } = req.body || {};
  if (telegramBotToken !== undefined && typeof telegramBotToken !== "string") {
    return res.status(400).json({ success: false, error: "Telegram Bot Token must be a string" });
  }
  if (telegramChatId !== undefined && typeof telegramChatId !== "string") {
    return res.status(400).json({ success: false, error: "Telegram Chat ID must be a string" });
  }
  if (telegramEnabled !== undefined && typeof telegramEnabled !== "boolean") {
    return res.status(400).json({ success: false, error: "Telegram enabled flag must be boolean" });
  }
  if (telegramNotificationTypes !== undefined &&
      (!Array.isArray(telegramNotificationTypes) ||
       telegramNotificationTypes.some(type => !TELEGRAM_NOTIFICATION_TYPES.includes(type)))) {
    return res.status(400).json({ success: false, error: "Invalid Telegram notification types" });
  }

  const nextToken = typeof telegramBotToken === "string" && telegramBotToken.trim()
    ? telegramBotToken.trim()
    : db.settings.telegramBotToken;
  const nextChatId = typeof telegramChatId === "string"
    ? telegramChatId.trim()
    : db.settings.telegramChatId;
  const nextEnabled = telegramEnabled !== undefined
    ? telegramEnabled
    : db.settings.telegramEnabled;

  if (nextEnabled && (!nextToken || !nextChatId)) {
    return res.status(400).json({
      success: false,
      error: "Enter a Telegram Bot Token and Chat ID before enabling notifications"
    });
  }

  db.settings.telegramBotToken = nextToken;
  db.settings.telegramChatId = nextChatId;
  db.settings.telegramEnabled = nextEnabled;
  if (telegramNotificationTypes !== undefined) {
    db.settings.telegramNotificationTypes = telegramNotificationTypes;
  }
  saveDB();
  res.json({ success: true, data: getPublicSettings() });
});

app.post('/api/settings/test-telegram', async (req, res) => {
  try {
    await sendTelegramMessage("✅ ทดสอบการแจ้งเตือนจาก Smart Aquarium สำเร็จ");
    res.json({ success: true, message: "ส่งข้อความทดสอบไปยัง Telegram สำเร็จ" });
  } catch (err) {
    console.error(`[Telegram] Test message failed: ${err.message}`);
    res.status(502).json({ success: false, error: err.message });
  }
});

// Fallback for non-API GET requests (SPA web dashboard)
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api')) {
    const publicIndexPath = path.join(__dirname, 'public', 'index.html');
    const rootIndexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(publicIndexPath)) {
      return res.sendFile(publicIndexPath);
    }
    if (fs.existsSync(rootIndexPath)) {
      return res.sendFile(rootIndexPath);
    }
  }
  next();
});

function listen(port, allowFallback = true) {
  const server = app.listen(port, () => {
    console.log(`=======================================================`);
    console.log(`🐠 Smart Aquarium Dashboard Backend is Running!`);
    console.log(`🌐 Web App URL: http://localhost:${port}`);
    console.log(`📡 ESP32 API Endpoint: http://localhost:${port}/api/readings`);
    console.log(`=======================================================`);
  });

  server.on('error', async (err) => {
    if (err.code === 'EADDRINUSE' && allowFallback) {
      const fallbackPort = port + 1;
      console.warn(`[Server] Port ${port} is occupied. Retrying with port ${fallbackPort}...`);
      listen(fallbackPort, false);
    } else {
      console.error('[Server Error]', err);
      if (mongoClient) await mongoClient.close();
      process.exitCode = 1;
    }
  });
}

if (!IS_VERCEL) {
  ensureDatabaseInitialized().then(() => listen(PORT)).catch(async (err) => {
    console.error(`[Database] Could not initialize database: ${err.message}`);
    if (mongoClient) await mongoClient.close();
    process.exitCode = 1;
  });
}

module.exports = app;
