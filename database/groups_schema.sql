CREATE TABLE groups (
 id SERIAL PRIMARY KEY,
 name VARCHAR(100) NOT NULL,
 description TEXT,
 owner_id INTEGER,
 created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE group_members (
 id SERIAL PRIMARY KEY,
 group_id INTEGER,
 user_id INTEGER,
 role VARCHAR(20) DEFAULT 'member',
 created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE channels (
 id SERIAL PRIMARY KEY,
 name VARCHAR(100),
 type VARCHAR(20) DEFAULT 'public',
 owner_id INTEGER,
 created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE channel_posts (
 id SERIAL PRIMARY KEY,
 channel_id INTEGER,
 author_id INTEGER,
 content TEXT,
 created_at TIMESTAMP DEFAULT NOW()
);
