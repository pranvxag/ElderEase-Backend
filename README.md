If Twilio quota is reached, create a new Twilio account and update only the environment variables in Render. No code changes required.
Go to Render → Your Service → Environment and update:
TWILIO_ACCOUNT_SID=new_sid
TWILIO_AUTH_TOKEN=new_token
TWILIO_PHONE_NUMBER=new_phone_number
Then verify phone numbers in the new Twilio Console under Phone Numbers → Verified Caller IDs.