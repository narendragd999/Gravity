import { loadUniversalConfig } from './universal-service.mjs';

const args = process.argv.slice(2);
const usage = 'Usage: node electron/standalone.mjs --config gateway.config.json\nOptional bridge profiles: universal-web2api.config.example.json\nSet GATEWAY_TOKEN and all referenced credential environment variables.';
if (args.length === 1 && ['--help', '-h'].includes(args[0])) console.log(usage);
else if (args.length !== 2 || args[0] !== '--config' || !args[1] || args[1].startsWith('--')) {
  console.error(usage); process.exitCode = 1;
} else {
  let service, stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await service?.stop(); process.exitCode = 0; }
    catch (error) { console.error(`Could not stop service: ${service ? service.redact(error.message) : 'cleanup failed'}`); process.exitCode = 1; }
  };
  try {
    service = await loadUniversalConfig(args[1]);
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const status = await service.start();
    if (!stopping) console.log(`Gravity API: ${status.gateway.url}\n${status.providers.length} providers, ${status.bridges.length} bridge profiles. Clients use the configured gateway token.\nPress Ctrl+C to stop all processes started by this service.`);
  } catch (error) {
    if (!stopping) { console.error(`Cannot start service: ${service ? service.redact(error.message) : error.message}`); process.exitCode = 1; }
    if (service) {
      try { await service.stop(); } catch (cleanupError) { console.error(`Cleanup failed: ${service.redact(cleanupError.message)}`); process.exitCode = 1; }
    }
  }
}
