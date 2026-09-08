CREATE TABLE media_files (
 id SERIAL PRIMARY KEY,
 user_id INTEGER,
 message_id INTEGER,
 type VARCHAR(20),
 url TEXT,
 size BIGINT,
 created_at TIMESTAMP DEFAULT NOW()
);
