CREATE TABLE IF NOT EXISTS conversations(
id SERIAL PRIMARY KEY,
type VARCHAR(20) DEFAULT 'private',
created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS messages(
id SERIAL PRIMARY KEY,
conversation_id INT REFERENCES conversations(id),
sender_id INT,
text TEXT,
status VARCHAR(20) DEFAULT 'sent',
created_at TIMESTAMP DEFAULT NOW()
);
