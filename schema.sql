-- User table (optional fields included, but login only uses username/password hash)
-- We won't fully implement user creation/login in this example for brevity
/*
CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL, -- MUST be securely hashed in a real app!
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    address TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
*/

-- Chat History Table
CREATE TABLE IF NOT EXISTS chat_history (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL, -- Will store user_id or an anonymous session cookie value
    role TEXT NOT NULL CHECK(role IN ('user', 'bot')), -- 'user' or 'bot'
    content TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for faster history retrieval
CREATE INDEX IF NOT EXISTS idx_chat_history_session_timestamp ON chat_history (session_id, timestamp);