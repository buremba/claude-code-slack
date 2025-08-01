import type { App, ExpressReceiver } from '@slack/bolt';

export function setupHttpServer(app: App, port: number) {
  // Get the Express receiver from Bolt
  const receiver = app.receiver as ExpressReceiver;
  
  if (!receiver || !receiver.router) {
    console.error('Unable to set up HTTP endpoints: ExpressReceiver not found');
    return;
  }
  
  const expressApp = receiver.router;
  
  // Add health check endpoint
  expressApp.get('/health', (req: any, res: any) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  
  // Add readiness check
  expressApp.get('/ready', (req: any, res: any) => {
    res.status(200).json({ ready: true });
  });
  
  console.log(`HTTP endpoints configured:`);
  console.log(`- Health check: GET /health`);
  console.log(`- Readiness: GET /ready`);
  console.log(`- Slack events: POST /slack/events (handled by Bolt)`);
}