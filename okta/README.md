# Okta: send Okta's SMS codes through the Verify API

Okta can deliver its own one-time codes (phone enrollment, phone verification, SMS MFA) through your account with a
**Telephony Inline Hook**. No code to write or host: Okta creates and checks the code, and the Verify API delivers it
with your Verify app's sender ID, template, language and fraud protection. Each delivery appears on your Verify page
tagged `okta`.

```
Okta ──POST (phone + code)──▶  BASE_URL/v1/verify/connectors/okta?app_id=app_…  ──SMS──▶ user
     ◀── 200 SUCCESSFUL / 200 error object (Okta then uses its own provider)
```

## 1. Create a key with only the `verify` permission

1. In the portal: **Developers › API keys › Create key**.
2. Choose **limited access** and tick only **verify**. Optionally restrict it to Okta's IP ranges.
3. Use a `live_…` key for real users. A `test_…` key is handy for Okta's *Preview*: it answers like a live key but
   sends nothing, so nobody receives the code.

Store the key in Okta only (next step). Never put it in code or tickets.

## 2. Copy your Verify app id (optional)

In the portal, **Verify**: copy the id of the app to use (`app_…`). Without `?app_id=` the first active Verify app is used.

## 3. Add the inline hook in Okta

1. Okta Admin Console › **Workflow › Inline Hooks › Add Inline Hook › Telephony**.
2. **Name**: e.g. `SMS via Verify API`.
3. **URL**: `https://app.ogave.co/v1/verify/connectors/okta?app_id=app_xxx`
   (use your own BASE_URL and app id; Okta requires HTTPS).
4. **Authentication**: HTTP headers.
   - **Authentication field**: `Authorization`
   - **Authentication secret**: `Bearer live_xxx` (the word `Bearer`, a space, then your key)
5. **Save**.

## 4. Preview, then activate

1. Open the hook › **Preview** tab, pick a user with a phone number you control, **Generate request**, then **View response**.
2. A good response looks like this (`transactionId` is the verification id on your Verify page):

   ```json
   {"commands": [{"type": "com.okta.telephony.action", "value": [{"status": "SUCCESSFUL", "provider": "<platform name>",
     "transactionId": "ver_01…", "transactionMetadata": "sms"}]}]}
   ```

3. **Activate** the hook. Okta allows one active telephony hook per org; while it is active, Okta's SMS and voice
   codes go through it.

## What the hook receives and answers

Okta sends a `com.okta.telephony.provider` request (see [`sample-request.json`](sample-request.json)). The connector
uses `data.messageProfile`:

| Field | Use |
|---|---|
| `phoneNumber` | Recipient (E.164). Required. |
| `otpCode` | The code Okta made (4–10 letters or digits). Required. |
| `deliveryChannel` | `SMS`, or `Voice call` (sent as a voice call if your account has the voice channel). |
| `locale` | Language of the message when a template exists for it (`EN-US` → `en`); otherwise the app's default. |
| `otpExpires` | Expiry of the verification on our side (clamped to 60–3,600 s; default 300 s). |
| `data.context.request.ipAddress` | End user's IP, for per-IP fraud limits. |

Answers:

- **Sent**: `200` with `status: "SUCCESSFUL"` and `transactionId: "ver_…"`.
- **Could not send** (invalid or premium number, blocked country, rate limit, balance, unknown `app_id`…): `200`
  with an Okta error object, so Okta **falls back to its own provider** instead of failing the user:

  ```json
  {"error": {"errorSummary": "'abc' is not a valid phone number. Use E.164, e.g. +573001234567.",
    "errorCauses": [{"errorSummary": "invalid_number", "reason": "…", "location": "telephony-provider"}]}}
  ```

  `errorCauses[0].errorSummary` is the API error code (`invalid_number`, `validation_failed`, `velocity_number`…).
- **Missing or wrong key**: `401` (`missing_api_key` / `invalid_api_key`); **key without the `verify` permission**: `403` (`insufficient_scope`). Okta then falls back too, but fix the key.

## Test it from your terminal

With a **test** key nothing is sent. The key is read from an environment variable so it does not end up in your shell history.

```bash
export BASE_URL=https://app.ogave.co
read -rs API_KEY && export API_KEY        # paste your test_ key, then Enter

curl -s "$BASE_URL/v1/verify/connectors/okta" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  --data @sample-request.json
```

Expected: `"status":"SUCCESSFUL"` and a `ver_…` transaction id. Add `?app_id=app_xxx` to the URL to pick a Verify app.

## Notes

- Okta checks the code itself, so these verifications do not count in your Verify conversion figures or the
  approval-rate fraud detectors. Rate limits, the premium-number list and new-country protection still apply.
- Okta waits only a few seconds for the hook. Keep the URL on your platform's public HTTPS address.
- Rate limits: when a limit is hit the hook answers with an error object right away (Okta falls back). Do not add
  retries in front of the hook.
