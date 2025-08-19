// Simple console-based logger for bundled environment

// Ensure logger methods work in bundled environment
// Use console.log directly due to winston issues in bundled environment
const logMethods = {
  error: (message: any, ...args: any[]) => {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.error(`[${timestamp}] [error] ${message}`, ...args);
  },
  warn: (message: any, ...args: any[]) => {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.warn(`[${timestamp}] [warn] ${message}`, ...args);
  },
  info: (message: any, ...args: any[]) => {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[${timestamp}] [info] ${message}`, ...args);
  },
  debug: (message: any, ...args: any[]) => {
    if (process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'DEBUG') {
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      console.log(`[${timestamp}] [debug] ${message}`, ...args);
    }
  }
};

export default logMethods;