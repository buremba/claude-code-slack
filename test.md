2. Tunnel vs Ingress -> Ingress (if dynamic port mappingis feasible without restart)
    - Expose all the ports, map it to threadid.peerbot.ai, with conversation history)
4. Kubernetes Operator -> 
7. Persistent volume per pod - cleanup + snapshot alma


The dispatcher will need to push all the messages (direct or thread, all) into the queue called "messages". 
The orchestrator will listen the "messages" queue, 
*  if the message doesn't have thread_id it will create a dpeloyment (scaled to 1) for the thread id.
and then the consumer in orchstrator will push the message to the thread_message_[deploymentid] queue for the worker to listen.
we will have one queue for each thread, prefixed with thread_message_. 
we will remove the env INITIAL_USER_PROMPT and instead make the worker listen the queue and grab the messages one by one.