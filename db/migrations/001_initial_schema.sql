-- Initial PostgreSQL schema for queue system with bot isolation
-- This migration sets up pgboss, bot isolation, and RLS policies

-- Enable pgboss extension for queue functionality
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create bot table for multi-bot credential support
CREATE TABLE bots (
    id SERIAL PRIMARY KEY,
    bot_id VARCHAR(100) NOT NULL UNIQUE, -- Platform bot ID (e.g., Slack bot ID)
    platform VARCHAR(50) NOT NULL, -- slack, discord, teams, etc.
    name VARCHAR(100) NOT NULL,
    token_hash VARCHAR(255), -- Hashed bot token for verification
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE(platform, bot_id)
);

-- Create users table with bot association
CREATE TABLE chat_users (
    id SERIAL PRIMARY KEY,
    bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
    platform_user_id VARCHAR(100) NOT NULL,
    platform VARCHAR(50) NOT NULL,
    github_username VARCHAR(100) NOT NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(bot_id, platform, platform_user_id)
);

-- Create conversation threads with bot isolation
CREATE TABLE conversation_threads (
    id SERIAL PRIMARY KEY,
    bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES chat_users(id) ON DELETE CASCADE,
    platform VARCHAR(50) NOT NULL,
    channel_id VARCHAR(100) NOT NULL,
    thread_id VARCHAR(100) NOT NULL,
    claude_session_id VARCHAR(255),
    created_at TIMESTAMP DEFAULT NOW(),
    last_activity TIMESTAMP DEFAULT NOW(),
    is_active BOOLEAN DEFAULT TRUE,
    UNIQUE(bot_id, platform, channel_id, thread_id)
);

-- Enable Row Level Security
ALTER TABLE bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_threads ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for bot isolation
-- Users can only see data for their specific bot
CREATE POLICY bot_isolation ON bots 
FOR ALL USING (
    bot_id = current_setting('app.current_bot_id', true)
);

CREATE POLICY user_bot_isolation ON chat_users 
FOR ALL USING (
    bot_id = (
        SELECT id FROM bots 
        WHERE bot_id = current_setting('app.current_bot_id', true)
    )
);

CREATE POLICY thread_bot_isolation ON conversation_threads 
FOR ALL USING (
    bot_id = (
        SELECT id FROM bots 
        WHERE bot_id = current_setting('app.current_bot_id', true)
    )
);

-- Create function to set bot context for RLS
CREATE OR REPLACE FUNCTION set_bot_context(bot_identifier VARCHAR(100))
RETURNS VOID AS $$
BEGIN
    PERFORM set_config('app.current_bot_id', bot_identifier, true);
END;
$$ LANGUAGE plpgsql;

-- Create function to create bot-specific user roles
CREATE OR REPLACE FUNCTION create_bot_user(
    bot_identifier VARCHAR(100),
    user_password VARCHAR(255)
) RETURNS VARCHAR(100) AS $$
DECLARE
    role_name VARCHAR(100);
BEGIN
    -- Generate safe role name from bot ID
    role_name := 'bot_' || translate(bot_identifier, '-@.', '___');
    
    -- Create role if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('CREATE ROLE %I WITH LOGIN PASSWORD %L', role_name, user_password);
        
        -- Grant necessary permissions
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', role_name);
        EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO %I', role_name);
        EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', role_name);
        
        -- Grant pgboss permissions (will be created by pgboss)
        EXECUTE format('GRANT ALL PRIVILEGES ON SCHEMA pgboss TO %I', role_name);
        EXECUTE format('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA pgboss TO %I', role_name);
        EXECUTE format('GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA pgboss TO %I', role_name);
    END IF;
    
    RETURN role_name;
END;
$$ LANGUAGE plpgsql;

-- Create indexes for performance
CREATE INDEX idx_bots_platform_bot_id ON bots(platform, bot_id);
CREATE INDEX idx_chat_users_bot_platform_user ON chat_users(bot_id, platform, platform_user_id);
CREATE INDEX idx_conversation_threads_bot_channel_thread ON conversation_threads(bot_id, platform, channel_id, thread_id);
CREATE INDEX idx_conversation_threads_active ON conversation_threads(bot_id, is_active, last_activity);
CREATE INDEX idx_conversation_threads_claude_session ON conversation_threads(claude_session_id) WHERE claude_session_id IS NOT NULL;

-- Insert default bot entry (for migration from existing system)
INSERT INTO bots (bot_id, platform, name, created_at) 
VALUES ('default-slack-bot', 'slack', 'Default Slack Bot', NOW())
ON CONFLICT (platform, bot_id) DO NOTHING;