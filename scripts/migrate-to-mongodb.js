require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

async function migrate() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('Set MONGODB_URI in .env before running this migration');

  const dbPath = process.env.DB_FILE || path.join(__dirname, '..', 'db.json');
  if (!fs.existsSync(dbPath)) throw new Error(`State file not found: ${dbPath}`);

  const localState = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const databaseName = process.env.MONGODB_DB || 'smart_aquarium';
  const deviceId = process.env.AQUARIUM_DEVICE_ID || 'aquarium-1';
  const readings = [...(localState.readings || []), ...(localState.pendingReadings || [])]
    .filter(reading => Number.isFinite(Date.parse(reading.ts)))
    .map(reading => ({
      ...reading,
      deviceId,
      ts: new Date(reading.ts)
    }));

  delete localState.settings?.esp32ApiKey;
  localState.readings = [];
  localState.pendingReadings = [];

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const database = client.db(databaseName);
    const stateCollection = database.collection('app_state');
    const readingsCollection = database.collection('readings');
    await readingsCollection.createIndex({ deviceId: 1, ts: 1 });

    let importedReadings = 0;
    for (let offset = 0; offset < readings.length; offset += 500) {
      const batch = readings.slice(offset, offset + 500);
      const result = await readingsCollection.bulkWrite(batch.map(reading => ({
        updateOne: {
          filter: { deviceId, ts: reading.ts },
          update: { $setOnInsert: reading },
          upsert: true
        }
      })));
      importedReadings += result.upsertedCount;
    }

    if (await stateCollection.findOne({ _id: 'main' })) {
      console.log('Existing cloud application state was left unchanged.');
    } else {
      await stateCollection.insertOne({
        _id: 'main',
        revision: 1,
        data: localState
      });
      console.log('Local application state imported.');
    }
    console.log(`Imported ${importedReadings} sensor readings into "${databaseName}".`);
  } finally {
    await client.close();
  }
}

migrate().catch(err => {
  console.error(`[Migration] ${err.message}`);
  process.exitCode = 1;
});
