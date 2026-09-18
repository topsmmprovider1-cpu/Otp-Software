const config = require('./src/config');
const { init } = require('./src/app');
const poller = require('./src/services/poller');

let server = null;

async function bootstrap() {
  try {
    const app = await init();
    server = app.listen(config.port, () => {
      console.log(`══════════════════════════════════════════════`);
      console.log(`  OTP Software Production Server`);
      console.log(`  ➜ Mode      : ${process.env.NODE_ENV || 'production'}`);
      console.log(`  ➜ Database  : ${config.dbMode}`);
      console.log(`  ➜ Port      : ${config.port}`);
      console.log(`  ➜ User Site : http://localhost:${config.port}`);
      console.log(`  ➜ Admin     : http://localhost:${config.port}/admin-login`);
      console.log(`══════════════════════════════════════════════`);
    });

    // Start real-time background OTP polling engine
    poller.start();

  } catch (err) {
    console.error('Fatal startup failure:', err);
    process.exit(1);
  }
}

function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  poller.stop();
  if (server) {
    server.close(() => {
      console.log('HTTP server closed. Exiting process.');
      process.exit(0);
    });
    setTimeout(() => {
      console.warn('Forcing process exit after timeout.');
      process.exit(1);
    }, 10000);
  } else {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error('[Unhandled Rejection]', reason);
});

bootstrap();