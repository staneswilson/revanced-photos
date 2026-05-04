export const logger = {
  info: (msg: string) => {
    console.log(`[${new Date().toISOString()}] [INFO] ${msg}`);
  },
  warn: (msg: string) => {
    console.warn(`[${new Date().toISOString()}] [WARN] ${msg}`);
  },
  error: (msg: string, err?: unknown) => {
    console.error(`[${new Date().toISOString()}] [ERROR] ${msg}`);
    if (err) {
      console.error(err);
    }
  },
};
