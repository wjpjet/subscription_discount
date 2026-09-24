// Serve Streamly (the testbed) locally: `npm run testbed:dev` → http://localhost:8081
// The extension's allowlist already includes localhost:8081, so a local run can target this instead
// of the hosted copy. Sign in with any email, password `walkaway`, code `424242`.
import { serveTestbed } from './lib/testbed-server.mjs';
const port = Number(process.env.PORT || 8081);
await serveTestbed(port);
console.log(`streamly (testbed) → http://localhost:${port}   scenarios: http://localhost:${port}/scenarios   trial: /settings/subscription?trial=1`);
