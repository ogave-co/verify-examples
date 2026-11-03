// Runs both Actions locally with a fake Auth0 event against your sandbox:
//   BASE_URL=https://app.ogave.co API_KEY=test_xxx [APP_ID=app_xxx] node test-actions.js
// Only test_ keys are accepted here, so no real SMS is sent. The key is never printed.
const assert = require('assert/strict');
const { onExecuteCustomPhoneProvider } = require('./custom-phone-provider.js');
const { onExecuteSendPhoneMessage } = require('./send-phone-message.js');

const { BASE_URL, API_KEY, APP_ID } = process.env;
if (!BASE_URL || !API_KEY) { console.log('SKIP: set BASE_URL and API_KEY'); process.exit(0); }
if (!API_KEY.startsWith('test_')) { console.error('Use a test_ key for this script.'); process.exit(1); }

const phone = () => '+57300' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
const secrets = { API_KEY, BASE_URL, APP_ID };

(async () => {
  const notification = { recipient: phone(), code: '731904', delivery_method: 'text', message_type: 'otp_verify', locale: 'en',
    as_text: 'Your verification code is 731904', as_voice: 'Your verification code is 7 3 1 9 0 4' };
  await onExecuteCustomPhoneProvider({ secrets, notification }, {});
  console.log('ok   custom phone provider: code delivered (201)');

  await onExecuteCustomPhoneProvider({ secrets, notification }, {});
  console.log('ok   custom phone provider: same notification again is replayed, not resent (Idempotency-Key)');

  await onExecuteSendPhoneMessage({ secrets, message_options: { action: 'second-factor-authentication', code: '582017', message_type: 'sms', recipient: phone(), text: 'Your code is 582017' } }, {});
  console.log('ok   send phone message (legacy): code delivered (201)');

  await assert.rejects(onExecuteCustomPhoneProvider({ secrets, notification: { recipient: 'abc', code: '731904' } }, {}), /invalid_number/);
  console.log('ok   invalid number: the Action throws with the API error code');

  await assert.rejects(onExecuteCustomPhoneProvider({ secrets: { ...secrets, API_KEY: 'test_invalid' }, notification }, {}), /invalid_api_key/);
  console.log('ok   wrong key: the Action throws invalid_api_key');
})().catch((err) => { console.error('FAIL', err.message); process.exit(1); });
