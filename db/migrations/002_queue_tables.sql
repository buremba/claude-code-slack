-- Queue tables for pgboss with bot isolation
-- This migration creates the queue job types and additional RLS policies

-- Create queue job metadata table for tracking jobs by bot
CREATE TABLE queue_jobs (
    id SERIAL PRIMARY KEY,
    bot_id INTEGER REFERENCES bots(id) ON DELETE CASCADE,
    job_id UUID NOT NULL, -- pgboss job ID
    queue_name VARCHAR(100) NOT NULL,
    job_type VARCHAR(50) NOT NULL, -- 'direct_message', 'thread_message'
    user_id INTEGER REFERENCES chat_users(id) ON DELETE CASCADE,
    thread_id INTEGER REFERENCES conversation_threads(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT NOW(),
    completed_at TIMESTAMP,
    failed_at TIMESTAMP,
    retry_count INTEGER DEFAULT 0,
    status VARCHAR(20) DEFAULT 'pending' -- pending, active, completed, failed
);

-- Enable RLS on queue jobs
ALTER TABLE queue_jobs ENABLE ROW LEVEL SECURITY;

-- RLS policy for queue jobs (bot isolation)
CREATE POLICY queue_jobs_bot_isolation ON queue_jobs 
FOR ALL USING (
    bot_id = (
        SELECT id FROM bots 
        WHERE bot_id = current_setting('app.current_bot_id', true)
    )
);

-- Create message payload table for storing job data
CREATE TABLE job_payloads (
    id SERIAL PRIMARY KEY,
    queue_job_id INTEGER REFERENCES queue_jobs(id) ON DELETE CASCADE,
    payload JSONB NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Enable RLS on job payloads (inherits from queue_jobs)
ALTER TABLE job_payloads ENABLE ROW LEVEL SECURITY;

CREATE POLICY job_payloads_bot_isolation ON job_payloads 
FOR ALL USING (
    queue_job_id IN (
        SELECT id FROM queue_jobs 
        WHERE bot_id = (
            SELECT id FROM bots 
            WHERE bot_id = current_setting('app.current_bot_id', true)
        )
    )
);

-- Create function to enqueue jobs with bot context
CREATE OR REPLACE FUNCTION enqueue_job_with_bot(
    bot_identifier VARCHAR(100),
    p_queue_name VARCHAR(100),
    p_job_type VARCHAR(50),
    p_user_id INTEGER,
    p_thread_id INTEGER,
    p_payload JSONB
) RETURNS UUID AS $$
DECLARE
    v_bot_id INTEGER;
    v_job_id UUID;
    v_queue_job_id INTEGER;
BEGIN
    -- Get bot ID
    SELECT id INTO v_bot_id FROM bots WHERE bot_id = bot_identifier;
    
    IF v_bot_id IS NULL THEN
        RAISE EXCEPTION 'Bot not found: %', bot_identifier;
    END IF;
    
    -- Generate job ID
    v_job_id := gen_random_uuid();
    
    -- Insert queue job record
    INSERT INTO queue_jobs (bot_id, job_id, queue_name, job_type, user_id, thread_id)
    VALUES (v_bot_id, v_job_id, p_queue_name, p_job_type, p_user_id, p_thread_id)
    RETURNING id INTO v_queue_job_id;
    
    -- Insert payload
    INSERT INTO job_payloads (queue_job_id, payload)
    VALUES (v_queue_job_id, p_payload);
    
    RETURN v_job_id;
END;
$$ LANGUAGE plpgsql;

-- Create function to update job status
CREATE OR REPLACE FUNCTION update_job_status(
    p_job_id UUID,
    p_status VARCHAR(20),
    p_retry_count INTEGER DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    UPDATE queue_jobs 
    SET 
        status = p_status,
        retry_count = COALESCE(p_retry_count, retry_count),
        completed_at = CASE WHEN p_status = 'completed' THEN NOW() ELSE completed_at END,
        failed_at = CASE WHEN p_status = 'failed' THEN NOW() ELSE failed_at END
    WHERE job_id = p_job_id;
END;
$$ LANGUAGE plpgsql;

-- Create indexes for queue performance
CREATE INDEX idx_queue_jobs_bot_status ON queue_jobs(bot_id, status);
CREATE INDEX idx_queue_jobs_queue_name_status ON queue_jobs(queue_name, status);
CREATE INDEX idx_queue_jobs_user_thread ON queue_jobs(user_id, thread_id);
CREATE INDEX idx_queue_jobs_created_at ON queue_jobs(created_at);
CREATE INDEX idx_job_payloads_queue_job_id ON job_payloads(queue_job_id);

-- Create view for active jobs with payload
CREATE VIEW active_jobs_with_payload AS
SELECT 
    qj.job_id,
    qj.queue_name,
    qj.job_type,
    qj.status,
    qj.created_at,
    qj.retry_count,
    b.bot_id,
    b.platform,
    cu.platform_user_id,
    cu.github_username,
    ct.channel_id,
    ct.thread_id,
    ct.claude_session_id,
    jp.payload
FROM queue_jobs qj
JOIN bots b ON qj.bot_id = b.id
JOIN chat_users cu ON qj.user_id = cu.id
LEFT JOIN conversation_threads ct ON qj.thread_id = ct.id
JOIN job_payloads jp ON qj.id = jp.queue_job_id
WHERE qj.status IN ('pending', 'active');

-- Grant permissions to bot roles
-- This will be applied when roles are created
GRANT SELECT, INSERT, UPDATE ON queue_jobs TO PUBLIC;
GRANT SELECT, INSERT ON job_payloads TO PUBLIC;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO PUBLIC;