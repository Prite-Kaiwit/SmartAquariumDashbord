require('dotenv').config();
const dns = require('dns');
const { MongoClient } = require('mongodb');

// Fix common Windows Node.js querySrv ECONNREFUSED issue by using public DNS
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (e) {
  console.warn('Could not set custom DNS servers:', e.message);
}

async function testConnection() {
  console.log('--- MongoDB Connection Test ---');
  const rawUri = process.env.MONGODB_URI;

  if (!rawUri) {
    console.error('❌ MONGODB_URI is not defined in .env');
    process.exit(1);
  }

  // Mask credentials for display
  const maskedUri = rawUri.replace(/:([^@]+)@/, ':****@');
  console.log(`Connecting to: ${maskedUri}`);

  const client = new MongoClient(rawUri, { serverSelectionTimeoutMS: 10000 });
  const startTime = Date.now();

  try {
    await client.connect();
    const duration = Date.now() - startTime;
    console.log(`✅ Connection successful! (took ${duration} ms)`);

    const dbName = process.env.MONGODB_DB || 'smart_aquarium';
    const db = client.db(dbName);

    console.log(`\nTesting database: "${dbName}"`);
    const pingResult = await db.command({ ping: 1 });
    console.log(`✅ Ping OK:`, pingResult);

    const collections = await db.listCollections().toArray();
    console.log(`\nExisting Collections (${collections.length}):`);
    if (collections.length === 0) {
      console.log('  (no collections yet)');
    } else {
      for (const col of collections) {
        const count = await db.collection(col.name).countDocuments();
        console.log(`  - ${col.name}: ${count} document(s)`);
      }
    }

    await client.close();
    console.log('\n✅ Connection closed successfully.');
    process.exit(0);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`\n❌ Connection failed after ${duration} ms!`);
    console.error(`Error name: ${error.name}`);
    console.error(`Error message: ${error.message}`);
    if (error.reason) {
      console.error('Topology Description:', JSON.stringify(error.reason, null, 2));
    }
    process.exit(1);
  }
}

testConnection();
