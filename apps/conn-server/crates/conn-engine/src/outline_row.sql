json_object(
    'id', id, 'threadId', thread_id, 'type', body ->> '$.type',
    'runId', body ->> '$.runId', 'nodeId', body ->> '$.nodeId',
    'status', body ->> '$.status', 'createdBy', body ->> '$.createdBy',
    'inputIntent', body ->> '$.inputIntent',
    'text', CASE WHEN body ->> '$.type' IN ('user_message','assistant_message')
                 THEN substr(trim(body ->> '$.text', char(9,10,13,32)), 1, 256) END,
    'hiddenPreparation', CASE WHEN body ->> '$.type' = 'command_execution'
        THEN body ->> '$.input' = 'Preparing workspace' AND body ->> '$.deferredWork' IS NULL END,
    'commandFailed', CASE WHEN body ->> '$.type' = 'command_execution'
        THEN body ->> '$.outputIndicatesFailure' OR body ->> '$.exitCode' != 0 END,
    'bytes', length(CAST(body AS BLOB))
)
