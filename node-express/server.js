// Entry point: reads configuration from the environment (see .env.example) and starts the server.
import { createApp } from './src/app.js';
import { createVerifyClient } from './src/verify-client.js';

const { BASE_URL, API_KEY, SESSION_SECRET, PORT = '3000', RESEND_COOLDOWN = '30', SECURE_COOKIES, TRUST_PROXY } = process.env;
for (const [name, value] of Object.entries({ BASE_URL, API_KEY, SESSION_SECRET })) {
  if (!value) { console.error(`Missing ${name}. Copy .env.example to .env and fill it in.`); process.exit(1); }
}

const app = createApp({
  verify: createVerifyClient({ baseUrl: BASE_URL, apiKey: API_KEY }),
  sessionSecret: SESSION_SECRET,
  resendCooldown: Number(RESEND_COOLDOWN) || 30,
  secureCookies: SECURE_COOKIES === 'true',
  trustProxy: TRUST_PROXY === 'true',
});

app.listen(Number(PORT), () => {
  // Print the mode only, never the key itself.
  const mode = API_KEY.startsWith('test_') ? 'test key: no SMS is sent, the code is 123456' : 'live key: real SMS';
  console.log(`Listening on http://localhost:${PORT} (${mode})`);
});
