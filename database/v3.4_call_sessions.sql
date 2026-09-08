CREATE TABLE call_sessions (
 id SERIAL PRIMARY KEY,
 call_id INTEGER,
 user_id INTEGER,
 device_id TEXT,
 status VARCHAR(30),
 quality JSONB,
 joined_at TIMESTAMP DEFAULT NOW(),
 left_at TIMESTAMP
);
