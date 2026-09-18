const db = require('../db');
const { genOrderId } = require('../helpers');

class AppError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

// Shared purchase flow used by the web panel and the external API.
// On success: balance deducted, number marked sold, pending order created
// (the global poller picks it up instantly and starts pulling OTP).
async function purchase(userId, platform, country) {
  const platformStr = String(platform || '').trim();
  const countryStr = String(country || '').trim();
  if (!platformStr || !countryStr) throw new AppError('platform and country are required');

  const service = await db.getService(platformStr, countryStr);
  if (service && service.status !== 'enabled') throw new AppError('This service is currently disabled');

  const number = await db.allocateNumber(platformStr, countryStr);
  if (!number) throw new AppError('No numbers available for this service right now');

  const user = await db.getUserById(userId);
  const price = Number(number.price) || 0;
  if (Number(user.balance || 0) < price) {
    await db.setNumberStatus(number.id, 'available');
    throw new AppError('Insufficient balance. Please top up.', 400, { needBalance: true });
  }

  await db.addBalance(userId, -price);
  const targetApiUrl = (number.api_url || (service ? service.api_url : '') || '').trim();
  const order = await db.createOrder({
    orderId: genOrderId(),
    userId,
    numberId: number.id,
    number: number.number,
    country: number.country,
    platform: number.platform,
    price,
    apiUrl: targetApiUrl,
  });
  await db.addWalletEntry({
    userId,
    amount: -price,
    type: 'purchase',
    note: `${platformStr} / ${countryStr} — ${order.order_id}`,
  });
  return order;
}

module.exports = { purchase, AppError };