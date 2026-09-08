CREATE TABLE call_rooms (
 id SERIAL PRIMARY KEY,
 room_id VARCHAR(100),
 created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE participants (
 id SERIAL PRIMARY KEY,
 room_id INTEGER,
 user_id INTEGER,
 joined_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE recordings (
 id SERIAL PRIMARY KEY,
 call_id INTEGER,
 url TEXT,
 duration INTEGER,
 created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE devices (
 id SERIAL PRIMARY KEY,
 user_id INTEGER,
 device_token TEXT,
 last_seen TIMESTAMP DEFAULT NOW()
);

CREATE TABLE notifications (
 id SERIAL PRIMARY KEY,
 user_id INTEGER,
 type VARCHAR(50),
 payload JSONB,
 created_at TIMESTAMP DEFAULT NOW()
);
