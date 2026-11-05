// Incoming SMS (Twilio-signed webhook; protected visibility checks the signature) -> claim ticket link as TwiML.
const { appFor, respond } = require(Runtime.getFunctions()['runtime'].path);
exports.handler = async (context, event, callback) => {
  const allowed = (context.EVENT_ALLOWED_SENDERS || '').split(',').filter(Boolean);
  if (event.To !== context.EVENT_TWILIO_NUMBER || (allowed.length && !allowed.includes(event.From)))
    return callback(null, respond(200, '<Response/>', 'text/xml'));
  try {
    const result = await appFor(context).functions.sms(event);
    return callback(null, respond(result.status, result.body, result.type));
  } catch (error) {
    console.error(error);
    return callback(null, respond(200, '<Response><Message>Sorry, something went wrong. Please send your URL again.</Message></Response>', 'text/xml'));
  }
};
