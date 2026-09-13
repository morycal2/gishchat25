// Zento service-controls repair utility.
// Enables all user-facing services. Use when an older deployment/database was
// left with messages/stories/etc. disabled and normal users receive HTTP 503.
// Usage: npm run repair:services
require('dotenv').config();
const { Client } = require('pg');

(async()=>{
  const url=process.env.DATABASE_URL||process.env.POSTGRES_URL||process.env.DATABASE_URL;
  if(!url){console.error('DATABASE_URL is not configured.');process.exit(1);}
  const client=new Client({connectionString:url,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:undefined});
  try{
    await client.connect();
    await client.query(`CREATE TABLE IF NOT EXISTS site_controls(
      id INTEGER PRIMARY KEY DEFAULT 1,
      global_enabled BOOLEAN NOT NULL DEFAULT true,
      messages_enabled BOOLEAN NOT NULL DEFAULT true,
      calls_enabled BOOLEAN NOT NULL DEFAULT true,
      stories_enabled BOOLEAN NOT NULL DEFAULT true,
      bots_enabled BOOLEAN NOT NULL DEFAULT true,
      support_enabled BOOLEAN NOT NULL DEFAULT true,
      groups_enabled BOOLEAN NOT NULL DEFAULT true,
      channels_enabled BOOLEAN NOT NULL DEFAULT true,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    await client.query(`INSERT INTO site_controls(id) VALUES(1) ON CONFLICT(id) DO NOTHING`);
    await client.query(`UPDATE site_controls SET
      global_enabled=true,messages_enabled=true,calls_enabled=true,
      stories_enabled=true,bots_enabled=true,support_enabled=true,
      groups_enabled=true,channels_enabled=true,updated_at=now()
      WHERE id=1`);
    console.log('Zento service controls repaired: all services are ENABLED.');
  }catch(e){console.error('Repair failed:',e.message);process.exitCode=1}
  finally{await client.end().catch(()=>{})}
})();
