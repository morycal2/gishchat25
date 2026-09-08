CREATE TABLE calls (
 id SERIAL PRIMARY KEY,
 caller_id INTEGER,
 receiver_id INTEGER,
 type VARCHAR(30),
 status VARCHAR(30),
 duration INTEGER DEFAULT 0,
 created_at TIMESTAMP DEFAULT NOW()
);
